// ---------------------------------------------------------------------------
// Unit tests for the pure helpers introduced by the tiered-scan-caching spec
// (Task 16). This project has no formal test framework (no jest/vitest); it
// runs standalone `tsx` scripts (see scripts/test-engine.ts, scripts/test-ai-
// analysis.ts). This file follows that same pattern: a tiny assert helper, a
// `main()` that runs every check, prints a pass/fail line per assertion, and
// exits non-zero if anything failed.
//
// Coverage:
//   1. resampleKlines / resampleSeries  (src/lib/market/resample.ts)  — Req 3.5
//   2. parseRrRatio                     (src/lib/ai/risk.ts)          — Req 6.3
//   3. computeUsdLevels                 (src/lib/ai/risk.ts)          — Req 7.2
//   4. resolvePlanFromEntitlement       (src/lib/user-entitlement.ts) — Req 1.1–1.3
//
// getUserPlan approach: getUserPlan() itself hits Prisma + Freemius, so it is
// not a pure unit. Per the task's preferred option (a), the pure mapping was
// extracted into `resolvePlanFromEntitlement(entitlement)` (exported from
// user-entitlement.ts); getUserPlan now delegates to it. We unit-test the
// helper with fabricated entitlement-shaped objects — no DB, no mocks.
//
// Usage:  npm run test:unit
// ---------------------------------------------------------------------------

import {
  resampleKlines,
  resampleSeries,
} from "@/lib/market/resample";
import {
  parseRrRatio,
  computeUsdLevels,
  DEFAULT_RR_REWARD,
  STOP_ATR_K,
  ATR_FLOOR_PCT,
} from "@/lib/ai/risk";
import { resolvePlanFromEntitlement } from "@/lib/user-entitlement";
import { PRO_PRICING_ID, ULTIMATE_PRICING_ID } from "@/lib/freemius";
import {
  servedIntervalForPlan,
  refreshMsForPlan,
  shouldRefreshOnHeartbeat,
  initialsFromIdentity,
} from "@/components/dashboard/dashboard-live.helpers";
import type { Kline } from "@/lib/market/types";
import type { ScanStatus } from "@/lib/market/redis-pipeline";
import type { UserFsEntitlement } from "@prisma/client";

// --- Minimal test harness ---------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
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

/** Exact-ish float equality with a small epsilon (rounding tolerance). */
function approx(actual: number, expected: number, eps = 1e-6): boolean {
  return Math.abs(actual - expected) <= eps;
}

function assertEqual(actual: unknown, expected: unknown, msg: string): void {
  ok(actual === expected, `${msg} (expected ${String(expected)}, got ${String(actual)})`);
}

function assertApprox(actual: number, expected: number, msg: string, eps = 1e-6): void {
  ok(approx(actual, expected, eps), `${msg} (expected ≈${expected}, got ${actual})`);
}

function assertThrows(fn: () => unknown, msg: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  ok(threw, `${msg} (expected a throw)`);
}

function section(title: string): void {
  console.log(`\n${c.cyan(c.bold(title))}`);
}

// --- Fixtures ---------------------------------------------------------------

/** Build a 1m candle with sensible defaults, overridable per field. */
function kline(over: Partial<Kline> & { openTime: number }): Kline {
  return {
    open: 100,
    high: 100,
    low: 100,
    close: 100,
    volume: 1,
    quoteVolume: 1,
    trades: 1,
    closeTime: over.openTime + 59_999,
    ...over,
  };
}

// --- 1. resampleKlines / resampleSeries -------------------------------------

