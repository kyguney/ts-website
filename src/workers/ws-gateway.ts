// ---------------------------------------------------------------------------
// Standalone client WebSocket Gateway (Phase 4).
//
// A dedicated, lightweight Node process — independent of the Next.js server —
// that holds the many long-lived browser WebSocket connections we cannot keep
// inside serverless/SSR handlers.
//
//   • Listens on PORT (default 3001).
//   • Verifies the NextAuth session JWT (NEXTAUTH_SECRET) to resolve userId,
//     falling back to an ANONYMOUS / FREE identity when absent/invalid.
//   • Resolves plan (FREE | PRO | ULTIMATE) from the DB (Freemius entitlements).
//   • Subscribes ONCE to Redis Pub/Sub (a single multiplexer) for:
//       market:tick:*        (pattern) live candle ticks
//       market:candle:closed           finalized candles
//       market:ai:analysis             Pro AI signals
//       market:signal                  detected signals (routed by tier)
//     and polls the analysis:broadcast:free:15m KEY for the Free broadcast.
//   • Fans out to the set of connections subscribed to each client channel.
//   • 30s ping/pong heartbeat terminates zombie connections.
//
// Run: `tsx src/workers/ws-gateway.ts`  (see package.json `ws-gateway` script).
// ---------------------------------------------------------------------------

import { createServer, type IncomingMessage } from "node:http";
import { URL } from "node:url";

import Redis from "ioredis";
import { WebSocketServer, WebSocket } from "ws";
import { decode } from "next-auth/jwt";

import { getUserPlan } from "@/lib/user-entitlement";
import {
  CANDLE_CLOSED_CHANNEL,
  SIGNAL_CHANNEL,
  SCAN_STATUS_CHANNEL as REDIS_SCAN_STATUS_CHANNEL,
} from "@/lib/market/redis-pipeline";
import { AI_ANALYSIS_CHANNEL, FREE_BROADCAST_KEY } from "@/lib/ai/store";
import {
  allowedIntervalsForPlan,
  authorizeChannel,
  candlesChannel,
  tickerChannel,
  PUBLIC_SIGNALS_CHANNEL,
  AI_SIGNALS_CHANNEL,
  SCAN_STATUS_CHANNEL,
  type ClientMessage,
  type Plan,
  type ServerMessage,
  type CandleClosedMessage,
} from "@/lib/ws/protocol";
import type { MarketTick, ScanStatus } from "@/lib/market/redis-pipeline";
import type { MarketSignal } from "@/lib/market/types";
import type { StoredAnalysis, FreeBroadcastPayload } from "@/lib/ai/store";

// --- Tunables ---------------------------------------------------------------
const PORT = Number(process.env.WS_GATEWAY_PORT ?? process.env.PORT ?? 3001);
const HEARTBEAT_INTERVAL_MS = 30_000; // ping every 30s; terminate on miss.
const FREE_BROADCAST_POLL_MS = 15_000; // re-read the shared Free broadcast key.
const MAX_CHANNELS_PER_CONN = 200; // guard against abusive subscription sets.

const NEXTAUTH_SECRET =
  process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? "";
const REDIS_URL = process.env.REDIS_URL;

// NextAuth v5 cookie names (secure prefix on https). `decode` needs the salt,
// which is the cookie name the token was issued under.
const COOKIE_SALTS = ["authjs.session-token", "__Secure-authjs.session-token"];

// --- Per-connection state ----------------------------------------------------
interface ClientState {
  ws: WebSocket;
  userId: string | null;
  plan: Plan;
  /** Client-facing channels this socket is subscribed to. */
  channels: Set<string>;
  isAlive: boolean;
}

const clients = new Set<ClientState>();

/**
 * Reverse index: client-facing channel → set of connections. This is the
 * fan-out multiplexer; a single Redis message is dispatched to exactly the
 * connections that asked for it. Cleaned up on unsubscribe/disconnect.
 */
const channelSubscribers = new Map<string, Set<ClientState>>();

