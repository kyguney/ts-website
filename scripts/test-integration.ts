// ---------------------------------------------------------------------------
// Integration tests for the tiered-scan-caching spec (Task 17).
//
// This project has no formal test framework; it runs standalone `tsx` scripts
// (see scripts/test-unit.ts, scripts/test-engine.ts). This file reuses the same
// tiny assert-harness style as test-unit.ts.
//
// These are "integration" tests but MUST NOT require a live external
// Redis/Binance to pass in CI-less environments. The Redis-dependent
// assertions run only when Redis is actually REACHABLE (we probe it with a
// short-lived, bounded connection — merely having REDIS_URL set is not enough
// because the configured instance may be down). When Redis is unreachable, the
// Redis-dependent groups print a clear "SKIPPED (no reachable Redis)" note and
// the pure-logic assertions still run so the script stays meaningful. The
// process always exits 0 unless a real assertion fails.
//
// Coverage:
//   1. Tier cache key/TTL logic + writeTierSlices/readTierSlices round-trip
//      (src/lib/market/tier-cache.ts)                        — Req 3.6, 3.4
//   2. Distributed 1m lock primitive semantics the worker relies on
//      (SET scan:lock:1m <id> NX PX ...)                      — Req 2.3, 2.4
//   3. Degraded path: generateWithBudget reuses prior rationale and refreshes
//      numerics on a simulated (tiny-budget) AI timeout
//      (src/lib/ai/orchestrator.ts)                           — Req 5.2
//
// Usage:  npm run test:integration
// ---------------------------------------------------------------------------

import "dotenv/config";

import Redis from "ioredis";

import {
  TIER_TTL_SEC,
  TTL_JITTER_MAX_SEC,
  tierScanKey,
  tierLatestKey,
  writeTierSlices,
  readTierSlices,
  readTierSlice,
  type FullTierSlice,
  type FreeTierSlice,
  type TierSlices,
} from "@/lib/market/tier-cache";
import { generateWithBudget } from "@/lib/ai/orchestrator";
import { redis as sharedRedis } from "@/lib/redis";
import { saveProAnalysis, proAnalysisKey, type StoredAnalysis } from "@/lib/ai/store";
import {
  computeUsdLevels,
  DEFAULT_RR_REWARD,
} from "@/lib/ai/risk";
import type { AnalysisContext, AIAnalysisOutput } from "@/lib/ai/analyzer";
import type {
  AnalysisCandidate,
  IndicatorSnapshot,
  Interval,
} from "@/lib/market/types";

// --- Minimal test harness (mirrors scripts/test-unit.ts) --------------------

let passed = 0;
let failed = 0;
let skipped = 0;
const failures: string[] = [];

const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

function ok(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ${c.green("✓")} ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  ${c.red("✗")} ${msg}`);
  }
}

function skip(msg: string): void {
  skipped++;
  console.log(`  ${c.yellow("○")} ${c.dim("SKIPPED")} ${msg}`);
}

function approx(actual: number, expected: number, eps = 1e-6): boolean {
  return Math.abs(actual - expected) <= eps;
}

function assertEqual(actual: unknown, expected: unknown, msg: string): void {
  ok(actual === expected, `${msg} (expected ${String(expected)}, got ${String(actual)})`);
}

function assertApprox(actual: number, expected: number, msg: string, eps = 1e-6): void {
  ok(approx(actual, expected, eps), `${msg} (expected ≈${expected}, got ${actual})`);
}

function section(title: string): void {
  console.log(`\n${c.cyan(c.bold(title))}`);
}

// --- Redis reachability probe -----------------------------------------------
//
// Merely having REDIS_URL set is not sufficient — the configured instance may
// be down. We open a short-lived, bounded connection just to PING it. If the
// probe succeeds we return a live client (reused for cleanup); otherwise we
// return null and every Redis-dependent group skips gracefully.

const REDIS_PROBE_TIMEOUT_MS = 3000;

async function probeRedis(): Promise<Redis | null> {
  const url = process.env.REDIS_URL;
  if (!url) return null;

  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: REDIS_PROBE_TIMEOUT_MS,
    // Do not retry forever — a single failed connect means "unreachable" here.
    retryStrategy: () => null,
  });
  // Swallow async connection errors so an unreachable host doesn't crash us.
  client.on("error", () => {});

  try {
    await client.connect();
    const pong = await client.ping();
    if (pong !== "PONG") throw new Error(`unexpected PING reply: ${pong}`);
    return client;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ${c.dim(`(redis probe failed: ${msg})`)}`);
    try {
      client.disconnect();
    } catch {
      /* ignore */
    }
    return null;
  }
}

