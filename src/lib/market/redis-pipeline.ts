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

/** Publishes a qualifying signal to the `market:signal` Pub/Sub channel. */
export async function publishSignal(signal: MarketSignal): Promise<void> {
  if (!redis) return;
  await redis.publish(SIGNAL_CHANNEL, JSON.stringify(signal));
}
