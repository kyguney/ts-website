// ---------------------------------------------------------------------------
// E2E acceptance test for the tiered-scan-caching spec (Task 18, Req 7.3/7.4).
//
// The acceptance criterion (Req 7.4): a user with default_leverage=25,
// default_rr_ratio="1:3" → the feed's TP1/TP2/SL (USD) equal an INDEPENDENT
// recompute via `computeUsdLevels`; and changing leverage changes the numbers
// (Req 7.3).
//
// This project has no formal test framework; it runs standalone `tsx` scripts
// (see scripts/test-unit.ts, scripts/test-integration.ts). This file reuses the
// same tiny assert-harness + Redis-reachability-probe style as test-integration.
//
// --- Why this shape (approach taken) ---------------------------------------
//   A true HTTP E2E against the running Next.js server + auth + a seeded DB
//   user is heavy and environment-dependent. The DETERMINISTIC core the feed
//   route performs is the read-time USD math: for every slice it calls
//   `usdForSlice(slice, profile)` → `computeUsdLevels(...)`, with
//     entryPrice = candidate.price (fallback: entryRange midpoint),
//     direction  = candidate.direction,
//     atrRatioPct= candidate.atrRatioPct,
//     leverage   = user's defaultLeverage,
//     rrReward   = parseRrRatio(defaultRrRatio),
//     balanceUsd = demoBalanceForTier(plan).
//
//   Those two helpers (`usdForSlice`, `fullSliceToRow`) plus the `RiskProfile`
//   type were EXTRACTED into `@/lib/ai/feed-usd` by this task (Next.js route
//   files may only export handlers + config fields, so they can't live in
//   route.ts). The feed route imports and runs these EXACT functions, so the
//   E2E drives the REAL read-path code — not a re-implementation. We fabricate a
//   FullTierSlice, build the exact profile a leverage=25 / "1:3" / ultimate user
//   yields, run the real `fullSliceToRow`, and assert `row.usd.{tp1,tp2,sl}Usd`
//   EQUAL an independent `computeUsdLevels(...)` recompute. Then we flip leverage
//   to 50 and assert the USD numbers changed (doubled) — proving Req 7.3.
//
//   ALSO: when Redis is reachable we run a fuller slice-level E2E — write a
//   fabricated ultimate slice for a TESTUSDT symbol via `writeTierSlices`, read
//   it back with the SAME `readTierSlices` the route uses, then run the real
//   `fullSliceToRow` over the read-back slice and assert the same USD identities
//   + leverage sensitivity. Keys are cleaned up afterwards. If Redis is
//   unreachable that portion is SKIPPED with a note; the offline assertions
//   still run so the script stays meaningful.
//
// Usage:  npm run test:e2e
// ---------------------------------------------------------------------------

import "dotenv/config";

import Redis from "ioredis";

import {
  computeUsdLevels,
  parseRrRatio,
} from "@/lib/ai/risk";
import { demoBalanceForTier } from "@/lib/ai/balances";
import {
  writeTierSlices,
  readTierSlices,
  tierScanKey,
  tierLatestKey,
  type FullTierSlice,
  type FreeTierSlice,
  type TierSlices,
} from "@/lib/market/tier-cache";
import {
  fullSliceToRow,
  usdForSlice,
  type RiskProfile,
} from "@/lib/ai/feed-usd";
import { redis as sharedRedis } from "@/lib/redis";
import type { AnalysisCandidate, IndicatorSnapshot } from "@/lib/market/types";

// --- Minimal test harness (mirrors scripts/test-integration.ts) -------------

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

// --- Redis reachability probe (mirrors test-integration.ts) -----------------

const REDIS_PROBE_TIMEOUT_MS = 3000;

async function probeRedis(): Promise<Redis | null> {
  const url = process.env.REDIS_URL;
  if (!url) return null;

  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: REDIS_PROBE_TIMEOUT_MS,
    retryStrategy: () => null,
  });
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

// --- Fixtures (mirror test-integration.ts) ----------------------------------

/** A clearly-namespaced fake symbol so test-key cleanup is always safe. */
const TEST_SYMBOL = "TESTUSDT";

/**
 * A concrete, deterministic entry price for the acceptance case. Chosen so the
 * math is easy to reason about (entry=100, atr=2% → stopDist = 100*0.02*1.5 = 3).
 */
const ENTRY_PRICE = 100;
const ATR_RATIO_PCT = 2;

