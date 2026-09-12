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
import {
  computeRiskReward,
  generateAnalysis,
  ruleBasedAnalysis,
  type AIAnalysisOutput,
  type AIAnalysisResult,
  type AnalysisContext,
} from "@/lib/ai/analyzer";
import {
  publishAiAnalysis,
  readProAnalysis,
  saveFreeBroadcast,
  saveProAnalysis,
  type FreeBroadcastPayload,
  type StoredAnalysis,
} from "@/lib/ai/store";
import { persistCandidate } from "@/lib/market/persistence";
import { computeUsdLevels, DEFAULT_RR_REWARD } from "@/lib/ai/risk";

/** Pro AI analysis fires at or above this pattern score. */
export const PRO_SCORE_THRESHOLD = 80;

/** How many market-wide picks the Free broadcast includes. */
export const FREE_BROADCAST_TOP_N = 2;

/** Free broadcast cadence (aligned to 15m candle close). */
const FREE_CYCLE_MS = 15 * 60 * 1000;
/** Cooldown between Pro analyses for the same symbol/interval (avoid churn). */
const PRO_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Total wall-clock budget for a single tick's AI enrichment (Req 5.1). Kept
 * comfortably under the 60s tick so the numeric path always resolves inside the
 * minute even under LLM slowness. Each per-symbol call is additionally bounded
 * by `generateWithBudget`'s own `budgetMs`.
 */
export const AI_TICK_BUDGET_MS = 45_000;

/**
 * Per-symbol AI budget used by the degraded path (Req 5.2). If a single call
 * exceeds this, we reuse the prior cached rationale and refresh only numerics.
 * Slightly above the analyzer's per-model `AI_TIMEOUT_MS` (15s) so a single
 * healthy model attempt can complete before we degrade.
 */
export const AI_SYMBOL_BUDGET_MS = 18_000;

/**
 * Max concurrent AI analyses per tick so one tick's calls can't pile up into
 * the next. Mirrors the scan's `CONCURRENCY = 12` bounded-dispatch style.
 */
export const AI_CONCURRENCY = 12;

// --- Bounded dispatch (manual p-limit) --------------------------------------

/**
 * Runs `fn` over `items` with at most `limit` in flight at once. A tiny
 * p-limit-style helper (mirrors the scan's cursor+workers pattern) so AI
 * dispatch for a tick stays bounded without pulling in a dependency. Results
 * are returned in input order. `fn` is expected not to throw (the AI paths
 * never do); if it does, the rejection propagates.
 */
export async function runBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

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

// --- Budgeted AI dispatch + degraded path -----------------------------------

/**
 * Sentinel resolved by the budget timer so we can distinguish "timed out" from
 * "the analysis resolved" without racing a rejection.
 */
const BUDGET_TIMEOUT = Symbol("ai-budget-timeout");

/**
 * Rebuilds the numeric PRICE levels (entry zone / stop / TP ladder) for a
 * candidate from the CURRENT price using a neutral *default profile*, exactly
 * as `ruleBasedAnalysis` does. The cache slice is user-agnostic — per-user USD
 * TP/SL are computed at read time — so leverage/balance here are placeholders
 * and the USD figures `computeUsdLevels` also returns are intentionally
 * discarded. Only the balance-independent price levels are kept.
 */
function refreshNumericLevels(ctx: AnalysisContext): Pick<
  AIAnalysisOutput,
  "entryRange" | "stopLoss" | "takeProfitLevels"
> {
  const c = ctx.candidate;
  const levels = computeUsdLevels({
    entryPrice: c.price,
    direction: c.direction,
    atrRatioPct: c.atrRatioPct,
    leverage: 1,
    rrReward: DEFAULT_RR_REWARD,
    balanceUsd: 1,
  });
  return {
    entryRange: levels.entryZone,
    stopLoss: levels.stopLossPrice,
    takeProfitLevels: [levels.tp1Price, levels.tp2Price],
  };
}

