// ---------------------------------------------------------------------------
// Redis data layer for the market ingestion/analysis pipeline.
//
// Three responsibilities:
//   1. Sliding candle windows in Sorted Sets, scored by openTime, trimmed to
//      the last N candles.  Key: klines:{symbol}:{interval}
//   2. Latest indicator/candidate snapshot cache.
//      Key: market:snapshot:{symbol}:{interval}
//   3. Pub/Sub fan-out of qualifying signals on channel `market:signal`.
//
// Uses the shared ioredis client from `@/lib/redis`. All calls degrade
// gracefully when Redis is unavailable (client is null).
// ---------------------------------------------------------------------------

import { redis } from "@/lib/redis";
import type {
  Interval,
  Kline,
  MarketSignal,
  MarketSnapshot,
} from "@/lib/market/types";

/** Number of candles retained per sliding window. */
export const WINDOW_SIZE = 200;

export const SIGNAL_CHANNEL = "market:signal";

/** Pub/Sub channel for finalized (closed) candles across all symbols/intervals. */
export const CANDLE_CLOSED_CHANNEL = "market:candle:closed";

/** Pub/Sub channel + cache key for live scan-status heartbeats. */
export const SCAN_STATUS_CHANNEL = "market:scan:status";
export const SCAN_STATUS_KEY = "market:scan:status:latest";

/** Live scan-status heartbeat surfaced to the dashboard ("Scanning…"). */
export interface ScanStatus {
  /** True while a scan pass is actively running. */
  scanning: boolean;
  /** Epoch ms of the last completed scan (0 if none yet). */
  lastScanAt: number;
  /** Symbols evaluated in the last/current pass. */
  symbolsScanned: number;
  /** Symbol×interval combinations evaluated. */
  combosScanned: number;
  /** Candidates detected in the last pass. */
  candidatesFound: number;
  /** What triggered the scan. */
  trigger: "interval" | "manual" | "close";
  /** Interval cadence (seconds) of the automatic scan loop. */
  everySec: number;
  /**
   * The timeframe(s) this scan covered. Since scanning is timeframe-aligned,
   * each interval scans on its own cadence; the client keeps a per-interval
   * "last scanned" map from this field.
   */
  intervals?: Interval[];
}

/**
 * Merges the per-interval "last scanned" timestamps into a durable hash so the
 * dashboard can show the latest scan time for EACH period, not just the most
 * recent global one. Keyed by interval → epoch ms.
 */
export const SCAN_TIMES_KEY = "market:scan:times";

export async function recordScanTimes(
  intervals: Interval[],
  at: number,
): Promise<void> {
  if (!redis || intervals.length === 0) return;
  const flat: string[] = [];
  for (const iv of intervals) flat.push(iv, String(at));
  await redis.hset(SCAN_TIMES_KEY, ...flat);
  await redis.expire(SCAN_TIMES_KEY, 24 * 60 * 60);
}

