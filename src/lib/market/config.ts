// ---------------------------------------------------------------------------
// Runtime configuration for the market worker & CLI, sourced from env.
// ---------------------------------------------------------------------------

import { INTERVALS, type Interval } from "@/lib/market/types";

/** Default watchlist, matching the active scanner list. */
export const DEFAULT_TRACKED_SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "ENAUSDT",
  "AEROUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "AVAXUSDT",
  "LINKUSDT",
];

/**
 * Parses TRACKED_SYMBOLS ("BTCUSDT,ETHUSDT,...") into an uppercased,
 * de-duplicated list. Falls back to DEFAULT_TRACKED_SYMBOLS.
 */
export function getTrackedSymbols(): string[] {
  const raw = process.env.TRACKED_SYMBOLS;
  if (!raw || !raw.trim()) return [...DEFAULT_TRACKED_SYMBOLS];
  const parsed = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return parsed.length > 0 ? Array.from(new Set(parsed)) : [...DEFAULT_TRACKED_SYMBOLS];
}

/** Intervals the worker streams and analyzes. */
export function getIntervals(): Interval[] {
  return INTERVALS;
}