/**
 * Builds the degraded-path result (Req 5.2). Reuses the previous cached
 * analysis' rationale (`summary` / `keyFactors` / `sentiment` / `riskLevel`)
 * and refreshes ONLY the numeric price fields from the current candidate price.
 * Marks `source: "degraded"`.
 */
function toDegradedResult(
  ctx: AnalysisContext,
  prior: StoredAnalysis,
): AIAnalysisResult {
  const numeric = refreshNumericLevels(ctx);
  const output: AIAnalysisOutput = {
    // Reused rationale from the prior cached analysis.
    sentiment: prior.ai.sentiment,
    summary: prior.ai.summary,
    riskLevel: prior.ai.riskLevel,
    keyFactors: prior.ai.keyFactors,
    // Refreshed numerics from the current price.
    entryRange: numeric.entryRange,
    stopLoss: numeric.stopLoss,
    takeProfitLevels: numeric.takeProfitLevels,
  };
  return {
    output,
    source: "degraded",
    model: prior.model,
    riskRewardRatio: computeRiskReward(output),
    latencyMs: 0,
  };
}

/**
 * Generates an analysis bounded by a per-symbol time budget (Req 5.1/5.2/5.3).
 *
 * Races `generateAnalysis(ctx)` against a `budgetMs` timer:
 *   • If the analysis resolves first, that result is returned as-is (LLM or
 *     rule-based fallback — `generateAnalysis` already never throws).
 *   • On timeout → the **degraded path**: load the previous cached analysis for
 *     this symbol/interval (`readProAnalysis`), keep its rationale, and refresh
 *     only the numeric price fields from the current price. `source:
 *     "degraded"`.
 *   • If there is NO previous cached analysis to reuse, we cannot degrade, so we
 *     fall back to the deterministic `ruleBasedAnalysis` result (`source` stays
 *     `"fallback"`). The in-flight LLM call is left to settle/abort on its own
 *     (its own `AI_TIMEOUT_MS` bounds it); we simply stop waiting on it.
 *
 * Never throws (Req 5.3): every branch resolves to a valid `AIAnalysisResult`.
 */
export async function generateWithBudget(
  ctx: AnalysisContext,
  budgetMs = AI_SYMBOL_BUDGET_MS,
): Promise<AIAnalysisResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<typeof BUDGET_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(BUDGET_TIMEOUT), budgetMs);
  });

  try {
    // `generateAnalysis` never throws, but guard defensively so the budget race
    // can never reject and this function can honour its no-throw contract.
    const analysis = generateAnalysis(ctx).catch(
      (): AIAnalysisResult => degradedOrFallback(ctx, null),
    );

    const winner = await Promise.race([analysis, budget]);
    if (winner !== BUDGET_TIMEOUT) {
      return winner;
    }

    // Timed out — attempt the degraded path from the prior cached analysis.
    const prior = await readPriorAnalysisSafe(
      ctx.candidate.symbol,
      ctx.interval ?? ctx.candidate.interval,
    );
    return degradedOrFallback(ctx, prior);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Reads the prior cached analysis without throwing (Redis outages must not
 * break the degraded path); returns null on any error.
 */
async function readPriorAnalysisSafe(
  symbol: string,
  interval: StoredAnalysis["interval"],
): Promise<StoredAnalysis | null> {
  try {
    return await readProAnalysis(symbol, interval);
  } catch {
    return null;
  }
}

/**
 * Degraded path when a prior analysis exists, else the deterministic
 * rule-based fallback (the last resort — Req 5.3). Never throws.
 */
function degradedOrFallback(
  ctx: AnalysisContext,
  prior: StoredAnalysis | null,
): AIAnalysisResult {
  if (prior) return toDegradedResult(ctx, prior);
  const output = ruleBasedAnalysis(ctx);
  return {
    output,
    source: "fallback",
    model: "rule-based",
    riskRewardRatio: computeRiskReward(output),
    latencyMs: 0,
    error: "AI budget exceeded and no prior cached analysis to reuse",
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
