// ---------------------------------------------------------------------------
// Deterministic risk math (design C5, Req 7.1 / 7.2 / 7.5).
//
// Pure, side-effect-free functions that turn an entry price + the user's risk
// profile (leverage, R:R) + tier balance into concrete price levels AND their
// USD-denominated risk/reward amounts. This is the single source of truth the
// E2E acceptance test recomputes against, so it is intentionally free of any
// I/O, config lookups, or hidden state.
//
// The ladder geometry deliberately does NOT use the old hard-coded
// `1.5 / 0.5 / 2 / 3` multipliers as the source of shape — the R:R and the
// position size come from the profile. Only the volatility unit (ATR%) and a
// small configurable stop-multiplier `K` / ATR floor remain as tunables.
// ---------------------------------------------------------------------------

import type { TradeDirection } from "@/lib/market/types";

// --- Tunables (exported so tests can reason about them) ---------------------

/**
 * Stop-distance multiplier applied to the ATR-based volatility unit:
 *   stopDist = entryPrice * max(atrRatioPct, ATR_FLOOR_PCT) / 100 * STOP_ATR_K
 * Kept configurable (mirrors the legacy `1.5×ATR` stop) but no longer drives
 * the reward geometry, which comes from the profile R:R.
 */
export const STOP_ATR_K = 1.5;

/**
 * Minimum ATR% floor so a near-zero ATR still yields a usable stop distance.
 * Mirrors the previous `Math.max(atrRatioPct, 0.3)` behaviour.
 */
export const ATR_FLOOR_PCT = 0.3;

/** Default reward multiple used when an R:R ratio can't be parsed. */
export const DEFAULT_RR_REWARD = 2;

// --- R:R parsing ------------------------------------------------------------

/**
 * Parses a "1:X" risk:reward string into its reward multiple `X`.
 *
 *   "1:3"   → 3
 *   "1:2.5" → 2.5
 *   "1:0"   → DEFAULT_RR_REWARD (non-positive reward is invalid)
 *   ""      → DEFAULT_RR_REWARD
 *   "3"     → DEFAULT_RR_REWARD (malformed)
 *
 * Validated: the risk side must be `1`, the reward must be a positive finite
 * number. Anything malformed falls back to {@link DEFAULT_RR_REWARD}.
 */
export function parseRrRatio(
  ratio: string | null | undefined,
  fallback = DEFAULT_RR_REWARD,
): number {
  if (typeof ratio !== "string") return fallback;
  const match = ratio.trim().match(/^1:(\d+(?:\.\d+)?)$/);
  if (!match) return fallback;
  const reward = Number(match[1]);
  if (!Number.isFinite(reward) || reward <= 0) return fallback;
  return reward;
}

// --- USD level computation --------------------------------------------------

export interface ComputeUsdLevelsInput {
  /** Current / entry reference price. */
  entryPrice: number;
  /** Trade direction — LONG puts the stop below entry, SHORT above. */
  direction: TradeDirection;
  /** ATR as a percentage of price (the volatility unit). */
  atrRatioPct: number;
  /** User's leverage (position notional = balance * leverage). */
  leverage: number;
  /** Reward multiple from `parseRrRatio` (the "X" in "1:X"). */
  rrReward: number;
  /** Tier demo balance (USD) used as the position-sizing base. */
  balanceUsd: number;
}

export interface UsdLevels {
  /** [low, high] entry zone around the entry price. */
  entryZone: [number, number];
  stopLossPrice: number;
  tp1Price: number;
  tp2Price: number;
  /** USD risk if stopped out (|entry − stop| * qty). */
  stopLossUsd: number;
  /** USD reward at TP1 (|tp1 − entry| * qty). */
  tp1Usd: number;
  /** USD reward at TP2 (|tp2 − entry| * qty). */
  tp2Usd: number;
}

/** Rounds to a sensible precision for the price magnitude. */
function roundPrice(p: number): number {
  if (Math.abs(p) >= 1) return Math.round(p * 1000) / 1000;
  return Math.round(p * 1_000_000) / 1_000_000;
}

/** Rounds a USD amount to cents. */
function roundUsd(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Computes concrete price levels + their USD risk/reward from an entry price
 * and the user's risk profile. Deterministic: the same inputs always yield the
 * same output.
 *
 *   stopDist = entryPrice * max(atrRatioPct, ATR_FLOOR_PCT)/100 * STOP_ATR_K
 *   tp1 = entry ± stopDist * rrReward
 *   tp2 = entry ± stopDist * (rrReward + 1)
 *   notional = balanceUsd * leverage;  qty = notional / entryPrice
 *   stopLossUsd = |entry − stop| * qty, tp1Usd = |tp1 − entry| * qty, tp2 likewise
 *
 * For LONG the stop sits below entry and TPs above; for SHORT it is mirrored.
 */
export function computeUsdLevels(input: ComputeUsdLevelsInput): UsdLevels {
  const { entryPrice, direction, atrRatioPct, leverage, rrReward, balanceUsd } =
    input;

  const isLong = direction === "LONG";

  // Volatility unit: ATR% of price, floored, scaled by the stop multiplier.
  const atrFrac = Math.max(atrRatioPct, ATR_FLOOR_PCT) / 100;
  const stopDist = entryPrice * atrFrac * STOP_ATR_K;
  // Entry pad scales with the stop distance so the zone is proportional.
  const entryPad = stopDist * (0.5 / STOP_ATR_K);

  const entryZone: [number, number] = isLong
    ? [roundPrice(entryPrice - entryPad), roundPrice(entryPrice)]
    : [roundPrice(entryPrice), roundPrice(entryPrice + entryPad)];

  const stopLossPrice = isLong
    ? roundPrice(entryPrice - stopDist)
    : roundPrice(entryPrice + stopDist);

  const tp1Price = isLong
    ? roundPrice(entryPrice + stopDist * rrReward)
    : roundPrice(entryPrice - stopDist * rrReward);
  const tp2Price = isLong
    ? roundPrice(entryPrice + stopDist * (rrReward + 1))
    : roundPrice(entryPrice - stopDist * (rrReward + 1));

  // Position sizing: notional = balance * leverage; qty in base units.
  const notional = balanceUsd * leverage;
  const qty = entryPrice > 0 ? notional / entryPrice : 0;

  const stopLossUsd = roundUsd(Math.abs(entryPrice - stopLossPrice) * qty);
  const tp1Usd = roundUsd(Math.abs(tp1Price - entryPrice) * qty);
  const tp2Usd = roundUsd(Math.abs(tp2Price - entryPrice) * qty);

  return {
    entryZone,
    stopLossPrice,
    tp1Price,
    tp2Price,
    stopLossUsd,
    tp1Usd,
    tp2Usd,
  };
}