/** Reads the per-interval last-scan timestamps (interval → epoch ms). */
export async function readScanTimes(): Promise<Record<string, number>> {
  if (!redis) return {};
  const map = await redis.hgetall(SCAN_TIMES_KEY);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(map)) {
    const n = Number(v);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

/** Per-user manual scan history (Pro). Newest first, capped + TTL'd. */
export function scanHistoryKey(userId: string): string {
  return `analysis:scan:history:${userId}`;
}

const SCAN_HISTORY_MAX = 25;
const SCAN_HISTORY_TTL_SEC = 7 * 24 * 60 * 60; // 7 days

/** A saved manual-scan result the user can review later. */
export interface ScanHistoryEntry {
  id: string;
  scannedAt: number;
  trigger: "manual";
  symbolsScanned: number;
  combosScanned: number;
  candidatesFound: number;
  /** The analyses shown to the user at scan time (their active interval). */
  analyses: import("@/lib/ai/store").StoredAnalysis[];
}

/** Pushes a manual scan result onto the user's history list (newest first). */
export async function pushScanHistory(
  userId: string,
  entry: ScanHistoryEntry,
): Promise<void> {
  if (!redis) return;
  const key = scanHistoryKey(userId);
  await redis.lpush(key, JSON.stringify(entry));
  await redis.ltrim(key, 0, SCAN_HISTORY_MAX - 1);
  await redis.expire(key, SCAN_HISTORY_TTL_SEC);
}

/** Reads the user's manual scan history (newest first). */
export async function readScanHistory(
  userId: string,
): Promise<ScanHistoryEntry[]> {
  if (!redis) return [];
  const raws = await redis.lrange(scanHistoryKey(userId), 0, SCAN_HISTORY_MAX - 1);
  const out: ScanHistoryEntry[] = [];
  for (const raw of raws) {
    try {
      out.push(JSON.parse(raw) as ScanHistoryEntry);
    } catch {
      // skip malformed
    }
  }
  return out;
}

/** Publishes + caches the current scan status. */
export async function publishScanStatus(status: ScanStatus): Promise<void> {
  if (!redis) return;
  const payload = JSON.stringify(status);
  await redis.set(SCAN_STATUS_KEY, payload, "EX", 300);
  await redis.publish(SCAN_STATUS_CHANNEL, payload);
}

/** Reads the last scan status (null when absent). */
export async function readScanStatus(): Promise<ScanStatus | null> {
  if (!redis) return null;
  const raw = await redis.get(SCAN_STATUS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ScanStatus;
  } catch {
    return null;
  }
}

/**
 * Per symbol/interval live-tick channel. The WS gateway subscribes with a
 * pattern (`market:tick:*`) and fans out to interested client connections.
 */
export function tickChannel(symbol: string, interval: Interval): string {
  return `market:tick:${symbol}:${interval}`;
}

/** Real-time payload published on every kline update (in-progress or closed). */
export interface MarketTick {
  symbol: string;
  interval: Interval;
  price: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openTime: number;
  closeTime: number;
  isClosed: boolean;
  timestamp: number;
}

export function klineWindowKey(symbol: string, interval: Interval): string {
  return `klines:${symbol}:${interval}`;
}

export function snapshotKey(symbol: string, interval: Interval): string {
  return `market:snapshot:${symbol}:${interval}`;
}

/**
 * Adds/updates a candle in the sliding window (ZADD by openTime), then trims
 * to the most recent WINDOW_SIZE candles (ZREMRANGEBYRANK). Using openTime as
 * the score makes ZADD idempotent for the in-progress candle: repeated updates
 * of the same openTime overwrite the member rather than appending.
 */
export async function pushCandle(
  symbol: string,
  interval: Interval,
  candle: Kline,
): Promise<void> {
  if (!redis) return;
  const key = klineWindowKey(symbol, interval);
  const member = JSON.stringify(candle);

  // Remove any existing member for this openTime so an updated (in-progress)
  // candle replaces the prior snapshot of the same candle.
  await redis.zremrangebyscore(key, String(candle.openTime), String(candle.openTime));
  await redis.zadd(key, String(candle.openTime), member);
  // Trim: keep only the newest WINDOW_SIZE (drop everything before rank -N).
  await redis.zremrangebyrank(key, 0, -(WINDOW_SIZE + 1));
}

/**
 * Publishes a live tick to `market:tick:{symbol}:{interval}` on every kline
 * update. The WS gateway pattern-subscribes and fans out to client sockets.
 * Fire-and-forget: never blocks the ingestion path if Pub/Sub is slow.
 */
export async function publishTick(
  symbol: string,
  interval: Interval,
  candle: Kline,
): Promise<void> {
  if (!redis) return;
  const tick: MarketTick = {
    symbol,
    interval,
    price: candle.close,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    openTime: candle.openTime,
    closeTime: candle.closeTime,
    isClosed: Boolean(candle.isClosed),
    timestamp: Date.now(),
  };
  await redis.publish(tickChannel(symbol, interval), JSON.stringify(tick));
}

/** Publishes a finalized candle to the shared `market:candle:closed` channel. */
export async function publishCandleClosed(
  symbol: string,
  interval: Interval,
  candle: Kline,
): Promise<void> {
  if (!redis) return;
  await redis.publish(
    CANDLE_CLOSED_CHANNEL,
    JSON.stringify({ symbol, interval, kline: candle, timestamp: Date.now() }),
  );
}

/**
 * Seeds a window with historical candles in one pipeline (used at worker
 * startup so indicators have enough history before the first live candle).
 */
export async function seedWindow(
  symbol: string,
  interval: Interval,
  candles: Kline[],
): Promise<void> {
  if (!redis || candles.length === 0) return;
  const key = klineWindowKey(symbol, interval);
  const pipeline = redis.pipeline();
  pipeline.del(key);
  for (const candle of candles) {
    pipeline.zadd(key, String(candle.openTime), JSON.stringify(candle));
  }
  pipeline.zremrangebyrank(key, 0, -(WINDOW_SIZE + 1));
  await pipeline.exec();
}

/** Reads the sliding window back as an ordered (oldest → newest) Kline[]. */
export async function readWindow(
  symbol: string,
  interval: Interval,
): Promise<Kline[]> {
  if (!redis) return [];
  const key = klineWindowKey(symbol, interval);
  const members = await redis.zrange(key, "0", "-1");
  const out: Kline[] = [];
  for (const m of members) {
    try {
      out.push(JSON.parse(m) as Kline);
    } catch {
      // Skip malformed members.
    }
  }
  return out;
}

/** Persists the latest snapshot for a symbol/interval (JSON string). */
export async function saveSnapshot(snapshot: MarketSnapshot): Promise<void> {
  if (!redis) return;
  const key = snapshotKey(snapshot.symbol, snapshot.interval);
  // TTL keeps stale snapshots from lingering if the worker stops.
  await redis.set(key, JSON.stringify(snapshot), "EX", 60 * 60);
}

/** Reads a single snapshot back (used by dashboard/API readers). */
export async function readSnapshot(
  symbol: string,
  interval: Interval,
): Promise<MarketSnapshot | null> {
  if (!redis) return null;
  const raw = await redis.get(snapshotKey(symbol, interval));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MarketSnapshot;
  } catch {
    return null;
  }
}

/**
 * Reads every cached snapshot for a given interval across all tracked symbols.
 * Uses a non-blocking SCAN so it's safe on large keyspaces. Powers the
 * dashboard's live indicator columns (price / RSI / ATR% / 24h change), which
 * the scan pass refreshes continuously.
 */
export async function readSnapshotsByInterval(
  interval: Interval,
): Promise<MarketSnapshot[]> {
  if (!redis) return [];
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(
      cursor,
      "MATCH",
      `market:snapshot:*:${interval}`,
      "COUNT",
      200,
    );
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");

  if (keys.length === 0) return [];

  const raws = await redis.mget(keys);
  const out: MarketSnapshot[] = [];
  for (const raw of raws) {
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw) as MarketSnapshot);
    } catch {
      // skip malformed
    }
  }
  return out;
}

/** Publishes a qualifying signal to the `market:signal` Pub/Sub channel. */
export async function publishSignal(signal: MarketSignal): Promise<void> {
  if (!redis) return;
  await redis.publish(SIGNAL_CHANNEL, JSON.stringify(signal));
}