function log(msg: string): void {
  console.log(`[ws-gateway] ${new Date().toISOString()} ${msg}`);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function send(ws: WebSocket, payload: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function addSubscriber(channel: string, client: ClientState): void {
  let set = channelSubscribers.get(channel);
  if (!set) {
    set = new Set();
    channelSubscribers.set(channel, set);
  }
  set.add(client);
  client.channels.add(channel);
}

function removeSubscriber(channel: string, client: ClientState): void {
  client.channels.delete(channel);
  const set = channelSubscribers.get(channel);
  if (!set) return;
  set.delete(client);
  if (set.size === 0) channelSubscribers.delete(channel);
}

function cleanupClient(client: ClientState): void {
  for (const channel of client.channels) {
    const set = channelSubscribers.get(channel);
    if (set) {
      set.delete(client);
      if (set.size === 0) channelSubscribers.delete(channel);
    }
  }
  client.channels.clear();
  clients.delete(client);
}

/** Fan a server message out to every connection subscribed to `channel`. */
function fanOut(channel: string, payload: ServerMessage): void {
  const set = channelSubscribers.get(channel);
  if (!set || set.size === 0) return;
  const encoded = JSON.stringify(payload);
  for (const client of set) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(encoded);
    }
  }
}

// --- Auth handshake ----------------------------------------------------------

/** Extracts the session token from the query string or Authorization header. */
function extractToken(req: IncomingMessage): string | null {
  try {
    const url = new URL(req.url ?? "", "http://localhost");
    const qToken = url.searchParams.get("token");
    if (qToken) return qToken;
  } catch {
    // ignore malformed URL
  }
  const authHeader = req.headers["authorization"];
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }
  return null;
}

/**
 * Verifies the NextAuth JWT and resolves { userId, plan }. Any failure (no
 * token, invalid signature, expired) degrades to an anonymous FREE identity —
 * connections are always accepted, just with the least-privileged plan.
 */
async function resolveIdentity(
  req: IncomingMessage,
): Promise<{ userId: string | null; plan: Plan }> {
  const token = extractToken(req);
  if (!token || !NEXTAUTH_SECRET) {
    return { userId: null, plan: "free" };
  }

  for (const salt of COOKIE_SALTS) {
    try {
      const decoded = await decode({
        token,
        secret: NEXTAUTH_SECRET,
        salt,
      });
      const userId = (decoded?.id as string | undefined) ?? decoded?.sub ?? null;
      if (userId) {
        let plan: Plan = "free";
        try {
          plan = await getUserPlan(userId);
        } catch (e) {
          log(`Plan lookup failed for ${userId}: ${errMsg(e)} — defaulting free.`);
        }
        return { userId, plan };
      }
    } catch {
      // Try the next salt; fall through to anonymous if all fail.
    }
  }
  return { userId: null, plan: "free" };
}

// --- Subscription handling ---------------------------------------------------

function handleSubscribe(client: ClientState, channels: string[]): void {
  const accepted: string[] = [];
  const rejected: string[] = [];

  for (const channel of channels) {
    if (client.channels.size >= MAX_CHANNELS_PER_CONN) break;
    const result = authorizeChannel(client.plan, channel);
    if (result.ok) {
      addSubscriber(channel, client);
      accepted.push(channel);
    } else {
      rejected.push(channel);
      send(client.ws, {
        type: "error",
        error: result.error ?? "INVALID_CHANNEL",
        message:
          result.error === "UPGRADE_REQUIRED"
            ? "Upgrade to Pro to access this channel."
            : "Unknown or unsupported channel.",
        channels: [channel],
      });
    }
  }

  if (accepted.length) {
    send(client.ws, { type: "subscribed", channels: accepted });
  }
}

function handleUnsubscribe(client: ClientState, channels: string[]): void {
  for (const channel of channels) removeSubscriber(channel, client);
  send(client.ws, { type: "unsubscribed", channels });
}

