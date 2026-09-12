// ---------------------------------------------------------------------------
// Redis storage layer for AI analyses (Phase 3).
//
// Two tiers, one channel:
//   • Free broadcast — a single shared payload regenerated every 15m.
//       Key:   analysis:broadcast:free:15m   (TTL 18 min)
//   • Pro latest — the most recent AI analysis per symbol/interval.
//       Key:   analysis:latest:{symbol}:{interval}
//   • Pub/Sub — every Pro analysis is fanned out on `market:ai:analysis`.
//
// All calls reuse the shared ioredis client and degrade gracefully when Redis
// is unavailable (client is null) so the worker/API never crash on an outage.
// ---------------------------------------------------------------------------

import { redis } from "@/lib/redis";
import type { AnalysisCandidate, Interval } from "@/lib/market/types";
import type { AIAnalysisOutput } from "@/lib/ai/analyzer";

// --- Keys & channel ----------------------------------------------------------

export const FREE_BROADCAST_KEY = "analysis:broadcast:free:15m";
/** 18 minutes: outlives the 15m regeneration cadence with a safety margin. */
export const FREE_BROADCAST_TTL_SEC = 18 * 60;

export const AI_ANALYSIS_CHANNEL = "market:ai:analysis";

export function proAnalysisKey(symbol: string, interval: Interval): string {
  return `analysis:latest:${symbol}:${interval}`;
}

// --- Stored payload shapes ---------------------------------------------------

/** A single analyzed item (candidate summary + AI output), tier-agnostic. */
export interface StoredAnalysis {
  symbol: string;
  interval: Interval;
  direction: AnalysisCandidate["direction"];
  pattern: string;
  score: number;
  price: number;
  ai: AIAnalysisOutput;
  riskRewardRatio: string;
  /**
   * Provenance so the UI can badge results:
   *   • "llm"      — live LLM response.
   *   • "fallback" — deterministic rule-based analysis.
   *   • "degraded" — prior cached rationale reused (numeric fields refreshed
   *     because the LLM missed the per-tick budget).
   */
  source: "llm" | "fallback" | "degraded";
  model: string;
  generatedAt: number;
}

/** The Free tier's shared, cached broadcast payload. */
export interface FreeBroadcastPayload {
  tier: "free";
  interval: "15m";
  generatedAt: number;
  /** Top 1-2 market-wide picks. */
  analyses: StoredAnalysis[];
}

// --- Free broadcast ----------------------------------------------------------

/** Caches the Free broadcast payload (shared by all Free users). */
export async function saveFreeBroadcast(
  payload: FreeBroadcastPayload,
): Promise<void> {
  if (!redis) return;
  await redis.set(
    FREE_BROADCAST_KEY,
    JSON.stringify(payload),
    "EX",
    FREE_BROADCAST_TTL_SEC,
  );
}

/** Reads the current Free broadcast payload (null when absent/expired). */
export async function readFreeBroadcast(): Promise<FreeBroadcastPayload | null> {
  if (!redis) return null;
  const raw = await redis.get(FREE_BROADCAST_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FreeBroadcastPayload;
  } catch {
    return null;
  }
}

// --- Pro latest --------------------------------------------------------------

/** Caches the latest Pro analysis for a symbol/interval (no TTL: latest wins). */
export async function saveProAnalysis(analysis: StoredAnalysis): Promise<void> {
  if (!redis) return;
  // Long TTL so stale entries eventually clear if the worker stops streaming
  // a symbol, but well beyond any interval so it stays "latest" in practice.
  await redis.set(
    proAnalysisKey(analysis.symbol, analysis.interval),
    JSON.stringify(analysis),
    "EX",
    24 * 60 * 60,
  );
}

/** Reads a single Pro analysis (null when absent). */
export async function readProAnalysis(
  symbol: string,
  interval: Interval,
): Promise<StoredAnalysis | null> {
  if (!redis) return null;
  const raw = await redis.get(proAnalysisKey(symbol, interval));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredAnalysis;
  } catch {
    return null;
  }
}

/**
 * Reads every cached Pro analysis matching the given intervals, across all
 * tracked symbols. Uses a non-blocking SCAN so it's safe on large keyspaces.
 * Optionally filters to a set of symbols (e.g. a user's favorite pairs).
 */
export async function readProAnalysesByIntervals(
  intervals: Interval[],
  symbols?: string[],
): Promise<StoredAnalysis[]> {
  if (!redis || intervals.length === 0) return [];

  const intervalSet = new Set(intervals);
  const symbolSet = symbols && symbols.length ? new Set(symbols) : null;

  // Collect matching keys via SCAN (cursor-based, avoids blocking KEYS).
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(
      cursor,
      "MATCH",
      "analysis:latest:*",
      "COUNT",
      100,
    );
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");

  if (keys.length === 0) return [];

  const raws = await redis.mget(keys);
  const out: StoredAnalysis[] = [];
  for (const raw of raws) {
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as StoredAnalysis;
      if (!intervalSet.has(parsed.interval)) continue;
      if (symbolSet && !symbolSet.has(parsed.symbol)) continue;
      out.push(parsed);
    } catch {
      // Skip malformed entries.
    }
  }
  // Highest-conviction first.
  out.sort((a, b) => b.score - a.score);
  return out;
}

// --- Pub/Sub -----------------------------------------------------------------

/** Publishes a Pro analysis to the `market:ai:analysis` channel. */
export async function publishAiAnalysis(analysis: StoredAnalysis): Promise<void> {
  if (!redis) return;
  await redis.publish(AI_ANALYSIS_CHANNEL, JSON.stringify(analysis));
}
