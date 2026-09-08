// ---------------------------------------------------------------------------
// AI orchestration layer (Phase 3).
//
// Sits between the streaming worker and the AI service, encapsulating the
// tiered dispatch rules so the worker stays thin and the test script can drive
// the exact same logic against simulated data:
//
//   • Free tier  — on 15m candle close, exactly ONE "cycle leader" run picks
//     the top 1-2 highest-scoring candidates market-wide, runs AI on them, and
//     caches the shared broadcast (`analysis:broadcast:free:15m`). Every Free
//     user reads that identical cached payload — zero on-demand LLM calls.
//
//   • Pro tier   — any candidate whose score >= PRO_SCORE_THRESHOLD triggers a
//     per-symbol/interval AI analysis, cached at `analysis:latest:{symbol}:{iv}`,
//     persisted to Postgres, and published on `market:ai:analysis`.
//
// Rate/cost controls: the Free broadcast runs at most once per 15m window; Pro
// generation is gated by score, both bounded further by a per-key cooldown so a
// flapping candidate can't hammer the LLM.
// ---------------------------------------------------------------------------

import { redis } from "@/lib/redis";
import type {
  AnalysisCandidate,
  IndicatorSnapshot,
  Interval,
  MarketRegime,
} from "@/lib/market/types";
import { generateAnalysis } from "@/lib/ai/analyzer";
import {
  publishAiAnalysis,
  saveFreeBroadcast,
  saveProAnalysis,
  type FreeBroadcastPayload,
  type StoredAnalysis,
} from "@/lib/ai/store";
import { persistCandidate } from "@/lib/market/persistence";

/** Pro AI analysis fires at or above this pattern score. */
export const PRO_SCORE_THRESHOLD = 80;

/** How many market-wide picks the Free broadcast includes. */
export const FREE_BROADCAST_TOP_N = 2;

/** Free broadcast cadence (aligned to 15m candle close). */
const FREE_CYCLE_MS = 15 * 60 * 1000;
/** Cooldown between Pro analyses for the same symbol/interval (avoid churn). */
const PRO_COOLDOWN_MS = 5 * 60 * 1000;

// --- Cycle-leader election (Free tier) --------------------------------------

/**
 * Elects a single "cycle leader" per 15m window using a Redis SET NX lock keyed
 * to the window bucket. Only the first worker/candle-close in a window wins,
 * guaranteeing exactly one Free broadcast even with multiple worker replicas.
 *
 * Falls back to an in-process guard when Redis is unavailable so a single-node
 * setup still runs at most once per window.
 */
let localCycleBucket = -1;

export async function claimFreeCycleLeader(now = Date.now()): Promise<boolean> {
  const bucket = Math.floor(now / FREE_CYCLE_MS);

  if (!redis) {
    if (localCycleBucket === bucket) return false;
    localCycleBucket = bucket;
    return true;
  }

  const lockKey = `analysis:broadcast:free:lock:${bucket}`;
  // NX + short TTL: first caller in the window wins; lock self-expires.
  const res = await redis.set(lockKey, "1", "EX", 16 * 60, "NX");
  return res === "OK";
}

// --- Pro cooldown ------------------------------------------------------------

const localProCooldown = new Map<string, number>();

async function withinProCooldown(
  symbol: string,
  interval: Interval,
  now: number,
): Promise<boolean> {
  const key = `analysis:cooldown:${symbol}:${interval}`;
  if (!redis) {
    const last = localProCooldown.get(key) ?? 0;
    if (now - last < PRO_COOLDOWN_MS) return true;
    localProCooldown.set(key, now);
    return false;
  }
  // SET NX with cooldown TTL: present => still cooling down.
  const res = await redis.set(key, "1", "PX", PRO_COOLDOWN_MS, "NX");
  return res !== "OK";
}

// --- Mapping helpers ---------------------------------------------------------

