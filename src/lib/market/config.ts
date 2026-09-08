// ---------------------------------------------------------------------------
// Runtime configuration for the market worker & CLI, sourced from env.
// ---------------------------------------------------------------------------

import { INTERVALS, type Interval } from "@/lib/market/types";
import {
  DEFAULT_UNIVERSE_FILTER,
  discoverTradableSymbols,
  type UniverseFilter,
} from "@/lib/market/binance";

/**
 * Fallback watchlist. Only used when dynamic discovery is disabled or fails,
 * or when TRACKED_SYMBOLS is explicitly pinned. The live worker normally
 * discovers its universe from Binance (see resolveTrackedSymbols).
 */
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

/** Symbols always tracked (BTC/ETH power the market-regime context). */
export const REGIME_SYMBOLS = ["BTCUSDT", "ETHUSDT"];

/**
 * Reads an explicitly pinned watchlist from TRACKED_SYMBOLS. Returns null when
 * unset/empty, signaling "discover dynamically". A pinned list disables
 * discovery so operators can still lock the worker to a fixed set if desired.
 */
export function getPinnedSymbols(): string[] | null {
  const raw = process.env.TRACKED_SYMBOLS;
  if (!raw || !raw.trim()) return null;
  const parsed = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return parsed.length > 0 ? Array.from(new Set(parsed)) : null;
}

/** True unless discovery is explicitly turned off via SYMBOL_DISCOVERY=false. */
export function isDiscoveryEnabled(): boolean {
  return process.env.SYMBOL_DISCOVERY !== "false";
}

function numEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Universe qualification thresholds, overridable via env. */
export function getUniverseFilter(): UniverseFilter {
  return {
    min24hVolumeUsdt: numEnv("MIN_24H_VOLUME_USDT", DEFAULT_UNIVERSE_FILTER.min24hVolumeUsdt),
    max24hChangePct: numEnv("MAX_24H_CHANGE_PCT", DEFAULT_UNIVERSE_FILTER.max24hChangePct),
    minFundingRate: numEnv("MIN_FUNDING_RATE", DEFAULT_UNIVERSE_FILTER.minFundingRate),
    maxFundingRate: numEnv("MAX_FUNDING_RATE", DEFAULT_UNIVERSE_FILTER.maxFundingRate),
  };
}

/** Max symbols to stream when discovering dynamically (WS stream budget). */
export function getMaxTrackedSymbols(): number {
  return numEnv("MAX_TRACKED_SYMBOLS", 60);
}

/**
 * Resolves the symbols the worker should stream & analyze:
 *   1. If TRACKED_SYMBOLS is pinned → use it verbatim (discovery off).
 *   2. Else if discovery is enabled → discover the live universe from Binance
 *      (crypto-only + volume/|change|/funding filters, volume-sorted, capped).
 *   3. On any discovery failure → fall back to DEFAULT_TRACKED_SYMBOLS.
 * REGIME_SYMBOLS are always included so BTC/ETH regime context is available.
 */
export async function resolveTrackedSymbols(): Promise<string[]> {
  const pinned = getPinnedSymbols();
  if (pinned) {
    return Array.from(new Set([...pinned, ...REGIME_SYMBOLS]));
  }

  if (!isDiscoveryEnabled()) {
    return Array.from(new Set([...DEFAULT_TRACKED_SYMBOLS, ...REGIME_SYMBOLS]));
  }

  try {
    const discovered = await discoverTradableSymbols({
      filter: getUniverseFilter(),
      alwaysInclude: REGIME_SYMBOLS,
      limit: getMaxTrackedSymbols(),
    });
    if (discovered.length > 0) return discovered;
  } catch {
    // Fall through to the static fallback below.
  }
  return Array.from(new Set([...DEFAULT_TRACKED_SYMBOLS, ...REGIME_SYMBOLS]));
}

/**
 * Synchronous best-effort watchlist for non-worker callers (CLI). Uses the
 * pinned list if present, else the static default. The streaming worker should
 * prefer the async `resolveTrackedSymbols`.
 */
export function getTrackedSymbols(): string[] {
  return getPinnedSymbols() ?? [...DEFAULT_TRACKED_SYMBOLS];
}

/** Intervals the worker streams and analyzes. */
export function getIntervals(): Interval[] {
  return INTERVALS;
}