function testResample(): void {
  section("resampleKlines / resampleSeries (Req 3.5)");

  // Five distinct 1m candles → one 5m bar.
  const base = 1_700_000_000_000;
  const min = 60_000;
  const five: Kline[] = [
    kline({ openTime: base + 0 * min, open: 10, high: 12, low: 9, close: 11, volume: 5, quoteVolume: 50, trades: 3 }),
    kline({ openTime: base + 1 * min, open: 11, high: 15, low: 10, close: 14, volume: 7, quoteVolume: 70, trades: 4 }),
    kline({ openTime: base + 2 * min, open: 14, high: 14, low: 8, close: 9, volume: 3, quoteVolume: 30, trades: 2 }),
    kline({ openTime: base + 3 * min, open: 9, high: 13, low: 7, close: 12, volume: 6, quoteVolume: 60, trades: 5 }),
    kline({ openTime: base + 4 * min, open: 12, high: 18, low: 11, close: 16, volume: 4, quoteVolume: 40, trades: 1 }),
  ];

  const bar = resampleKlines(five, 5);
  assertEqual(bar.open, 10, "open = first.open");
  assertEqual(bar.close, 16, "close = last.close");
  assertEqual(bar.high, 18, "high = max(high)");
  assertEqual(bar.low, 7, "low = min(low)");
  assertEqual(bar.volume, 25, "volume = Σ volume");
  assertEqual(bar.quoteVolume, 250, "quoteVolume = Σ quoteVolume");
  assertEqual(bar.trades, 15, "trades = Σ trades");
  assertEqual(bar.openTime, base + 0 * min, "openTime = first.openTime");
  assertEqual(bar.closeTime, five[4].closeTime, "closeTime = last.closeTime");
  assertEqual(bar.isClosed, true, "full window → isClosed = true");

  // Partial window: only 3 candles for a factor-5 bar → partial, isClosed=false.
  const partial = resampleKlines(five.slice(0, 3), 5);
  assertEqual(partial.open, 10, "partial: open = first.open");
  assertEqual(partial.close, 9, "partial: close = last.close (3rd candle)");
  assertEqual(partial.high, 15, "partial: high = max over 3 candles");
  assertEqual(partial.low, 8, "partial: low = min over 3 candles");
  assertEqual(partial.volume, 15, "partial: volume = Σ over 3 candles");
  assertEqual(partial.isClosed, false, "partial window → isClosed = false");

  // resampleKlines takes the MOST RECENT `factor` candles when given more.
  const sixth = kline({ openTime: base + 5 * min, open: 16, high: 20, low: 15, close: 19, volume: 2, quoteVolume: 20, trades: 1 });
  const recent = resampleKlines([...five, sixth], 5);
  assertEqual(recent.openTime, base + 1 * min, "extra candles: window is the last 5");
  assertEqual(recent.close, 19, "extra candles: close = newest close");
  assertEqual(recent.high, 20, "extra candles: high includes newest");

  // Guards.
  assertThrows(() => resampleKlines([], 5), "resampleKlines throws on empty input");
  assertThrows(() => resampleKlines(five, 0), "resampleKlines throws on factor = 0");
  assertThrows(() => resampleKlines(five, -3), "resampleKlines throws on negative factor");

  // resampleSeries: chunk 12 candles into 5m bars → 3 bars (5 + 5 + 2 partial).
  const twelve: Kline[] = Array.from({ length: 12 }, (_, i) =>
    kline({ openTime: base + i * min, open: 100 + i, high: 100 + i + 1, low: 100 + i - 1, close: 100 + i, volume: 1, quoteVolume: 1, trades: 1 }),
  );
  const series = resampleSeries(twelve, 5);
  assertEqual(series.length, 3, "resampleSeries: 12 candles / factor 5 → 3 bars");
  assertEqual(series[0].isClosed, true, "resampleSeries: first chunk (5) is closed");
  assertEqual(series[1].isClosed, true, "resampleSeries: second chunk (5) is closed");
  assertEqual(series[2].isClosed, false, "resampleSeries: trailing chunk (2) is partial");
  assertEqual(series[0].open, twelve[0].open, "resampleSeries: first bar open = candle[0].open");
  assertEqual(series[2].close, twelve[11].close, "resampleSeries: last bar close = candle[11].close");
  assertEqual(series[2].volume, 2, "resampleSeries: trailing bar volume = Σ of its 2 candles");

  // resampleSeries: empty input → empty array; bad factor → throw.
  assertEqual(resampleSeries([], 5).length, 0, "resampleSeries: empty input → empty array");
  assertThrows(() => resampleSeries(twelve, 0), "resampleSeries throws on factor = 0");
}

// --- 2. parseRrRatio --------------------------------------------------------

function testParseRrRatio(): void {
  section("parseRrRatio (Req 6.3)");

  assertEqual(parseRrRatio("1:3"), 3, '"1:3" → 3');
  assertEqual(parseRrRatio("1:2.5"), 2.5, '"1:2.5" → 2.5');
  assertEqual(parseRrRatio("1:2"), 2, '"1:2" → 2');
  assertEqual(parseRrRatio(" 1:4 "), 4, 'whitespace-padded "1:4" → 4');

  // Invalid / malformed → DEFAULT_RR_REWARD.
  assertEqual(parseRrRatio(""), DEFAULT_RR_REWARD, 'empty string → DEFAULT_RR_REWARD');
  assertEqual(parseRrRatio("1:0"), DEFAULT_RR_REWARD, '"1:0" (non-positive) → DEFAULT_RR_REWARD');
  assertEqual(parseRrRatio("3"), DEFAULT_RR_REWARD, '"3" (no risk side) → DEFAULT_RR_REWARD');
  assertEqual(parseRrRatio("2:3"), DEFAULT_RR_REWARD, '"2:3" (risk side ≠ 1) → DEFAULT_RR_REWARD');
  assertEqual(parseRrRatio("1:abc"), DEFAULT_RR_REWARD, '"1:abc" → DEFAULT_RR_REWARD');
  assertEqual(parseRrRatio(null), DEFAULT_RR_REWARD, "null → DEFAULT_RR_REWARD");
  assertEqual(parseRrRatio(undefined), DEFAULT_RR_REWARD, "undefined → DEFAULT_RR_REWARD");

  // Explicit fallback override honoured.
  assertEqual(parseRrRatio("bad", 5), 5, "custom fallback used on invalid input");
}