// --- Fixtures ---------------------------------------------------------------

/** A clearly-namespaced fake symbol so test-key cleanup is always safe. */
const TEST_SYMBOL = "TESTUSDT";

/** Build a complete AnalysisCandidate (every field required by the type). */
function candidate(over: Partial<AnalysisCandidate> = {}): AnalysisCandidate {
  return {
    symbol: TEST_SYMBOL,
    interval: "1m",
    direction: "LONG",
    patternType: "🚀 GOLDEN COILING",
    price: 100,
    change24hPct: 5.5,
    volume24hUsdt: 25_000_000,
    high24h: 110,
    ma7: 99,
    ma25: 97,
    ma99: 95,
    rsi14: 58,
    atrRatioPct: 2,
    volumeSpurtRatio: 2.1,
    coilingSqueezePct: 1.2,
    wickRatioPct: 10,
    hasHighWickRisk: false,
    isVolumeFading: false,
    isExhausted: false,
    isEarlyPumpBonus: false,
    isPreBreakoutSqueeze: true,
    distTo24hHighPct: 3.4,
    distToMa25Pct: 3.0,
    score: 150,
    statusLabel: "TEST",
    ...over,
  };
}

/** Build a complete IndicatorSnapshot. */
function indicators(over: Partial<IndicatorSnapshot> = {}): IndicatorSnapshot {
  return {
    price: 100,
    ma7: 99,
    ma25: 97,
    ma99: 95,
    ema7: 99.5,
    rsi14: 58,
    atr: 2,
    atrRatioPct: 2,
    volumeSpurtRatio: 2.1,
    coilingSqueezePct: 1.2,
    upperWickRatio: 0.1,
    lowerWickRatio: 0.1,
    hasHighWickRisk: false,
    isRedCandle: false,
    ...over,
  };
}

function fullSignal(): FullTierSlice["ai"] {
  return {
    sentiment: "BULLISH",
    summary: "Test full-tier signal",
    entryRange: [99, 100],
    stopLoss: 97,
    takeProfitLevels: [106, 109],
    riskLevel: "MEDIUM",
    keyFactors: ["test factor A", "test factor B"],
  };
}

function reducedSignal(): FreeTierSlice["ai"] {
  return {
    sentiment: "BULLISH",
    summary: "Test reduced free signal",
    entryRange: [99, 100],
    stopLoss: 97,
    takeProfit: 106,
    riskLevel: "MEDIUM",
  };
}

/** Fabricate the three tier slices for a fake symbol at a boundary `ts`. */
function fabricateSlices(ts: number): TierSlices {
  const ultimate: FullTierSlice = {
    tier: "ultimate",
    symbol: TEST_SYMBOL,
    interval: "1m",
    ts,
    candidate: candidate({ interval: "1m" }),
    indicators: indicators(),
    ai: fullSignal(),
  };
  const pro: FullTierSlice = {
    tier: "pro",
    symbol: TEST_SYMBOL,
    interval: "5m",
    ts,
    candidate: candidate({ interval: "5m" }),
    indicators: indicators(),
    ai: fullSignal(),
  };
  const free: FreeTierSlice = {
    tier: "free",
    symbol: TEST_SYMBOL,
    interval: "15m",
    ts,
    candidate: candidate({ interval: "15m" }),
    indicators: indicators(),
    ai: reducedSignal(),
  };
  return { symbol: TEST_SYMBOL, ts, ultimate, pro, free };
}

// --- 1. Tier cache key/TTL logic + round-trip -------------------------------

