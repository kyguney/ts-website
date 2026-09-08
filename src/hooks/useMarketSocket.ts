"use client";

// ---------------------------------------------------------------------------
// useMarketSocket — browser client for the WS gateway (Phase 5).
//
//   • Fetches a short-lived credential from /api/ws/token, then connects to
//     NEXT_PUBLIC_WS_URL with the token in the query string.
//   • Auto-reconnects with exponential backoff (+ jitter) and re-subscribes to
//     the requested channels on every (re)connect.
//   • Exposes reactive state: isConnected, plan, latestTicks (keyed by
//     ticker channel), latestSignals (rolling list), latestBroadcast, and
//     connectionError.
//
// The hook is channel-driven: pass the channels you want and it keeps the
// subscription in sync as they change (e.g. when the user switches timeframe).
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ServerMessage,
  Plan,
} from "@/lib/ws/protocol";
import type { MarketTick, ScanStatus } from "@/lib/market/redis-pipeline";
import type { MarketSignal } from "@/lib/market/types";
import type { StoredAnalysis, FreeBroadcastPayload } from "@/lib/ai/store";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:3001";
const MAX_SIGNALS = 100;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const CLIENT_PING_MS = 25_000;

export interface UseMarketSocketOptions {
  /** Client-facing channels to subscribe to (e.g. `ticker:BTCUSDT:15m`). */
  channels: string[];
  /** Set false to disable the connection entirely. */
  enabled?: boolean;
}

export interface UseMarketSocketState {
  isConnected: boolean;
  plan: Plan | null;
  /** Latest tick keyed by client channel (`ticker:SYMBOL:INTERVAL`). */
  latestTicks: Record<string, MarketTick>;
  /** Rolling list of live AI analyses (Pro) — newest first. */
  latestSignals: StoredAnalysis[];
  /** Rolling list of public free-tier signals — newest first. */
  freeSignals: MarketSignal[];
  /** The current Free broadcast payload, when received. */
  latestBroadcast: FreeBroadcastPayload | null;
  /** Live scan-status heartbeat ("Scanning…", last scan time, counts). */
  scanStatus: ScanStatus | null;
  connectionError: string | null;
  /** Codes emitted by the gateway (e.g. UPGRADE_REQUIRED) for the last error. */
  lastErrorCode: string | null;
}