// --- 3. computeUsdLevels ----------------------------------------------------

function testComputeUsdLevels(): void {
  section("computeUsdLevels (Req 7.2, 7.3, 7.5)");

  // Deterministic inputs. Compute expected values from the exported tunables so
  // assertions are exact (the impl rounds prices to 3dp and USD to 2dp).
  const entryPrice = 100;
  const atrRatioPct = 2; // above ATR_FLOOR_PCT
  const rrReward = 3;
  const leverage = 10;
  const balanceUsd = 10_000;

  const atrFrac = Math.max(atrRatioPct, ATR_FLOOR_PCT) / 100; // 0.02
  const stopDist = entryPrice * atrFrac * STOP_ATR_K; // 100 * 0.02 * 1.5 = 3
  const qty = (balanceUsd * leverage) / entryPrice; // 100000/100 = 1000

  // LONG: stop below entry, TPs above.
  const long = computeUsdLevels({ entryPrice, direction: "LONG", atrRatioPct, leverage, rrReward, balanceUsd });
  ok(long.stopLossPrice < entryPrice, "LONG: stop below entry");
  ok(long.tp1Price > entryPrice && long.tp2Price > entryPrice, "LONG: TPs above entry");
  assertApprox(long.stopLossPrice, entryPrice - stopDist, "LONG: stopLossPrice = entry − stopDist");
  assertApprox(long.tp1Price, entryPrice + stopDist * rrReward, "LONG: tp1 = entry + stopDist*rrReward");
  assertApprox(long.tp2Price, entryPrice + stopDist * (rrReward + 1), "LONG: tp2 = entry + stopDist*(rrReward+1)");
  ok(long.tp2Price > long.tp1Price, "LONG: tp2 further than tp1");

  // USD amounts: |Δprice| * qty.
  assertApprox(long.stopLossUsd, Math.abs(entryPrice - long.stopLossPrice) * qty, "LONG: stopLossUsd = |entry−stop|*qty", 0.01);
  assertApprox(long.tp1Usd, Math.abs(long.tp1Price - entryPrice) * qty, "LONG: tp1Usd = |tp1−entry|*qty", 0.01);
  assertApprox(long.tp2Usd, Math.abs(long.tp2Price - entryPrice) * qty, "LONG: tp2Usd = |tp2−entry|*qty", 0.01);
  // With stopDist=3, qty=1000 → stopLossUsd = 3*1000 = 3000.
  assertApprox(long.stopLossUsd, 3000, "LONG: stopLossUsd exact = 3000", 0.01);
  assertApprox(long.tp1Usd, 9000, "LONG: tp1Usd exact = stopDist*rrReward*qty = 9000", 0.01);

  // SHORT: mirrored — stop above entry, TPs below.
  const short = computeUsdLevels({ entryPrice, direction: "SHORT", atrRatioPct, leverage, rrReward, balanceUsd });
  ok(short.stopLossPrice > entryPrice, "SHORT: stop above entry");
  ok(short.tp1Price < entryPrice && short.tp2Price < entryPrice, "SHORT: TPs below entry");
  assertApprox(short.stopLossPrice, entryPrice + stopDist, "SHORT: stopLossPrice = entry + stopDist");
  assertApprox(short.tp1Price, entryPrice - stopDist * rrReward, "SHORT: tp1 = entry − stopDist*rrReward");
  assertApprox(short.tp2Price, entryPrice - stopDist * (rrReward + 1), "SHORT: tp2 = entry − stopDist*(rrReward+1)");
  // Mirrored USD amounts equal the LONG ones (same |Δ| and qty).
  assertApprox(short.stopLossUsd, long.stopLossUsd, "SHORT: stopLossUsd mirrors LONG");
  assertApprox(short.tp1Usd, long.tp1Usd, "SHORT: tp1Usd mirrors LONG");

  // Leverage sensitivity: doubling leverage doubles USD amounts (Req 7.3).
  const long2x = computeUsdLevels({ entryPrice, direction: "LONG", atrRatioPct, leverage: leverage * 2, rrReward, balanceUsd });
  assertApprox(long2x.stopLossUsd, long.stopLossUsd * 2, "2× leverage → 2× stopLossUsd", 0.01);
  assertApprox(long2x.tp1Usd, long.tp1Usd * 2, "2× leverage → 2× tp1Usd", 0.01);
  assertApprox(long2x.tp2Usd, long.tp2Usd * 2, "2× leverage → 2× tp2Usd", 0.01);
  // Prices are leverage-independent.
  assertApprox(long2x.tp1Price, long.tp1Price, "leverage does not move price levels");

  // ATR floor: a near-zero ATR is floored to ATR_FLOOR_PCT.
  const floored = computeUsdLevels({ entryPrice, direction: "LONG", atrRatioPct: 0, leverage, rrReward, balanceUsd });
  const flooredStopDist = entryPrice * (ATR_FLOOR_PCT / 100) * STOP_ATR_K;
  assertApprox(floored.stopLossPrice, entryPrice - flooredStopDist, "ATR below floor → stop uses ATR_FLOOR_PCT");
}