async function testTierCache(probe: Redis | null): Promise<void> {
  section("Tier cache keys / TTLs / round-trip (Req 3.6, 3.4)");

  // Pure key-shape assertions (always run — no Redis needed).
  assertEqual(
    tierScanKey("free", TEST_SYMBOL, 1700),
    `scan:free:${TEST_SYMBOL}:1700`,
    "tierScanKey(free) → scan:free:{symbol}:{ts}",
  );
  assertEqual(
    tierScanKey("pro", TEST_SYMBOL, 1700),
    `scan:pro:${TEST_SYMBOL}:1700`,
    "tierScanKey(pro) → scan:pro:{symbol}:{ts}",
  );
  assertEqual(
    tierScanKey("ultimate", TEST_SYMBOL, 1700),
    `scan:ultimate:${TEST_SYMBOL}:1700`,
    "tierScanKey(ultimate) → scan:ultimate:{symbol}:{ts}",
  );
  assertEqual(
    tierLatestKey("free", TEST_SYMBOL),
    `scan:free:${TEST_SYMBOL}:latest`,
    "tierLatestKey(free) → scan:free:{symbol}:latest",
  );
  assertEqual(
    tierLatestKey("ultimate", TEST_SYMBOL),
    `scan:ultimate:${TEST_SYMBOL}:latest`,
    "tierLatestKey(ultimate) → scan:ultimate:{symbol}:latest",
  );

  // Pure TTL assertions (always run — Req 3.4 base values).
  assertEqual(TIER_TTL_SEC.ultimate, 90, "TIER_TTL_SEC.ultimate = 90");
  assertEqual(TIER_TTL_SEC.pro, 360, "TIER_TTL_SEC.pro = 360");
  assertEqual(TIER_TTL_SEC.free, 960, "TIER_TTL_SEC.free = 960");
  ok(TIER_TTL_SEC.ultimate >= 60, "ultimate TTL ≥ scan interval (60s) [Req 3.4]");
  ok(TIER_TTL_SEC.pro >= 300, "pro TTL ≥ 5m slice interval [Req 3.4]");
  ok(TIER_TTL_SEC.free >= 900, "free TTL ≥ 15m slice interval [Req 3.4]");

  if (!probe) {
    skip("writeTierSlices/readTierSlices round-trip + TTL/keyspace assertions (no reachable Redis)");
    return;
  }

  // Redis-backed: the source modules use the shared @/lib/redis singleton, so
  // writeTierSlices/readTierSlices operate on the same instance we probed.
  const ts = Date.now();
  const slices = fabricateSlices(ts);

  // Clean any stale test keys up front (defensive).
  await cleanupTestKeys(probe);

  try {
    await writeTierSlices(slices);

    // scan:free:*, scan:pro:*, scan:ultimate:* keys exist (Req 3.6).
    const freeKeys = await probe.keys(`scan:free:${TEST_SYMBOL}:*`);
    const proKeys = await probe.keys(`scan:pro:${TEST_SYMBOL}:*`);
    const ultKeys = await probe.keys(`scan:ultimate:${TEST_SYMBOL}:*`);
    ok(freeKeys.length >= 2, `scan:free:${TEST_SYMBOL}:* keys exist (${freeKeys.length}) [Req 3.6]`);
    ok(proKeys.length >= 2, `scan:pro:${TEST_SYMBOL}:* keys exist (${proKeys.length}) [Req 3.6]`);
    ok(ultKeys.length >= 2, `scan:ultimate:${TEST_SYMBOL}:* keys exist (${ultKeys.length}) [Req 3.6]`);

    // The :{ts} history keys and :latest pointers both exist per tier.
    for (const tier of ["free", "pro", "ultimate"] as const) {
      const tsExists = await probe.exists(tierScanKey(tier, TEST_SYMBOL, ts));
      const latestExists = await probe.exists(tierLatestKey(tier, TEST_SYMBOL));
      assertEqual(tsExists, 1, `${tier}: scan:${tier}:${TEST_SYMBOL}:${ts} exists`);
      assertEqual(latestExists, 1, `${tier}: :latest pointer exists`);
    }

    // TTLs are within [base, base + jitter] for each tier (Req 3.4).
    for (const tier of ["free", "pro", "ultimate"] as const) {
      const base = TIER_TTL_SEC[tier];
      const ttlTs = await probe.ttl(tierScanKey(tier, TEST_SYMBOL, ts));
      const ttlLatest = await probe.ttl(tierLatestKey(tier, TEST_SYMBOL));
      ok(
        ttlTs >= 1 && ttlTs <= base + TTL_JITTER_MAX_SEC,
        `${tier}: :{ts} TTL in [1, ${base + TTL_JITTER_MAX_SEC}] (got ${ttlTs})`,
      );
      ok(
        ttlLatest >= 1 && ttlLatest <= base + TTL_JITTER_MAX_SEC,
        `${tier}: :latest TTL in [1, ${base + TTL_JITTER_MAX_SEC}] (got ${ttlLatest})`,
      );
    }

    // readTierSlices returns the written slice for each tier (Req 3.6).
    const ultRead = await readTierSlices("ultimate", [TEST_SYMBOL]);
    ok(ultRead.length === 1 && ultRead[0].tier === "ultimate", "readTierSlices(ultimate) returns 1 ultimate slice");
    ok(ultRead[0]?.candidate.symbol === TEST_SYMBOL, "ultimate slice carries the written candidate");
    ok(ultRead[0]?.interval === "1m", "ultimate slice interval = 1m");

    const proRead = await readTierSlice("pro", TEST_SYMBOL);
    ok(proRead?.tier === "pro" && proRead.interval === "5m", "readTierSlice(pro) returns 5m pro slice");

    const freeRead = await readTierSlice("free", TEST_SYMBOL);
    ok(freeRead?.tier === "free" && freeRead.interval === "15m", "readTierSlice(free) returns 15m free slice");
    // Free slice carries the reduced signal (single takeProfit, no ladder).
    ok(
      !!freeRead && "takeProfit" in freeRead.ai && !("takeProfitLevels" in freeRead.ai),
      "free slice carries the reduced signal (takeProfit, no ladder)",
    );

    // Cross-tier isolation: reading a tier never returns another tier's slice.
    const noneForBadTier = await readTierSlices("pro", ["NON_EXISTENT_SYM"]);
    assertEqual(noneForBadTier.length, 0, "readTierSlices returns [] for an unknown symbol");
  } finally {
    await cleanupTestKeys(probe);
  }
}

