// ---------------------------------------------------------------------------
// Tier-based scan cache (Phase 4).
//
// The continuous 1m scanner produces exactly one raw engine result per symbol
// per minute and derives three per-tier slices from it:
//
//   • ultimate — full 1m data, full TP ladder.
//   • pro      — 5m resampled slice, full TP ladder.
//   • free     — 15m resampled slice, REDUCED signal set (no full ladder /
//                detailed key factors; direction, score, entry, single TP+SL).
//
// Each slice is written to a short-lived history key `scan:{tier}:{symbol}:{ts}`
// and a per-tier `:latest` pointer for O(1) reads. Reads are per-tier only — no
// per-user recompute happens here (USD TP/SL are computed at read time by the
// feed/gateway from the caller's profile).
//
// Uses the shared ioredis client from `@/lib/redis`. Every call degrades
// gracefully when Redis is unavailable (client is null), mirroring
// `redis-pipeline.ts`.
// ---------------------------------------------------------------------------

import { redis } from "@/lib/redis";
import type { UserPlan } from "@/lib/user-entitlement";
import type {
  AnalysisCandidate,
  IndicatorSnapshot,
  Interval,
} from "@/lib/market/types";
import type { AIAnalysisOutput } from "@/lib/ai/analyzer";

/** The tier a slice belongs to. Reuses the entitlement plan type. */
export type Tier = UserPlan;

/**
 * Per-tier base TTL (seconds). Each is ≥ its slice interval so a slice never
 * expires before the next scan of that tier can refresh it (Req 3.4):
 *   • ultimate — 1m slice → 90s
 *   • pro      — 5m slice → 360s
 *   • free     — 15m slice → 960s
 */
export const TIER_TTL_SEC: Record<Tier, number> = {
  ultimate: 90,
  pro: 360,
  free: 960,
};

/** Max jitter (seconds) added to each TTL to avoid synchronized expiry. */
export const TTL_JITTER_MAX_SEC = 15;

/** Returns a random integer in [0, TTL_JITTER_MAX_SEC]. */
function ttlJitterSec(): number {
  return Math.floor(Math.random() * (TTL_JITTER_MAX_SEC + 1));
}

// --- Keys --------------------------------------------------------------------

/** Short-lived history key for a specific scan boundary. */
export function tierScanKey(tier: Tier, symbol: string, ts: number): string {
  return `scan:${tier}:${symbol}:${ts}`;
}

/** O(1) "latest" pointer to the newest slice for a symbol on a tier. */
export function tierLatestKey(tier: Tier, symbol: string): string {
  return `scan:${tier}:${symbol}:latest`;
}

// --- Slice payload shapes ----------------------------------------------------

/**
 * The AI-derived signal a slice carries. Pro/Ultimate keep the full ladder;
 * Free carries the reduced set (see {@link ReducedTierSignal}).
 */
export interface FullTierSignal {
  sentiment: AIAnalysisOutput["sentiment"];
  summary: string;
  /** [low, high] suggested entry zone (prices, user-agnostic). */
  entryRange: [number, number];
  stopLoss: number;
  /** Full ordered take-profit ladder. */
  takeProfitLevels: number[];
  riskLevel: AIAnalysisOutput["riskLevel"];
  keyFactors: string[];
}

/**
 * The reduced signal the Free tier carries: direction/score live on the
 * candidate; here we keep only entry, a single take-profit, and the stop.
 * The full TP ladder and detailed key factors are intentionally omitted.
 */
export interface ReducedTierSignal {
  sentiment: AIAnalysisOutput["sentiment"];
  summary: string;
  /** [low, high] suggested entry zone (prices, user-agnostic). */
  entryRange: [number, number];
  stopLoss: number;
  /** Single take-profit (first ladder rung) — no full ladder. */
  takeProfit: number;
  riskLevel: AIAnalysisOutput["riskLevel"];
}

/** Common fields every slice carries, regardless of tier/signal shape. */
interface TierSliceBase {
  tier: Tier;
  symbol: string;
  /** The interval the slice represents (1m/5m/15m per tier). */
  interval: Interval;
  /** The 1m scan boundary (epoch ms) this slice was derived from. */
  ts: number;
  candidate: AnalysisCandidate;
  indicators: IndicatorSnapshot;
}

/** Full-fidelity slice for the Pro and Ultimate tiers. */
export interface FullTierSlice extends TierSliceBase {
  tier: "pro" | "ultimate";
  ai: FullTierSignal;
}

/** Reduced slice for the Free tier. */
export interface FreeTierSlice extends TierSliceBase {
  tier: "free";
  ai: ReducedTierSignal;
}

/** Any tier slice (discriminated by `tier`). */
export type TierSlice = FullTierSlice | FreeTierSlice;

/** The three slices derived from one raw 1m scan result. */
export interface TierSlices {
  symbol: string;
  ts: number;
  ultimate: FullTierSlice;
  pro: FullTierSlice;
  free: FreeTierSlice;
}

// --- Writes ------------------------------------------------------------------

/**
 * Writes all three tier slices for a symbol in a single pipeline. For each
 * tier it SETs both the `:{ts}` history key and overwrites the `:latest`
 * pointer, each with `EX = TIER_TTL_SEC[tier] + jitter(0..15s)`.
 *
 * Degrades to a no-op when Redis is unavailable.
 */
export async function writeTierSlices(slices: TierSlices): Promise<void> {
  if (!redis) return;

  const { symbol, ts, ultimate, pro, free } = slices;
  const pipeline = redis.pipeline();

  for (const slice of [ultimate, pro, free] as TierSlice[]) {
    const tier = slice.tier;
    const ttl = TIER_TTL_SEC[tier] + ttlJitterSec();
    const payload = JSON.stringify(slice);
    pipeline.set(tierScanKey(tier, symbol, ts), payload, "EX", ttl);
    pipeline.set(tierLatestKey(tier, symbol), payload, "EX", ttl);
  }

  await pipeline.exec();
}

// --- Reads (per-tier only) ---------------------------------------------------

/** Narrows a parsed value to the slice shape for the requested tier. */
function parseSlice(tier: Tier, raw: string | null): TierSlice | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as TierSlice;
    // Guard against reading a mismatched tier under a bad key.
    if (parsed.tier !== tier) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Reads the latest slice for a single symbol on the caller's tier. Reads only
 * that tier's `:latest` pointer — never recomputes and never crosses tiers.
 */
export async function readTierSlice(
  tier: Tier,
  symbol: string,
): Promise<TierSlice | null> {
  if (!redis) return null;
  const raw = await redis.get(tierLatestKey(tier, symbol));
  return parseSlice(tier, raw);
}

/**
 * Reads the latest slices for many symbols on a single tier via one MGET over
 * the `:latest` pointers. Preserves input order; skips missing/malformed
 * entries. Returns an empty array when Redis is unavailable or no symbols are
 * requested.
 */
export async function readTierSlices(
  tier: Tier,
  symbols: string[],
): Promise<TierSlice[]> {
  if (!redis || symbols.length === 0) return [];
  const keys = symbols.map((symbol) => tierLatestKey(tier, symbol));
  const raws = await redis.mget(keys);
  const out: TierSlice[] = [];
  for (const raw of raws) {
    const slice = parseSlice(tier, raw);
    if (slice) out.push(slice);
  }
  return out;
}