// --- 4. resolvePlanFromEntitlement (getUserPlan mapping) --------------------

function testResolvePlan(): void {
  section("resolvePlanFromEntitlement — getUserPlan tier mapping (Req 1.1–1.3)");

  // Fabricate entitlement-shaped objects — only fsPricingId matters for the map.
  const ent = (fsPricingId: string): Pick<UserFsEntitlement, "fsPricingId"> => ({ fsPricingId });

  assertEqual(resolvePlanFromEntitlement(ent(ULTIMATE_PRICING_ID)), "ultimate", "ULTIMATE_PRICING_ID → ultimate (Req 1.1)");
  assertEqual(resolvePlanFromEntitlement(ent(PRO_PRICING_ID)), "pro", "PRO_PRICING_ID → pro (Req 1.2)");
  assertEqual(resolvePlanFromEntitlement(ent("99999")), "free", "unknown pricing id → free");
  assertEqual(resolvePlanFromEntitlement(null), "free", "no entitlement → free (Req 1.3)");

  // Precedence: the resolver checks Ultimate first, so an entitlement whose id
  // equals the Ultimate id always wins Ultimate. (A single entitlement carries
  // one fsPricingId; the "both" case is expressed by that id being Ultimate.)
  assertEqual(resolvePlanFromEntitlement(ent(ULTIMATE_PRICING_ID)), "ultimate", "Ultimate precedence over Pro");
}

// --- 5. dashboard-live.helpers ----------------------------------------------

/** Build a ScanStatus with sensible defaults, overridable per field. */
function scanStatus(over: Partial<ScanStatus>): ScanStatus {
  return {
    scanning: false,
    lastScanAt: 0,
    symbolsScanned: 0,
    combosScanned: 0,
    candidatesFound: 0,
    trigger: "interval",
    everySec: 60,
    intervals: [],
    ...over,
  };
}

function testServedIntervalForPlan(): void {
  section("servedIntervalForPlan (Req 3.3, 3.4, 3.5)");

  assertEqual(servedIntervalForPlan("free"), "15m", 'free → "15m"');
  assertEqual(servedIntervalForPlan("pro"), "5m", 'pro → "5m"');
  assertEqual(servedIntervalForPlan("ultimate"), "1m", 'ultimate → "1m"');
}

function testRefreshMsForPlan(): void {
  section("refreshMsForPlan (Req 2.1, 2.2, 2.3)");

  assertEqual(refreshMsForPlan("free"), 60000, "free → 60000ms");
  assertEqual(refreshMsForPlan("pro"), 30000, "pro → 30000ms");
  assertEqual(refreshMsForPlan("ultimate"), 15000, "ultimate → 15000ms");

  // Ordering invariant: faster tiers poll more often (ultimate < pro < free).
  ok(
    refreshMsForPlan("ultimate") < refreshMsForPlan("pro") &&
      refreshMsForPlan("pro") < refreshMsForPlan("free"),
    "ordering invariant: ultimate < pro < free",
  );
}