// --- 2. Distributed 1m lock primitive (Req 2.3, 2.4) ------------------------
//
// The lock itself lives inside a private worker method (run1mScanPass) and is
// not importable. Rather than reaching into worker internals, we test the LOCK
// PRIMITIVE the worker relies on directly against Redis, exactly as the worker
// uses it: SET scan:lock:1m <id> NX PX 55000.

const LOCK_KEY = "scan:lock:1m";
const LOCK_PX_MS = 55_000;

/**
 * Pure re-entry helper mirroring the worker's try/catch/finally lock usage: run
 * `fn` (which may throw) while holding a lock, always releasing in `finally`.
 * Returns whether the lock was acquired and whether `fn` threw. Used to prove
 * "a thrown tick doesn't block the next" at the semantic level (Req 2.4).
 */
async function withLock(
  client: Redis,
  id: string,
  fn: () => void | Promise<void>,
): Promise<{ acquired: boolean; threw: boolean }> {
  const res = await client.set(LOCK_KEY, id, "PX", LOCK_PX_MS, "NX");
  if (res !== "OK") return { acquired: false, threw: false };
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  } finally {
    // Release only if we still hold it (best-effort; matches worker DEL).
    await client.del(LOCK_KEY);
  }
  return { acquired: true, threw };
}