function handleClientMessage(client: ClientState, raw: string): void {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw) as ClientMessage;
  } catch {
    send(client.ws, { type: "error", error: "BAD_MESSAGE", message: "Invalid JSON." });
    return;
  }

  switch (msg.action) {
    case "subscribe":
      if (Array.isArray(msg.channels)) handleSubscribe(client, msg.channels);
      break;
    case "unsubscribe":
      if (Array.isArray(msg.channels)) handleUnsubscribe(client, msg.channels);
      break;
    case "ping":
      send(client.ws, { type: "pong" });
      break;
    default:
      send(client.ws, { type: "error", error: "UNKNOWN_ACTION" });
  }
}

// --- Redis → client routing --------------------------------------------------

/**
 * Routes an incoming Redis message to the appropriate client-facing channel(s).
 * The mapping mirrors `@/lib/ws/protocol` channel names.
 */
function routeRedisMessage(redisChannel: string, message: string): void {
  // Live ticks: market:tick:{SYMBOL}:{INTERVAL} → ticker:{SYMBOL}:{INTERVAL}
  if (redisChannel.startsWith("market:tick:")) {
    let tick: MarketTick;
    try {
      tick = JSON.parse(message) as MarketTick;
    } catch {
      return;
    }
    const clientChannel = tickerChannel(tick.symbol, tick.interval);
    fanOut(clientChannel, { type: "tick", channel: clientChannel, data: tick });
    return;
  }

  switch (redisChannel) {
    case CANDLE_CLOSED_CHANNEL: {
      let parsed: CandleClosedMessage["data"];
      try {
        parsed = JSON.parse(message) as CandleClosedMessage["data"];
      } catch {
        return;
      }
      const clientChannel = candlesChannel(parsed.symbol, parsed.interval);
      fanOut(clientChannel, {
        type: "candle_closed",
        channel: clientChannel,
        data: parsed,
      });
      return;
    }

    case AI_ANALYSIS_CHANNEL: {
      let analysis: StoredAnalysis;
      try {
        analysis = JSON.parse(message) as StoredAnalysis;
      } catch {
        return;
      }
      // Pro live AI stream.
      fanOut(AI_SIGNALS_CHANNEL, {
        type: "ai",
        channel: AI_SIGNALS_CHANNEL,
        data: analysis,
      });
      return;
    }

    case SIGNAL_CHANNEL: {
      let signal: MarketSignal;
      try {
        signal = JSON.parse(message) as MarketSignal;
      } catch {
        return;
      }
      // 15m detected signals feed the public free channel; all signals also
      // reach Pro subscribers on the per-symbol ticker/candles fan-out already.
      if (signal.interval === "15m") {
        fanOut(PUBLIC_SIGNALS_CHANNEL, {
          type: "signal",
          channel: PUBLIC_SIGNALS_CHANNEL,
          data: signal,
        });
      }
      return;
    }

    case REDIS_SCAN_STATUS_CHANNEL: {
      let status: ScanStatus;
      try {
        status = JSON.parse(message) as ScanStatus;
      } catch {
        return;
      }
      fanOut(SCAN_STATUS_CHANNEL, {
        type: "scan_status",
        channel: SCAN_STATUS_CHANNEL,
        data: status,
      });
      return;
    }
  }
}

// --- Free broadcast polling --------------------------------------------------
// The Free broadcast is a Redis KEY (not a channel); the worker's elected cycle
// leader regenerates it once per 15m window. We poll it and push updates to the
// public `signals:free` channel whenever the payload changes.

let lastBroadcastAt = 0;

async function pollFreeBroadcast(reader: Redis): Promise<void> {
  try {
    const raw = await reader.get(FREE_BROADCAST_KEY);
    if (!raw) return;
    const payload = JSON.parse(raw) as FreeBroadcastPayload;
    if (payload.generatedAt && payload.generatedAt !== lastBroadcastAt) {
      lastBroadcastAt = payload.generatedAt;
      fanOut(PUBLIC_SIGNALS_CHANNEL, {
        type: "free_broadcast",
        channel: PUBLIC_SIGNALS_CHANNEL,
        data: payload,
      });
    }
  } catch (e) {
    log(`Free broadcast poll error: ${errMsg(e)}`);
  }
}

// --- Bootstrap ---------------------------------------------------------------