export function useMarketSocket({
  channels,
  enabled = true,
}: UseMarketSocketOptions): UseMarketSocketState {
  const [isConnected, setIsConnected] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [latestTicks, setLatestTicks] = useState<Record<string, MarketTick>>({});
  const [latestSignals, setLatestSignals] = useState<StoredAnalysis[]>([]);
  const [freeSignals, setFreeSignals] = useState<MarketSignal[]>([]);
  const [latestBroadcast, setLatestBroadcast] =
    useState<FreeBroadcastPayload | null>(null);
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [lastErrorCode, setLastErrorCode] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttempts = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const closedByUs = useRef(false);

  // Stable key for the channel set so effects only re-run on real changes.
  const channelsKey = useMemo(() => [...channels].sort().join("|"), [channels]);
  const channelsRef = useRef<string[]>(channels);
  channelsRef.current = channels;

  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // Ref-held functions break the connect ⇄ reconnect cycle without re-creating
  // the socket on every render.
  const connectRef = useRef<() => void>(() => {});
  const scheduleReconnectRef = useRef<() => void>(() => {});

  const handleMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case "welcome":
        setPlan(msg.plan);
        break;
      case "tick":
        setLatestTicks((prev) => ({ ...prev, [msg.channel]: msg.data }));
        break;
      case "ai": {
        const key = `${msg.data.symbol}:${msg.data.interval}`;
        setLatestSignals((prev) => {
          const filtered = prev.filter(
            (s) => `${s.symbol}:${s.interval}` !== key,
          );
          return [msg.data, ...filtered].slice(0, MAX_SIGNALS);
        });
        break;
      }
      case "signal": {
        const key = `${msg.data.symbol}:${msg.data.interval}`;
        setFreeSignals((prev) => {
          const filtered = prev.filter(
            (s) => `${s.symbol}:${s.interval}` !== key,
          );
          return [msg.data, ...filtered].slice(0, MAX_SIGNALS);
        });
        break;
      }
      case "free_broadcast":
        setLatestBroadcast(msg.data);
        break;
      case "scan_status":
        setScanStatus(msg.data);
        break;
      case "error":
        setLastErrorCode(msg.error);
        if (msg.error !== "UPGRADE_REQUIRED") {
          setConnectionError(msg.message ?? msg.error);
        }
        break;
      default:
        break;
    }
  }, []);

  const subscribe = useCallback((chs: string[]) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && chs.length) {
      ws.send(JSON.stringify({ action: "subscribe", channels: chs }));
    }
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (closedByUs.current || !enabledRef.current) return;
    reconnectAttempts.current += 1;
    const delay = Math.min(
      BACKOFF_BASE_MS * 2 ** (reconnectAttempts.current - 1),
      BACKOFF_MAX_MS,
    );
    const jittered = Math.round(delay / 2 + Math.random() * (delay / 2));
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    reconnectTimer.current = setTimeout(() => connectRef.current(), jittered);
  }, []);
  scheduleReconnectRef.current = scheduleReconnect;

  const connect = useCallback(async () => {
    if (!enabledRef.current) return;
    closedByUs.current = false;

    // Fetch a fresh credential each connect (tokens are short-lived).
    let token = "";
    try {
      const res = await fetch("/api/ws/token", { cache: "no-store" });
      if (res.ok) {
        const body = (await res.json()) as { token?: string; plan?: Plan };
        token = body.token ?? "";
        if (body.plan) setPlan(body.plan);
      }
      // On 401 we still connect anonymously (gateway grants FREE).
    } catch {
      // Network error fetching token — connect anonymously.
    }

    const url = token ? `${WS_URL}?token=${encodeURIComponent(token)}` : WS_URL;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      setConnectionError(e instanceof Error ? e.message : "Connection failed.");
      scheduleReconnectRef.current();
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectAttempts.current = 0;
      setIsConnected(true);
      setConnectionError(null);
      subscribe(channelsRef.current);

      if (pingTimer.current) clearInterval(pingTimer.current);
      pingTimer.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ action: "ping" }));
        }
      }, CLIENT_PING_MS);
    };

    ws.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        return;
      }
      handleMessage(msg);
    };

    ws.onerror = () => {
      setConnectionError("WebSocket connection error.");
    };

    ws.onclose = () => {
      setIsConnected(false);
      if (pingTimer.current) clearInterval(pingTimer.current);
      pingTimer.current = null;
      if (!closedByUs.current) scheduleReconnectRef.current();
    };
  }, [subscribe, handleMessage]);
  connectRef.current = () => void connect();

  // (Re)connect when enabled toggles.
  useEffect(() => {
    if (!enabled) return;
    void connect();
    return () => {
      closedByUs.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (pingTimer.current) clearInterval(pingTimer.current);
      wsRef.current?.close();
      wsRef.current = null;
      setIsConnected(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Keep the server-side subscription in sync as `channels` change.
  const prevChannelsKey = useRef<string>("");
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      prevChannelsKey.current = channelsKey;
      return;
    }
    const prev = prevChannelsKey.current
      ? prevChannelsKey.current.split("|").filter(Boolean)
      : [];
    const next = channelsRef.current;

    const toAdd = next.filter((c) => !prev.includes(c));
    const toRemove = prev.filter((c) => !next.includes(c));

    if (toRemove.length) {
      ws.send(JSON.stringify({ action: "unsubscribe", channels: toRemove }));
    }
    if (toAdd.length) {
      ws.send(JSON.stringify({ action: "subscribe", channels: toAdd }));
    }
    prevChannelsKey.current = channelsKey;
  }, [channelsKey]);

  return {
    isConnected,
    plan,
    latestTicks,
    latestSignals,
    freeSignals,
    latestBroadcast,
    scanStatus,
    connectionError,
    lastErrorCode,
  };
}
