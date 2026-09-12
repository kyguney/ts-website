// ---------------------------------------------------------------------------
// Kline resampling for tier-based scan slicing.
//
// The continuous 1-minute scanner is the single source of truth. Higher
// timeframes for the Pro (5m) and Free (15m) tiers are *derived* by
// aggregating the most recent 1m candles instead of running a separate engine
// pass per timeframe (design section C3, Requirement 3.5).
//
// This module is intentionally pure and side-effect free so it can be unit
// tested in isolation (Task 16).
// ---------------------------------------------------------------------------

import type { Kline } from "@/lib/market/types";

/**
 * Aggregate the most recent `factor` 1-minute candles into a single higher
 * timeframe bar.
 *
 * Aggregation rules (Requirement 3.5, design C3):
 *   - open       = first candle's open
 *   - close      = last candle's close
 *   - high       = max(high) across the window
 *   - low        = min(low) across the window
 *   - volume     = Σ volume
 *   - quoteVolume= Σ quoteVolume
 *   - trades     = Σ trades
 *   - openTime   = first candle's openTime
 *   - closeTime  = last candle's closeTime
 *
 * `factor = 5`  → one 5m bar (Pro tier).
 * `factor = 15` → one 15m bar (Free tier).
 *
 * Partial-window handling:
 *   If fewer than `factor` candles are available, whatever exists is
 *   aggregated into a partial bar and flagged with `isClosed = false`. A full
 *   window is flagged `isClosed = true`. Callers that need to distinguish a
 *   complete bar from an in-progress one can inspect `isClosed`.
 *
 * @param klines1m Ordered array of 1m candles, oldest → newest.
 * @param factor   Number of 1m candles to fold into one target bar (> 0).
 * @returns The aggregated {@link Kline}.
 * @throws If `klines1m` is empty or `factor` is not a positive integer.
 */
export function resampleKlines(klines1m: Kline[], factor: number): Kline {
  if (!Number.isInteger(factor) || factor <= 0) {
    throw new Error(`resampleKlines: factor must be a positive integer, got ${factor}`);
  }
  if (klines1m.length === 0) {
    throw new Error("resampleKlines: klines1m must contain at least one candle");
  }

  // Take the most recent `factor` candles (or everything, if fewer exist).
  const window = klines1m.slice(-factor);
  const isComplete = window.length >= factor;

  const first = window[0];
  const last = window[window.length - 1];

  let high = first.high;
  let low = first.low;
  let volume = 0;
  let quoteVolume = 0;
  let trades = 0;

  for (const k of window) {
    if (k.high > high) high = k.high;
    if (k.low < low) low = k.low;
    volume += k.volume;
    quoteVolume += k.quoteVolume;
    trades += k.trades;
  }

  return {
    openTime: first.openTime,
    open: first.open,
    high,
    low,
    close: last.close,
    volume,
    closeTime: last.closeTime,
    quoteVolume,
    trades,
    // A full window is a closed higher-timeframe bar; a partial window is
    // still forming, so mark it not-closed.
    isClosed: isComplete,
  };
}

/**
 * Aggregate a 1-minute series into a series of higher-timeframe bars by folding
 * consecutive, non-overlapping groups of `factor` candles into one bar each.
 *
 * Where {@link resampleKlines} produces the single most-recent target bar, this
 * builds the full resampled *history* — enough bars for the scoring engine's
 * indicator layer (which needs a minimum candle count) to run on the derived
 * timeframe (design C3: "engine run on resampled 5m/15m bar").
 *
 * Grouping is anchored to the newest candle so the final bar is always the
 * freshest fully-/partially-formed target bar:
 *   - The series is chunked from the END backwards in groups of `factor`.
 *   - A leading remainder (< `factor` candles) becomes the oldest partial bar.
 *   - Result is ordered oldest → newest, mirroring the 1m input order.
 *
 * @param klines1m Ordered array of 1m candles, oldest → newest.
 * @param factor   Number of 1m candles per target bar (> 0).
 * @returns Ordered array of aggregated bars (oldest → newest). Empty input
 *          yields an empty array.
 * @throws If `factor` is not a positive integer.
 */
export function resampleSeries(klines1m: Kline[], factor: number): Kline[] {
  if (!Number.isInteger(factor) || factor <= 0) {
    throw new Error(`resampleSeries: factor must be a positive integer, got ${factor}`);
  }
  if (klines1m.length === 0) return [];

  const bars: Kline[] = [];
  // Chunk into non-overlapping groups of `factor`. A leading remainder (when
  // the length isn't a multiple of `factor`) forms the oldest partial bar.
  for (let start = 0; start < klines1m.length; start += factor) {
    const group = klines1m.slice(start, start + factor);
    bars.push(aggregateGroup(group, factor));
  }
  return bars;
}

/** Aggregates one already-sliced group of 1m candles into a single bar. */
function aggregateGroup(group: Kline[], factor: number): Kline {
  const first = group[0];
  const last = group[group.length - 1];

  let high = first.high;
  let low = first.low;
  let volume = 0;
  let quoteVolume = 0;
  let trades = 0;

  for (const k of group) {
    if (k.high > high) high = k.high;
    if (k.low < low) low = k.low;
    volume += k.volume;
    quoteVolume += k.quoteVolume;
    trades += k.trades;
  }

  return {
    openTime: first.openTime,
    open: first.open,
    high,
    low,
    close: last.close,
    volume,
    closeTime: last.closeTime,
    quoteVolume,
    trades,
    isClosed: group.length >= factor,
  };
}
