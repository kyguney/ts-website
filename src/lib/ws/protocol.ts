// ---------------------------------------------------------------------------
// Shared WebSocket protocol between the standalone gateway (workers/ws-gateway)
// and the browser client hook (hooks/useMarketSocket). Kept framework-free so
// it can be imported from both the Node process and the React client.
// ---------------------------------------------------------------------------

import type { Interval } from "@/lib/market/types";

export type Plan = "free" | "pro" | "ultimate";

/**
 * WS-visible interval set. Ultimate adds the 1m cadence on top of the engine's
 * base intervals. Kept as a local widening so this module type-checks whether or
 * not `Interval` already carries "1m" (added to the engine set in a later task);
 * once "1m" is part of `Interval`, this collapses to `Interval`.
 */
export type WsInterval = Interval | "1m";

/** Ultimate-only fastest cadence. */
export const ULTIMATE_INTERVAL: WsInterval = "1m";

/** Intervals a Free user is allowed to consume live. Only 15m. */
export const FREE_INTERVAL: Interval = "15m";

/** Public channel every connection (incl. anonymous) may subscribe to. */
export const PUBLIC_SIGNALS_CHANNEL = "signals:free";

/** Pro-only live AI analysis fan-out channel (client-facing name). */
export const AI_SIGNALS_CHANNEL = "signals";

/** Public live scan-status channel (both tiers) — powers the "Scanning…" UI. */
export const SCAN_STATUS_CHANNEL = "scan:status";

// --- Client → Server messages ------------------------------------------------

export interface SubscribeMessage {
  action: "subscribe";
  channels: string[];
}

export interface UnsubscribeMessage {
  action: "unsubscribe";
  channels: string[];
}

export interface PingMessage {
  action: "ping";
}

export type ClientMessage = SubscribeMessage | UnsubscribeMessage | PingMessage;

// --- Server → Client messages ------------------------------------------------

export interface WelcomeMessage {
  type: "welcome";
  plan: Plan;
  userId: string | null;
  /** Channels the connection is allowed to subscribe to given its plan. */
  allowedIntervals: WsInterval[];
}

export interface SubscribedMessage {
  type: "subscribed";
  channels: string[];
}

export interface UnsubscribedMessage {
  type: "unsubscribed";
  channels: string[];
}

export interface TickMessage {
  type: "tick";
  channel: string;
  data: import("@/lib/market/redis-pipeline").MarketTick;
}

export interface SignalMessage {
  type: "signal";
  channel: string;
  data: import("@/lib/market/types").MarketSignal;
}

export interface AiAnalysisMessage {
  type: "ai";
  channel: string;
  data: import("@/lib/ai/store").StoredAnalysis;
}

export interface CandleClosedMessage {
  type: "candle_closed";
  channel: string;
  data: {
    symbol: string;
    interval: Interval;
    kline: import("@/lib/market/types").Kline;
  };
}

export interface FreeBroadcastMessage {
  type: "free_broadcast";
  channel: string;
  data: import("@/lib/ai/store").FreeBroadcastPayload;
}

export interface ScanStatusMessage {
  type: "scan_status";
  channel: string;
  data: import("@/lib/market/redis-pipeline").ScanStatus;
}

export interface ErrorMessage {
  type: "error";
  /** Machine-readable code the UI switches on (e.g. UPGRADE_REQUIRED). */
  error: string;
  message?: string;
  /** The channel(s) that triggered the error, when applicable. */
  channels?: string[];
}

export interface PongMessage {
  type: "pong";
}

export type ServerMessage =
  | WelcomeMessage
  | SubscribedMessage
  | UnsubscribedMessage
  | TickMessage
  | SignalMessage
  | AiAnalysisMessage
  | CandleClosedMessage
  | FreeBroadcastMessage
  | ScanStatusMessage
  | ErrorMessage
  | PongMessage;

// --- Channel naming & parsing ------------------------------------------------

/**
 * Client-facing channel names:
 *   ticker:{SYMBOL}:{INTERVAL}   live candle ticks
 *   candles:{SYMBOL}:{INTERVAL}  closed candles
 *   signals                      Pro live AI analysis (market:ai:analysis)
 *   signals:free                 public free broadcast + free 15m signals
 */
export function tickerChannel(symbol: string, interval: Interval): string {
  return `ticker:${symbol.toUpperCase()}:${interval}`;
}

export function candlesChannel(symbol: string, interval: Interval): string {
  return `candles:${symbol.toUpperCase()}:${interval}`;
}

export interface ParsedChannel {
  kind:
    | "ticker"
    | "candles"
    | "signals"
    | "signals:free"
    | "scan:status"
    | "unknown";
  symbol?: string;
  interval?: WsInterval;
}

const SUPPORTED_INTERVALS = new Set<string>(["1m", "5m", "15m", "30m", "1h"]);

/** Parses a client-facing channel string into a structured descriptor. */
export function parseChannel(channel: string): ParsedChannel {
  if (channel === AI_SIGNALS_CHANNEL) return { kind: "signals" };
  if (channel === PUBLIC_SIGNALS_CHANNEL) return { kind: "signals:free" };
  if (channel === SCAN_STATUS_CHANNEL) return { kind: "scan:status" };

  const parts = channel.split(":");
  if (parts.length === 3 && (parts[0] === "ticker" || parts[0] === "candles")) {
    const [prefix, symbol, interval] = parts;
    if (SUPPORTED_INTERVALS.has(interval)) {
      return {
        kind: prefix as "ticker" | "candles",
        symbol: symbol.toUpperCase(),
        interval: interval as WsInterval,
      };
    }
  }
  return { kind: "unknown" };
}

// --- Authorization -----------------------------------------------------------

export interface AuthorizeResult {
  ok: boolean;
  /** Populated when ok=false. */
  error?: "UPGRADE_REQUIRED" | "INVALID_CHANNEL";
}

/**
 * Central plan-based channel authorization. This is the single source of truth
 * for tier gating and is used by the gateway on every subscribe.
 *
 *   FREE:     only 15m ticker/candle channels + the public `signals:free` channel.
 *   PRO:      5m/15m/30m/1h ticker/candle channels, live AI `signals`.
 *   ULTIMATE: everything Pro can, plus the 1m cadence.
 */
export function authorizeChannel(plan: Plan, channel: string): AuthorizeResult {
  const parsed = parseChannel(channel);

  switch (parsed.kind) {
    case "unknown":
      return { ok: false, error: "INVALID_CHANNEL" };

    case "signals:free":
    case "scan:status":
      return { ok: true }; // public — all tiers

    case "signals":
      // Live AI analysis stream — Pro and Ultimate.
      return plan === "pro" || plan === "ultimate"
        ? { ok: true }
        : { ok: false, error: "UPGRADE_REQUIRED" };

    case "ticker":
    case "candles":
      return allowedIntervalsForPlan(plan).includes(parsed.interval as WsInterval)
        ? { ok: true }
        : { ok: false, error: "UPGRADE_REQUIRED" };

    default:
      return { ok: false, error: "INVALID_CHANNEL" };
  }
}

/** Intervals the given plan may subscribe to (drives the welcome payload). */
export function allowedIntervalsForPlan(plan: Plan): WsInterval[] {
  switch (plan) {
    case "ultimate":
      return [ULTIMATE_INTERVAL, "5m", "15m", "30m", "1h"];
    case "pro":
      return ["5m", "15m", "30m", "1h"];
    default:
      return [FREE_INTERVAL];
  }
}