async function testDistributedLock(probe: Redis | null): Promise<void> {
  section("Distributed 1m lock primitive (Req 2.3, 2.4)");

  // Pure semantic test (always runs): a throwing tick still releases the lock
  // via finally, so the next tick can re-enter. This is the in-memory analogue
  // of "a thrown tick doesn't block the next" (Req 2.4).
  {
    let held = false;
    let reentries = 0;
    const fakeRun = async (shouldThrow: boolean): Promise<boolean> => {
      if (held) return false; // simulated NX: can't acquire while held
      held = true;
      try {
        reentries++;
        if (shouldThrow) throw new Error("simulated tick failure");
      } finally {
        held = false; // release in finally
      }
      return true;
    };
    let firstThrew = false;
    try {
      await fakeRun(true);
    } catch {
      firstThrew = true;
    }
    // The throwing run releases; a second run must be able to acquire+complete.
    const second = await fakeRun(false).catch(() => false);
    ok(firstThrew, "pure: a throwing tick propagates (then releases in finally)");
    ok(second === true, "pure: next tick re-acquires after a thrown tick [Req 2.4]");
    assertEqual(reentries, 2, "pure: both ticks entered the critical section");
  }

  if (!probe) {
    skip("Redis lock NX/DEL/expiry semantics (no reachable Redis)");
    return;
  }

  // Ensure a clean lock slot.
  await probe.del(LOCK_KEY);

  try {
    // (a) First NX SET succeeds (lock acquired).
    const first = await probe.set(LOCK_KEY, "holder-1", "PX", LOCK_PX_MS, "NX");
    assertEqual(first, "OK", "first SET NX acquires scan:lock:1m [Req 2.3]");

    // (b) A second NX SET fails while the lock is held (overlap prevented).
    const second = await probe.set(LOCK_KEY, "holder-2", "PX", LOCK_PX_MS, "NX");
    assertEqual(second, null, "second SET NX fails while held → no overlapping tick [Req 2.3]");

    // The holder id is unchanged (holder-2 did not clobber holder-1).
    const owner = await probe.get(LOCK_KEY);
    assertEqual(owner, "holder-1", "lock still owned by the original holder");

    // A positive PX TTL is set so a crashed holder self-heals.
    const pttl = await probe.pttl(LOCK_KEY);
    ok(pttl > 0 && pttl <= LOCK_PX_MS, `lock TTL in (0, ${LOCK_PX_MS}] (got ${pttl}ms)`);

    // (c) After release (DEL), the lock can be re-acquired — proves a
    // finished/failed tick doesn't block the next (Req 2.4).
    await probe.del(LOCK_KEY);
    const reacquired = await probe.set(LOCK_KEY, "holder-3", "PX", LOCK_PX_MS, "NX");
    assertEqual(reacquired, "OK", "after DEL, lock re-acquired → next tick can run [Req 2.4]");
    await probe.del(LOCK_KEY);

    // (d) Full try/catch/finally simulation against real Redis: a throwing tick
    // releases the lock so the next acquires — the exact worker guarantee.
    const t1 = await withLock(probe, "tick-1", () => {
      throw new Error("boom during tick 1");
    });
    ok(t1.acquired && t1.threw, "withLock: tick-1 acquired and threw");
    const t2 = await withLock(probe, "tick-2", () => {
      /* healthy tick */
    });
    ok(t2.acquired && !t2.threw, "withLock: tick-2 re-acquired after thrown tick-1 [Req 2.4]");
  } finally {
    await probe.del(LOCK_KEY);
  }
}

// --- 3. Degraded path (Req 5.2) ---------------------------------------------
//
// generateWithBudget races generateAnalysis(ctx) against a budget timer; on
// timeout it takes the degraded path. To force the timer to win DETERMINISTICALLY
// and OFFLINE we must make generateAnalysis take longer than the budget:
//
//   • If AI is UNconfigured, generateAnalysis resolves the rule-based fallback
//     on the microtask queue — which always beats any setTimeout, so a tiny
//     budget can NOT force the degraded path. (That is exactly what an early
//     version of this test hit: budget=1 returned "fallback", not "degraded".)
//   • So for the degraded-with-prior branch we set a fake AI key AND stub
//     global fetch with a promise that resolves AFTER the budget. `callGemini`
//     then awaits real network I/O (our stub), the budget timer wins the race,
//     and the degraded path runs — all without touching a real LLM. The stub is
//     restored afterwards.
//
// Two branches, guarded by Redis:
//   (a) With Redis: seed a prior StoredAnalysis via saveProAnalysis, then
//       assert the degraded result reuses the prior rationale and refreshes the
//       numeric fields (matching computeUsdLevels for the current price).
//   (b) No prior: generateWithBudget must fall back to source="fallback" with
//       valid rule-based numerics and never throw.

/** Neutral default-profile levels used by the degraded/fallback numeric refresh. */
function expectedDefaultLevels(cand: AnalysisCandidate) {
  return computeUsdLevels({
    entryPrice: cand.price,
    direction: cand.direction,
    atrRatioPct: cand.atrRatioPct,
    leverage: 1,
    rrReward: DEFAULT_RR_REWARD,
    balanceUsd: 1,
  });
}

/**
 * Installs a deterministic, OFFLINE slow-LLM stub: a fake AI key + a global
 * `fetch` replacement that resolves only after `delayMs`. With this in place
 * `generateAnalysis` awaits our stub (never a real network), so a budget timer
 * shorter than `delayMs` is guaranteed to win the race and trigger the degraded
 * path. Returns a restore function.
 */