function toStoredAnalysis(
  candidate: AnalysisCandidate,
  result: Awaited<ReturnType<typeof generateAnalysis>>,
  now: number,
): StoredAnalysis {
  return {
    symbol: candidate.symbol,
    interval: candidate.interval,
    direction: candidate.direction,
    pattern: candidate.patternType,
    score: candidate.score,
    price: candidate.price,
    ai: result.output,
    riskRewardRatio: result.riskRewardRatio,
    source: result.source,
    model: result.model,
    generatedAt: now,
  };
}

// --- Free tier: broadcast generation ----------------------------------------

export interface FreeBroadcastInput {
  /** All candidates detected in the current 15m snapshot (any interval). */
  candidates: AnalysisCandidate[];
  regime?: MarketRegime;
  now?: number;
}

/**
 * Generates the Free broadcast from the top candidates and caches it. Returns
 * the payload (or null if there were no candidates to analyze). Caller must
 * have already won cycle-leadership via `claimFreeCycleLeader`.
 */
export async function generateFreeBroadcast(
  input: FreeBroadcastInput,
): Promise<FreeBroadcastPayload | null> {
  const now = input.now ?? Date.now();

  // Free tier is 15m-only: restrict picks to 15m candidates, best score first.
  const picks = input.candidates
    .filter((c) => c.interval === "15m" && !c.isExhausted)
    .sort((a, b) => b.score - a.score)
    .slice(0, FREE_BROADCAST_TOP_N);

  if (picks.length === 0) return null;

  const analyses: StoredAnalysis[] = [];
  for (const candidate of picks) {
    const result = await generateAnalysis({ candidate, regime: input.regime });
    analyses.push(toStoredAnalysis(candidate, result, now));
  }

  const payload: FreeBroadcastPayload = {
    tier: "free",
    interval: "15m",
    generatedAt: now,
    analyses,
  };

  await saveFreeBroadcast(payload);
  return payload;
}

// --- Pro tier: per-candidate generation -------------------------------------

export interface ProAnalysisInput {
  candidate: AnalysisCandidate;
  indicators: IndicatorSnapshot;
  regime?: MarketRegime;
  now?: number;
  /** Skip the cooldown gate (used by the test script for determinism). */
  ignoreCooldown?: boolean;
  /** Skip Postgres persistence (used by tests without a DB). */
  skipPersist?: boolean;
}

export interface ProAnalysisResult {
  generated: boolean;
  reason?: "below-threshold" | "cooldown";
  analysis?: StoredAnalysis;
}

/**
 * Runs Pro-tier AI analysis for a single candidate when it clears the score
 * threshold (and isn't cooling down). Caches to Redis, publishes on Pub/Sub,
 * and persists to Postgres. Never throws — AI failures fall back internally.
 */
export async function generateProAnalysis(
  input: ProAnalysisInput,
): Promise<ProAnalysisResult> {
  const { candidate, indicators, regime } = input;
  const now = input.now ?? Date.now();

  if (candidate.score < PRO_SCORE_THRESHOLD) {
    return { generated: false, reason: "below-threshold" };
  }

  if (!input.ignoreCooldown) {
    const cooling = await withinProCooldown(
      candidate.symbol,
      candidate.interval,
      now,
    );
    if (cooling) return { generated: false, reason: "cooldown" };
  }

  const result = await generateAnalysis({ candidate, regime });
  const stored = toStoredAnalysis(candidate, result, now);

  // Cache + fan-out for real-time Pro consumers.
  await saveProAnalysis(stored);
  await publishAiAnalysis(stored);

  // Historical record in Postgres (fire-and-forget; never blocks the loop).
  if (!input.skipPersist) {
    void persistCandidate(candidate, indicators, {
      patternScore: candidate.score,
      riskRewardRatio: result.riskRewardRatio,
      entryPrice: result.output.entryRange[0],
      stopLoss: result.output.stopLoss,
      takeProfit1: result.output.takeProfitLevels[0] ?? null,
      takeProfit2: result.output.takeProfitLevels[1] ?? null,
      isProOnly: true,
    });
  }

  return { generated: true, analysis: stored };
}