function candidate(over: Partial<AnalysisCandidate> = {}): AnalysisCandidate {
  return {
    symbol: TEST_SYMBOL,
    interval: "1m",
    direction: "LONG",
    patternType: "🚀 GOLDEN COILING",
    price: ENTRY_PRICE,
    change24hPct: 5.5,
    volume24hUsdt: 25_000_000,
    high24h: 110,
    ma7: 99,
    ma25: 97,
    ma99: 95,
    rsi14: 58,
    atrRatioPct: ATR_RATIO_PCT,
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

function indicators(over: Partial<IndicatorSnapshot> = {}): IndicatorSnapshot {
  return {
    price: ENTRY_PRICE,
    ma7: 99,
    ma25: 97,
    ma99: 95,
    ema7: 99.5,
    rsi14: 58,
    atr: 2,
    atrRatioPct: ATR_RATIO_PCT,
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
    summary: "E2E full-tier signal",
    entryRange: [99, 100],
    stopLoss: 97,
    takeProfitLevels: [106, 109],
    riskLevel: "MEDIUM",
    keyFactors: ["e2e factor A", "e2e factor B"],
  };
}

function reducedSignal(): FreeTierSlice["ai"] {
  return {
    sentiment: "BULLISH",
    summary: "E2E reduced free signal",
    entryRange: [99, 100],
    stopLoss: 97,
    takeProfit: 106,
    riskLevel: "MEDIUM",
  };
}

/** An ultimate FullTierSlice for the fake symbol at boundary `ts`. */
function ultimateSlice(ts: number): FullTierSlice {
  return {
    tier: "ultimate",
    symbol: TEST_SYMBOL,
    interval: "1m",
    ts,
    candidate: candidate({ interval: "1m" }),
    indicators: indicators(),
    ai: fullSignal(),
  };
}

/** Fabricate all three slices (needed by writeTierSlices) at boundary `ts`. */
function fabricateSlices(ts: number): TierSlices {
  const ultimate = ultimateSlice(ts);
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

/**
 * Builds the EXACT RiskProfile the feed route derives for a user, mirroring the
 * route's own construction:
 *   leverage   = prefs.defaultLeverage
 *   rrReward   = parseRrRatio(prefs.defaultRrRatio)
 *   rrRatio    = prefs.defaultRrRatio
 *   balanceUsd = demoBalanceForTier(plan)
 */
function profileFor(
  plan: "free" | "pro" | "ultimate",
  defaultLeverage: number,
  defaultRrRatio: string,
): RiskProfile {
  return {
    leverage: defaultLeverage,
    rrReward: parseRrRatio(defaultRrRatio),
    rrRatio: defaultRrRatio,
    balanceUsd: demoBalanceForTier(plan),
  };
}

/**
 * Independent recompute of the USD levels for a slice under a profile — the
 * "manual recompute" the acceptance criterion (Req 7.4) requires. Uses the same
 * entry-price resolution the route's `usdForSlice` uses (candidate.price, or the
 * entryRange midpoint fallback when price ≤ 0).
 */
function independentRecompute(slice: FullTierSlice, profile: RiskProfile) {
  const cand = slice.candidate;
  const [lo, hi] = slice.ai.entryRange;
  const mid =
    Number.isFinite(lo) && Number.isFinite(hi) && lo > 0 && hi > 0
      ? (lo + hi) / 2
      : cand.price;
  const entryPrice = cand.price > 0 ? cand.price : mid;
  return computeUsdLevels({
    entryPrice,
    direction: cand.direction,
    atrRatioPct: cand.atrRatioPct,
    leverage: profile.leverage,
    rrReward: profile.rrReward,
    balanceUsd: profile.balanceUsd,
  });
}

// --- 1. Offline acceptance (Approach A — drives the REAL route helpers) -----

function testOfflineAcceptance(): void {
  section("E2E acceptance — leverage=25, rr=1:3 (offline, real route helpers) (Req 7.4/7.3)");

  const ts = Date.now();
  const slice = ultimateSlice(ts);

  // The acceptance user: default_leverage=25, default_rr_ratio="1:3", Ultimate.
  const profile = profileFor("ultimate", 25, "1:3");

  // Sanity on the derived profile (these are the exact inputs the route feeds
  // into computeUsdLevels for this user).
  assertEqual(profile.leverage, 25, "profile leverage = 25 (from default_leverage)");
  assertEqual(profile.rrReward, 3, 'profile rrReward = 3 (parseRrRatio("1:3"))');
  assertEqual(profile.balanceUsd, 100_000, "profile balanceUsd = $100k (Ultimate demo balance)");

  // Drive the REAL feed read-path mapping.
  const row = fullSliceToRow(slice, profile);

  // Independent manual recompute.
  const expected = independentRecompute(slice, profile);

  // Req 7.4: the feed's TP1/TP2/SL (USD) EQUAL the independent recompute.
  assertApprox(row.usd.tp1Usd, expected.tp1Usd, "feed TP1 USD = independent computeUsdLevels tp1Usd", 0.01);
  assertApprox(row.usd.tp2Usd, expected.tp2Usd, "feed TP2 USD = independent computeUsdLevels tp2Usd", 0.01);
  assertApprox(row.usd.stopLossUsd, expected.stopLossUsd, "feed SL USD = independent computeUsdLevels stopLossUsd", 0.01);
  // Prices match too (the whole envelope is spread from computeUsdLevels).
  assertApprox(row.usd.tp1Price, expected.tp1Price, "feed TP1 price = independent tp1Price");
  assertApprox(row.usd.tp2Price, expected.tp2Price, "feed TP2 price = independent tp2Price");
  assertApprox(row.usd.stopLossPrice, expected.stopLossPrice, "feed SL price = independent stopLossPrice");

  // Verify the closed-form identities Req 7 describes, at leverage=25:
  //   stopDist = 100 * 0.02 * 1.5 = 3
  //   qty      = balance * lev / entry = 100000*25/100 = 25000
  //   SL USD   = |entry - sl| * qty = 3 * 25000        = 75,000
  //   TP1 USD  = stopDist*rrReward * qty = 3*3 * 25000  = 225,000
  //   TP2 USD  = stopDist*(rrReward+1) * qty = 3*4 *25000 = 300,000
  const stopDist = ENTRY_PRICE * (ATR_RATIO_PCT / 100) * 1.5; // 3
  const qty25 = (profile.balanceUsd * 25) / ENTRY_PRICE; // 25000
  assertApprox(row.usd.stopLossUsd, stopDist * qty25, "closed-form: SL USD = stopDist*qty = 75,000", 0.01);
  assertApprox(row.usd.tp1Usd, stopDist * 3 * qty25, "closed-form: TP1 USD = stopDist*rrReward*qty = 225,000", 0.01);
  assertApprox(row.usd.tp2Usd, stopDist * 4 * qty25, "closed-form: TP2 USD = stopDist*(rrReward+1)*qty = 300,000", 0.01);

  // The row also echoes the profile inputs so the client/test can see them.
  assertEqual(row.usd.leverage, 25, "row echoes leverage = 25");
  assertEqual(row.usd.rrRatio, "1:3", 'row echoes rrRatio = "1:3"');
  assertEqual(row.usd.balanceUsd, 100_000, "row echoes balanceUsd = $100k");
  assertEqual(row.riskRewardRatio, "1:3", "row.riskRewardRatio reflects the user's ratio");

  // --- Req 7.3: changing leverage changes the numbers ---------------------
  const profile50 = profileFor("ultimate", 50, "1:3");
  const row50 = fullSliceToRow(slice, profile50);
  const expected50 = independentRecompute(slice, profile50);

  // Still matches an independent recompute at the new leverage.
  assertApprox(row50.usd.tp1Usd, expected50.tp1Usd, "lev=50: feed TP1 USD = independent recompute", 0.01);
  assertApprox(row50.usd.tp2Usd, expected50.tp2Usd, "lev=50: feed TP2 USD = independent recompute", 0.01);
  assertApprox(row50.usd.stopLossUsd, expected50.stopLossUsd, "lev=50: feed SL USD = independent recompute", 0.01);

  // The USD numbers CHANGED (doubled: 50/25 = 2×) — this is the Req 7.3 signal.
  ok(row50.usd.tp1Usd !== row.usd.tp1Usd, "lev 25→50 changes TP1 USD (Req 7.3)");
  ok(row50.usd.tp2Usd !== row.usd.tp2Usd, "lev 25→50 changes TP2 USD (Req 7.3)");
  ok(row50.usd.stopLossUsd !== row.usd.stopLossUsd, "lev 25→50 changes SL USD (Req 7.3)");
  assertApprox(row50.usd.tp1Usd, row.usd.tp1Usd * 2, "lev 25→50 doubles TP1 USD", 0.01);
  assertApprox(row50.usd.tp2Usd, row.usd.tp2Usd * 2, "lev 25→50 doubles TP2 USD", 0.01);
  assertApprox(row50.usd.stopLossUsd, row.usd.stopLossUsd * 2, "lev 25→50 doubles SL USD", 0.01);

  // Price levels are leverage-independent (only the USD sizing moves).
  assertApprox(row50.usd.tp1Price, row.usd.tp1Price, "leverage does not move TP1 price level");
  assertApprox(row50.usd.stopLossPrice, row.usd.stopLossPrice, "leverage does not move SL price level");

  // And usdForSlice (the lower-level helper the route calls) agrees with the row.
  const direct = usdForSlice(slice, profile);
  assertApprox(direct.tp1Usd, row.usd.tp1Usd, "usdForSlice tp1Usd == fullSliceToRow row tp1Usd");
  assertApprox(direct.stopLossUsd, row.usd.stopLossUsd, "usdForSlice stopLossUsd == fullSliceToRow row stopLossUsd");
}

// --- 2. Redis slice-level E2E (write → read-back → real mapping) ------------

async function testRedisAcceptance(probe: Redis | null): Promise<void> {
  section("E2E acceptance — write → readTierSlices → real mapping (Req 7.4/7.3)");

  if (!probe) {
    skip("slice-level E2E (write/read-back ultimate slice) — no reachable Redis");
    return;
  }

  const ts = Date.now();
  const slices = fabricateSlices(ts);

  await cleanupTestKeys(probe);
  try {
    // Write the fabricated slices exactly as the 1m scanner would.
    await writeTierSlices(slices);

    // Read the ultimate slice back with the SAME helper the feed route uses.
    const readBack = (await readTierSlices("ultimate", [TEST_SYMBOL])) as FullTierSlice[];
    ok(readBack.length === 1, "readTierSlices(ultimate) returns exactly the written slice");
    const slice = readBack[0];
    ok(!!slice && slice.tier === "ultimate" && slice.symbol === TEST_SYMBOL, "read-back slice is the ultimate TESTUSDT slice");

    if (!slice) {
      // Nothing more we can assert without a slice.
      return;
    }

    // The acceptance user again: leverage=25, "1:3", Ultimate ($100k).
    const profile = profileFor("ultimate", 25, "1:3");
    const row = fullSliceToRow(slice, profile);
    const expected = independentRecompute(slice, profile);

    // Req 7.4 over the full write→read→map path.
    assertApprox(row.usd.tp1Usd, expected.tp1Usd, "read-path TP1 USD = independent recompute", 0.01);
    assertApprox(row.usd.tp2Usd, expected.tp2Usd, "read-path TP2 USD = independent recompute", 0.01);
    assertApprox(row.usd.stopLossUsd, expected.stopLossUsd, "read-path SL USD = independent recompute", 0.01);
    // Exact expected magnitudes (entry 100, atr 2%, lev 25, $100k).
    assertApprox(row.usd.stopLossUsd, 75_000, "read-path SL USD = 75,000", 0.01);
    assertApprox(row.usd.tp1Usd, 225_000, "read-path TP1 USD = 225,000", 0.01);
    assertApprox(row.usd.tp2Usd, 300_000, "read-path TP2 USD = 300,000", 0.01);

    // Req 7.3: change leverage to 50 over the same read-back slice → numbers change (double).
    const row50 = fullSliceToRow(slice, profileFor("ultimate", 50, "1:3"));
    ok(row50.usd.tp1Usd !== row.usd.tp1Usd, "read-path: lev 25→50 changes TP1 USD (Req 7.3)");
    assertApprox(row50.usd.tp1Usd, row.usd.tp1Usd * 2, "read-path: lev 25→50 doubles TP1 USD", 0.01);
    assertApprox(row50.usd.stopLossUsd, row.usd.stopLossUsd * 2, "read-path: lev 25→50 doubles SL USD", 0.01);
  } finally {
    await cleanupTestKeys(probe);
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
  // Defensive explicit deletes for the exact keys writeTierSlices creates.
  const now = Date.now();
  for (const tier of ["free", "pro", "ultimate"] as const) {
    await client.del(tierLatestKey(tier, TEST_SYMBOL));
    await client.del(tierScanKey(tier, TEST_SYMBOL, now));
  }
}

// --- Runner -----------------------------------------------------------------

async function main(): Promise<void> {
  console.log(c.bold("Running E2E acceptance test (tiered-scan-caching / Task 18)\n"));

  const probe = await probeRedis();
  if (probe) {
    console.log(c.green(`Redis: REACHABLE at ${process.env.REDIS_URL} — running the write→read-back E2E too.`));
  } else {
    console.log(
      c.yellow(
        "Redis: NOT reachable — the write→read-back E2E is SKIPPED. The offline " +
          "acceptance assertions (real route helpers) still run.",
      ),
    );
  }

  try {
    testOfflineAcceptance();
    await testRedisAcceptance(probe);
  } finally {
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
  process.exit(0);
}

main().catch((err) => {
  console.error(c.red("\nE2E test runner crashed:"), err);
  process.exit(1);
});