function installSlowLlmStub(delayMs: number): () => void {
  const prevKey = process.env.AI_API_KEY;
  const prevGemini = process.env.GEMINI_API_KEY;
  const prevFetch = globalThis.fetch;

  process.env.AI_API_KEY = "test-fake-key-offline";
  delete process.env.GEMINI_API_KEY;

  // A fetch that never reaches the network and resolves slowly. Its body is
  // irrelevant: the budget timer wins long before it settles.
  globalThis.fetch = ((): Promise<Response> =>
    new Promise<Response>((resolve) => {
      setTimeout(() => {
        resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
      }, delayMs);
    })) as typeof fetch;

  return () => {
    globalThis.fetch = prevFetch;
    if (prevKey !== undefined) process.env.AI_API_KEY = prevKey;
    else delete process.env.AI_API_KEY;
    if (prevGemini !== undefined) process.env.GEMINI_API_KEY = prevGemini;
    else delete process.env.GEMINI_API_KEY;
  };
}

async function testDegradedPath(probe: Redis | null): Promise<void> {
  section("Degraded path: generateWithBudget on simulated timeout (Req 5.2)");

  const cand = candidate({ interval: "1m", price: 100, atrRatioPct: 2, direction: "LONG" });
  const ctx: AnalysisContext = { candidate: cand, interval: "1m" };
  const expected = expectedDefaultLevels(cand);

  // (a) Degraded-with-prior branch — requires Redis to seed the prior.
  if (probe) {
    // Seed a prior cached analysis with a DISTINCTIVE rationale so we can prove
    // it is reused while numerics get refreshed.
    const priorAi: AIAnalysisOutput = {
      sentiment: "BEARISH",
      summary: "PRIOR-RATIONALE-MARKER: reused from the previous tick",
      entryRange: [1, 2], // stale numerics that MUST be replaced
      stopLoss: 3,
      takeProfitLevels: [4, 5],
      riskLevel: "HIGH",
      keyFactors: ["prior factor 1", "prior factor 2"],
    };
    const prior: StoredAnalysis = {
      symbol: cand.symbol,
      interval: "1m",
      direction: cand.direction,
      pattern: cand.patternType,
      score: cand.score,
      price: cand.price,
      ai: priorAi,
      riskRewardRatio: "1:2",
      source: "llm",
      model: "prior-model-x",
      generatedAt: Date.now() - 60_000,
    };

    // Clean any stale prior for this symbol first, then seed.
    await probe.del(proAnalysisKey(cand.symbol, "1m"));
    await saveProAnalysis(prior);

    // Force the timer to win: a fake key + slow (200ms) offline fetch, budget 5ms.
    const restore = installSlowLlmStub(200);
    try {
      const res = await generateWithBudget(ctx, 5);

      assertEqual(res.source, "degraded", "budget < LLM latency + prior → source = degraded [Req 5.2]");
      assertEqual(res.model, "prior-model-x", "degraded reuses the prior model id");
      assertEqual(
        res.output.summary,
        priorAi.summary,
        "degraded reuses the prior summary (rationale)",
      );
      assertEqual(res.output.sentiment, "BEARISH", "degraded reuses the prior sentiment");
      assertEqual(res.output.riskLevel, "HIGH", "degraded reuses the prior riskLevel");
      ok(
        res.output.keyFactors.length === 2 && res.output.keyFactors[0] === "prior factor 1",
        "degraded reuses the prior keyFactors",
      );

      // Numeric fields are REFRESHED from the current price (not the stale prior).
      assertApprox(res.output.entryRange[0], expected.entryZone[0], "degraded entry low refreshed");
      assertApprox(res.output.entryRange[1], expected.entryZone[1], "degraded entry high refreshed");
      assertApprox(res.output.stopLoss, expected.stopLossPrice, "degraded stopLoss refreshed from current price");
      assertApprox(res.output.takeProfitLevels[0], expected.tp1Price, "degraded TP1 refreshed = computeUsdLevels tp1");
      assertApprox(res.output.takeProfitLevels[1], expected.tp2Price, "degraded TP2 refreshed = computeUsdLevels tp2");
      ok(res.output.stopLoss !== priorAi.stopLoss, "degraded numerics differ from the stale prior");
    } finally {
      restore();
      await probe.del(proAnalysisKey(cand.symbol, "1m"));
    }
  } else {
    skip("degraded-with-prior branch (no reachable Redis to seed the prior)");
  }

  // (b) No-prior fallback branch. Ensure no cached prior, keep AI UNconfigured
  // so generateAnalysis resolves the rule-based fallback fast; with no prior to
  // reuse the result must be source="fallback" and must never throw (Req 5.3).
  {
    const prevKey = process.env.AI_API_KEY;
    const prevGemini = process.env.GEMINI_API_KEY;
    delete process.env.AI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    if (probe) {
      await probe.del(proAnalysisKey(cand.symbol, "1m"));
    }
    let threw = false;
    let res2: Awaited<ReturnType<typeof generateWithBudget>> | null = null;
    try {
      res2 = await generateWithBudget(ctx, 1);
    } catch {
      threw = true;
    } finally {
      if (prevKey !== undefined) process.env.AI_API_KEY = prevKey;
      if (prevGemini !== undefined) process.env.GEMINI_API_KEY = prevGemini;
    }
    ok(!threw, "generateWithBudget never throws (Req 5.3)");
    ok(res2 !== null, "generateWithBudget resolves to a result");
    if (res2) {
      assertEqual(res2.source, "fallback", "no prior + unconfigured AI → source = fallback [Req 5.2/5.3]");
      // Valid rule-based numerics (match the default-profile price levels).
      assertApprox(res2.output.stopLoss, expected.stopLossPrice, "fallback stopLoss = rule-based level");
      assertApprox(res2.output.takeProfitLevels[0], expected.tp1Price, "fallback TP1 = rule-based level");
      ok(res2.output.takeProfitLevels.length >= 1, "fallback provides at least one take-profit");
      ok(res2.output.entryRange[0] <= res2.output.entryRange[1], "fallback entry zone is well-ordered");
    }
  }
}

