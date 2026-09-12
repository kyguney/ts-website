// ---------------------------------------------------------------------------
// Feed read-path USD mapping (design C5/C7, Req 7.1–7.4).
//
// The `/api/analysis/feed` route reads a per-tier slice for each symbol and
// layers a per-user USD envelope (entry zone + TP1/TP2/SL in USD) onto every
// row. That USD math is the DETERMINISTIC core the E2E acceptance test recomputes
// against (Req 7.4), so it lives here as importable, side-effect-free helpers
// rather than inside the route module.
//
// Why a separate module (not exported from the route file): Next.js App Router
// route files may only export the HTTP handlers + a fixed set of config fields
// (`runtime`, `dynamic`, …). Exporting arbitrary helpers/types from a `route.ts`
// fails the Next.js route type check at build time. Extracting them here keeps
// the route thin, lets the E2E drive the EXACT same code the route runs, and
// keeps everything build-clean.
// ---------------------------------------------------------------------------

import type { StoredAnalysis } from "@/lib/ai/store";
import { computeUsdLevels, type UsdLevels } from "@/lib/ai/risk";
import type {
  FreeTierSlice,
  FullTierSlice,
  TierSlice,
} from "@/lib/market/tier-cache";

/**
 * The per-user USD envelope attached to every feed row. All four headline
 * numbers (entry zone + TP1/TP2/SL in USD) are derived from the caller's
 * profile at read time, satisfying Req 7.1/7.2. `leverage`, `rrRatio` and
 * `balanceUsd` are echoed so the client (and the E2E test) can see the inputs.
 */
export interface RowUsdLevels extends UsdLevels {
  leverage: number;
  rrRatio: string;
  balanceUsd: number;
}

/** A feed row: the backward-compatible StoredAnalysis plus the USD envelope. */
export interface FeedRow extends StoredAnalysis {
  usd: RowUsdLevels;
}

/**
 * The caller's resolved risk profile used to size every row.
 *
 * The E2E acceptance test (Req 7.3/7.4) constructs this exactly as the route
 * does and drives the real read-path USD math (`usdForSlice`/`fullSliceToRow`)
 * against an independent `computeUsdLevels` recompute.
 */
export interface RiskProfile {
  leverage: number;
  rrReward: number;
  rrRatio: string;
  balanceUsd: number;
}

/** Midpoint of an [low, high] entry range (falls back to the candidate price). */
function entryMidpoint(range: [number, number], fallback: number): number {
  const [lo, hi] = range;
  if (Number.isFinite(lo) && Number.isFinite(hi) && lo > 0 && hi > 0) {
    return (lo + hi) / 2;
  }
  return fallback;
}

/**
 * Computes the per-user USD levels for a slice from the caller's profile.
 * `entryPrice` prefers the candidate price and falls back to the entry-range
 * midpoint; `atrRatioPct` and `direction` come straight off the candidate.
 */
export function usdForSlice(slice: TierSlice, profile: RiskProfile): RowUsdLevels {
  const candidate = slice.candidate;
  const entryFromRange = entryMidpoint(slice.ai.entryRange, candidate.price);
  const entryPrice = candidate.price > 0 ? candidate.price : entryFromRange;

  const levels = computeUsdLevels({
    entryPrice,
    direction: candidate.direction,
    atrRatioPct: candidate.atrRatioPct,
    leverage: profile.leverage,
    rrReward: profile.rrReward,
    balanceUsd: profile.balanceUsd,
  });

  return {
    ...levels,
    leverage: profile.leverage,
    rrRatio: profile.rrRatio,
    balanceUsd: profile.balanceUsd,
  };
}

/**
 * Maps a Full (pro/ultimate) slice → a backward-compatible StoredAnalysis row
 * with the per-user USD envelope attached. The ladder prices come from the
 * user-agnostic slice; the USD numbers are computed for this caller.
 */
export function fullSliceToRow(
  slice: FullTierSlice,
  profile: RiskProfile,
): FeedRow {
  const usd = usdForSlice(slice, profile);
  const c = slice.candidate;
  return {
    symbol: slice.symbol,
    interval: slice.interval,
    direction: c.direction,
    pattern: c.patternType,
    score: c.score,
    price: c.price,
    ai: {
      sentiment: slice.ai.sentiment,
      summary: slice.ai.summary,
      entryRange: slice.ai.entryRange,
      stopLoss: slice.ai.stopLoss,
      takeProfitLevels: slice.ai.takeProfitLevels,
      riskLevel: slice.ai.riskLevel,
      keyFactors: slice.ai.keyFactors,
    },
    riskRewardRatio: profile.rrRatio,
    source: "llm",
    model: "tier-slice",
    generatedAt: slice.ts,
    usd,
  };
}

/**
 * Maps a Free (reduced) slice → a StoredAnalysis row. The Free tier carries a
 * reduced signal set: a single take-profit (no full ladder) and no detailed
 * key factors, so we synthesize a one-rung ladder and a minimal factor list.
 */
export function freeSliceToRow(
  slice: FreeTierSlice,
  profile: RiskProfile,
): FeedRow {
  const usd = usdForSlice(slice, profile);
  const c = slice.candidate;
  return {
    symbol: slice.symbol,
    interval: slice.interval,
    direction: c.direction,
    pattern: c.patternType,
    score: c.score,
    price: c.price,
    ai: {
      sentiment: slice.ai.sentiment,
      summary: slice.ai.summary,
      entryRange: slice.ai.entryRange,
      stopLoss: slice.ai.stopLoss,
      // Reduced set: a single TP rung only.
      takeProfitLevels: [slice.ai.takeProfit],
      riskLevel: slice.ai.riskLevel,
      keyFactors: ["Free tier signal"],
    },
    riskRewardRatio: profile.rrRatio,
    source: "fallback",
    model: "tier-slice-free",
    generatedAt: slice.ts,
    usd,
  };
}