function testShouldRefreshOnHeartbeat(): void {
  section("shouldRefreshOnHeartbeat (Req 1.2, 2.4)");

  const served = "15m";
  const lastRefreshAt = 1_000;

  // Absent scan status → false (no heartbeat yet).
  assertEqual(
    shouldRefreshOnHeartbeat(null, served, lastRefreshAt),
    false,
    "null scanStatus → false",
  );
  assertEqual(
    shouldRefreshOnHeartbeat(undefined, served, lastRefreshAt),
    false,
    "undefined scanStatus → false",
  );

  // Actively scanning → false, even with a newer lastScanAt covering the interval.
  assertEqual(
    shouldRefreshOnHeartbeat(
      scanStatus({ scanning: true, intervals: ["15m"], lastScanAt: 5_000 }),
      served,
      lastRefreshAt,
    ),
    false,
    "scanning=true → false",
  );

  // Completed scan but intervals omit the served interval → false.
  assertEqual(
    shouldRefreshOnHeartbeat(
      scanStatus({ scanning: false, intervals: ["5m", "1m"], lastScanAt: 5_000 }),
      served,
      lastRefreshAt,
    ),
    false,
    "intervals omit served interval → false",
  );

  // Dedupe: lastScanAt <= lastRefreshAt → false (already handled).
  assertEqual(
    shouldRefreshOnHeartbeat(
      scanStatus({ scanning: false, intervals: ["15m"], lastScanAt: lastRefreshAt }),
      served,
      lastRefreshAt,
    ),
    false,
    "lastScanAt == lastRefreshAt (dedupe) → false",
  );
  assertEqual(
    shouldRefreshOnHeartbeat(
      scanStatus({ scanning: false, intervals: ["15m"], lastScanAt: lastRefreshAt - 1 }),
      served,
      lastRefreshAt,
    ),
    false,
    "lastScanAt < lastRefreshAt (dedupe) → false",
  );

  // Newer completed scan including the served interval → true.
  assertEqual(
    shouldRefreshOnHeartbeat(
      scanStatus({ scanning: false, intervals: ["15m", "5m"], lastScanAt: lastRefreshAt + 1 }),
      served,
      lastRefreshAt,
    ),
    true,
    "newer completed scan including served interval → true",
  );
}

function testInitialsFromIdentity(): void {
  section("initialsFromIdentity (Req 1.2)");

  // Name-based initials: first + last initial.
  assertEqual(initialsFromIdentity("Ada Lovelace", "ada@example.com"), "AL", "full name → first+last initial");
  assertEqual(initialsFromIdentity("  jane   doe  ", null), "JD", "extra whitespace collapsed → JD");
  // Single-word name → first two chars.
  assertEqual(initialsFromIdentity("Cher", null), "CH", "single-word name → first two chars uppercased");
  assertEqual(initialsFromIdentity("x", null), "X", "single-char name → one uppercase char");

  // Email fallback when name is absent/blank.
  assertEqual(initialsFromIdentity(null, "bob@example.com"), "BO", "no name → email local part");
  assertEqual(initialsFromIdentity("   ", "carol.smith@x.io"), "CA", "blank name → email fallback");

  // Neither usable → "?".
  assertEqual(initialsFromIdentity(null, null), "?", "no name, no email → ?");
  assertEqual(initialsFromIdentity("", "@nope.com"), "?", "empty local part → ?");

  // Invariant: always 1–2 chars and uppercase across a spread of inputs.
  const cases: Array<[string | null, string | null]> = [
    ["Ada Lovelace", "ada@x.com"],
    ["Cher", null],
    [null, "bob@example.com"],
    ["x", null],
    [null, null],
  ];
  const allValid = cases.every(([n, e]) => {
    const r = initialsFromIdentity(n, e);
    return r.length >= 1 && r.length <= 2 && r === r.toUpperCase();
  });
  ok(allValid, "invariant: result is always 1–2 uppercase chars");
}

// --- Runner -----------------------------------------------------------------

function main(): void {
  console.log(c.bold("Running unit tests (tiered-scan-caching / Task 16)\n"));

  testResample();
  testParseRrRatio();
  testComputeUsdLevels();
  testResolvePlan();
  testServedIntervalForPlan();
  testRefreshMsForPlan();
  testShouldRefreshOnHeartbeat();
  testInitialsFromIdentity();

  const total = passed + failed;
  console.log(
    `\n${c.bold("Summary:")} ${c.green(String(passed) + " passed")}, ` +
      `${failed > 0 ? c.red(String(failed) + " failed") : c.dim("0 failed")} ` +
      `(${total} assertions)`,
  );

  if (failed > 0) {
    console.log(c.red("\nFailed assertions:"));
    for (const f of failures) console.log(`  ${c.red("•")} ${f}`);
    process.exit(1);
  }
  console.log(c.green("\nAll assertions passed.\n"));
}

main();