// --- Cleanup ----------------------------------------------------------------

/** Deletes every test key we may have created (safe: TEST_SYMBOL-namespaced). */
async function cleanupTestKeys(client: Redis): Promise<void> {
  const patterns = [
    `scan:free:${TEST_SYMBOL}:*`,
    `scan:pro:${TEST_SYMBOL}:*`,
    `scan:ultimate:${TEST_SYMBOL}:*`,
  ];
  for (const pattern of patterns) {
    const keys = await client.keys(pattern);
    if (keys.length) await client.del(...keys);
  }
  await client.del(proAnalysisKey(TEST_SYMBOL, "1m"));
  await client.del(LOCK_KEY);
}

// --- Runner -----------------------------------------------------------------

async function main(): Promise<void> {
  console.log(c.bold("Running integration tests (tiered-scan-caching / Task 17)\n"));

  const probe = await probeRedis();
  if (probe) {
    console.log(c.green(`Redis: REACHABLE at ${process.env.REDIS_URL} — running Redis-backed assertions.`));
  } else {
    console.log(
      c.yellow(
        "Redis: NOT reachable — Redis-dependent assertions will be SKIPPED (no reachable Redis). " +
          "Pure-logic assertions still run.",
      ),
    );
  }

  try {
    await testTierCache(probe);
    await testDistributedLock(probe);
    await testDegradedPath(probe);
  } finally {
    // Always quit clients so the process can exit (never hang).
    if (probe) {
      try {
        await probe.quit();
      } catch {
        try {
          probe.disconnect();
        } catch {
          /* ignore */
        }
      }
    }
    // The source modules use the shared @/lib/redis singleton; quit it too so a
    // live connection there doesn't keep the event loop alive.
    if (sharedRedis) {
      try {
        await sharedRedis.quit();
      } catch {
        try {
          sharedRedis.disconnect();
        } catch {
          /* ignore */
        }
      }
    }
  }

  const total = passed + failed;
  console.log(
    `\n${c.bold("Summary:")} ${c.green(String(passed) + " passed")}, ` +
      `${failed > 0 ? c.red(String(failed) + " failed") : c.dim("0 failed")}, ` +
      `${skipped > 0 ? c.yellow(String(skipped) + " skipped") : c.dim("0 skipped")} ` +
      `(${total} assertions run)`,
  );

  if (failed > 0) {
    console.log(c.red("\nFailed assertions:"));
    for (const f of failures) console.log(`  ${c.red("•")} ${f}`);
    process.exit(1);
  }
  console.log(c.green("\nAll run assertions passed.\n"));
  // Force a clean exit in case a stray handle lingers (never hang the script).
  process.exit(0);
}

main().catch((err) => {
  console.error(c.red("\nIntegration test runner crashed:"), err);
  process.exit(1);
});