async function main(): Promise<void> {
  if (!REDIS_URL) {
    log("FATAL: REDIS_URL is not set. The gateway cannot fan out without Redis.");
    process.exit(1);
  }
  if (!NEXTAUTH_SECRET) {
    log("WARNING: NEXTAUTH_SECRET is unset — all clients will connect as FREE.");
  }

  // Dedicated subscriber connection (a subscribed ioredis client cannot run
  // normal commands) + a separate reader for polling the Free broadcast key.
  const subscriber = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  const reader = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });

  subscriber.on("error", (e) => log(`Redis subscriber error: ${e.message}`));
  reader.on("error", (e) => log(`Redis reader error: ${e.message}`));

  // Pattern-subscribe to all per-symbol tick channels, plus the fixed channels.
  await subscriber.psubscribe("market:tick:*");
  await subscriber.subscribe(
    CANDLE_CLOSED_CHANNEL,
    AI_ANALYSIS_CHANNEL,
    SIGNAL_CHANNEL,
    REDIS_SCAN_STATUS_CHANNEL,
  );

  subscriber.on("pmessage", (_pattern, channel, message) => {
    routeRedisMessage(channel, message);
  });
  subscriber.on("message", (channel, message) => {
    routeRedisMessage(channel, message);
  });

  log(
    `Subscribed to Redis: market:tick:* (pattern), ${CANDLE_CLOSED_CHANNEL}, ${AI_ANALYSIS_CHANNEL}, ${SIGNAL_CHANNEL}, ${REDIS_SCAN_STATUS_CHANNEL}`,
  );

  // Free broadcast polling.
  setInterval(() => void pollFreeBroadcast(reader), FREE_BROADCAST_POLL_MS);
  void pollFreeBroadcast(reader);

  // HTTP server so we can share a port / expose a health endpoint, then attach
  // the WS server (supports being routed behind a reverse proxy at `/ws`).
  const httpServer = createServer((req, res) => {
    if (req.url && req.url.startsWith("/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          connections: clients.size,
          channels: channelSubscribers.size,
        }),
      );
      return;
    }
    res.writeHead(426, { "content-type": "text/plain" });
    res.end("Upgrade Required");
  });

  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", async (ws, req) => {
    const { userId, plan } = await resolveIdentity(req);

    const client: ClientState = {
      ws,
      userId,
      plan,
      channels: new Set(),
      isAlive: true,
    };
    clients.add(client);

    log(
      `Connection established (user=${userId ?? "anonymous"} plan=${plan}). Active=${clients.size}`,
    );

    send(ws, {
      type: "welcome",
      plan,
      userId,
      allowedIntervals: allowedIntervalsForPlan(plan),
    });

    // Every connection gets the public scan-status heartbeat automatically.
    addSubscriber(SCAN_STATUS_CHANNEL, client);

    ws.on("message", (data) => {
      handleClientMessage(client, data.toString());
    });

    ws.on("pong", () => {
      client.isAlive = true;
    });

    ws.on("close", () => {
      cleanupClient(client);
      log(`Connection closed (user=${userId ?? "anonymous"}). Active=${clients.size}`);
    });

    ws.on("error", (e) => {
      log(`Socket error (user=${userId ?? "anonymous"}): ${errMsg(e)}`);
    });
  });

  // Heartbeat: terminate any connection that didn't pong since the last sweep.
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.isAlive) {
        client.ws.terminate();
        cleanupClient(client);
        continue;
      }
      client.isAlive = false;
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.ping();
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  wss.on("close", () => clearInterval(heartbeat));

  httpServer.listen(PORT, () => {
    log(`WebSocket gateway listening on :${PORT} (path: / or behind proxy /ws)`);
  });

  // Graceful shutdown.
  const shutdown = () => {
    log("Shutting down…");
    clearInterval(heartbeat);
    for (const client of clients) client.ws.close(1001, "Server shutting down");
    wss.close();
    httpServer.close();
    void subscriber.quit();
    void reader.quit();
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((e) => {
  log(`FATAL: ${errMsg(e)}`);
  process.exit(1);
});
