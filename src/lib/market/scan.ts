// ---------------------------------------------------------------------------
// Reusable market scan pass (Phase 4/5 live scanning + manual scan).
//
// A single `scanMarket()` pass evaluates the CURRENT sliding-window state for
// each symbol/interval — WITHOUT waiting for a candle to close — so the
// dashboard can update continuously (every ~15s) and Pro users can trigger an
// on-demand scan. It is intentionally decoupled from the WebSocket ingestion:
//   • reads candle windows from Redis (`readWindow`),
//   • computes indicators/candidates (`analyzeSymbolInterval`, pure),
//   • caches snapshots (`saveSnapshot`) and publishes signals (`publishSignal`),
//   • dispatches Pro AI for qualifying candidates (`generateProAnalysis`),
//   • publishes a scan-status heartbeat (`publishScanStatus`).
//
// Because it only reads shared Redis state + the same `@/lib` engine, it runs
// identically inside the worker (periodic loop) and inside a Next.js route
// handler (manual scan) — no direct coupling to the streaming socket.
// ---------------------------------------------------------------------------

import { fetch24hTickers, fetchKlines } from "@/lib/market/binance";
import { analyzeSymbolInterval, computeRegime } from "@/lib/market/engine";
import { getIntervals, REGIME_SYMBOLS, resolveTrackedSymbols } from "@/lib/market/config";
import {
  publishScanStatus,
  publishSignal,
  readWindow,
  recordScanTimes,
  saveSnapshot,
  seedWindow,
  WINDOW_SIZE,
  type ScanStatus,
} from "@/lib/market/redis-pipeline";
import { generateProAnalysis, PRO_SCORE_THRESHOLD } from "@/lib/ai/orchestrator";
import type {
  AnalysisCandidate,
  Interval,
  MarketRegime,
  Ticker24h,
} from "@/lib/market/types";

const MIN_HISTORY = 25; // MAs need at least this many candles.

export interface ScanOptions {
  /** Symbols to scan. Defaults to the resolved tracked universe. */
  symbols?: string[];
  /** Intervals to scan. Defaults to all engine intervals. */
  intervals?: Interval[];
  /** Trigger label surfaced in the scan-status heartbeat. */
  trigger?: ScanStatus["trigger"];
  /** Automatic loop cadence (seconds), surfaced in the heartbeat. */
  everySec?: number;
  /** Pre-fetched tickers (worker passes its cache to avoid REST churn). */
  tickers?: Map<string, Ticker24h>;
  /** Pre-computed regime (worker passes its cached regime). */
  regime?: MarketRegime;
  /** Run Pro AI dispatch for qualifying candidates. Default true. */
  dispatchProAnalysis?: boolean;
  /**
   * Record per-interval "last scanned" timestamps. Only the automatic,
   * boundary-aligned single-interval scans should set this so the UI's
   * per-period times reflect real candle closes (not startup/manual passes).
   */
  recordTimes?: boolean;
  /**
   * Pull fresh candles via REST before analyzing (instead of relying on the WS
   * stream). Required where the Binance WebSocket is geo-blocked but REST works.
   * Bounded concurrency keeps it within rate limits.
   */
  refreshViaRest?: boolean;
  /**
   * Bypass the per-symbol Pro AI cooldown. Manual scans set this so a user who
   * clicks "Scan now" gets freshly-regenerated analyses instead of the cached
   * ones from a scan minutes ago.
   */
  ignoreCooldown?: boolean;
}

export interface ScanResult {
  candidates: AnalysisCandidate[];
  symbolsScanned: number;
  combosScanned: number;
  startedAt: number;
  finishedAt: number;
}

/**
 * Runs one full scan pass over the current window state. Returns all detected
 * candidates (highest score first). Safe to call repeatedly and concurrently
 * with the ingestion socket — it only reads windows and writes idempotent
 * snapshots / fire-and-forget publishes.
 */
export async function scanMarket(options: ScanOptions = {}): Promise<ScanResult> {
  const startedAt = Date.now();
  const allIntervals = getIntervals();
  const intervals =
    options.intervals && options.intervals.length
      ? options.intervals.filter((i) => allIntervals.includes(i))
      : allIntervals;
  const symbols = options.symbols ?? (await resolveTrackedSymbols());
  const trigger = options.trigger ?? "interval";
  const everySec = options.everySec ?? 0;
  const dispatchPro = options.dispatchProAnalysis ?? true;

  // Announce the scan is starting so the UI shows an active "Scanning…" state.
  await publishScanStatus({
    scanning: true,
    lastScanAt: startedAt,
    symbolsScanned: 0,
    combosScanned: symbols.length * intervals.length,
    candidatesFound: 0,
    trigger,
    everySec,
    intervals,
  });

  // Tickers: reuse the caller's cache, else fetch a fresh batch.
  let tickers = options.tickers;
  if (!tickers) {
    try {
      tickers = await fetch24hTickers(
        Array.from(new Set([...symbols, ...REGIME_SYMBOLS])),
      );
    } catch {
      tickers = new Map();
    }
  }

  // REST refresh: pull fresh candles for everything we're about to analyze.
  // The pattern layer needs 5m + 1h backbones per symbol regardless of the
  // scanned interval, and regime needs BTC/ETH 15m+1h — so refresh that union.
  if (options.refreshViaRest) {
    const refreshIntervals = Array.from(
      new Set<Interval>([...intervals, "5m", "1h"]),
    );
    const jobs: Array<{ symbol: string; interval: Interval }> = [];
    for (const symbol of symbols) {
      for (const interval of refreshIntervals) jobs.push({ symbol, interval });
    }
    // BTC/ETH 15m+1h for regime (may already be covered, Set-dedupe in seed).
    for (const rs of REGIME_SYMBOLS) {
      for (const iv of ["15m", "1h"] as Interval[]) {
        jobs.push({ symbol: rs, interval: iv });
      }
    }

    const CONCURRENCY = 12;
    let cursor = 0;
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (cursor < jobs.length) {
        const job = jobs[cursor++];
        try {
          const kl = await fetchKlines(job.symbol, job.interval, WINDOW_SIZE);
          await seedWindow(job.symbol, job.interval, kl);
        } catch {
          // Skip on transient REST error; next scan will retry.
        }
      }
    });
    await Promise.all(workers);
  }

  // Regime: reuse the caller's, else compute from BTC/ETH windows.
  let regime = options.regime;
  if (!regime || options.refreshViaRest) {
    const [btc15m, btc1h, eth15m, eth1h] = await Promise.all([
      readWindow("BTCUSDT", "15m"),
      readWindow("BTCUSDT", "1h"),
      readWindow("ETHUSDT", "15m"),
      readWindow("ETHUSDT", "1h"),
    ]);
    if (btc15m.length && eth15m.length) {
      regime = computeRegime({ btc15m, btc1h, eth15m, eth1h });
    }
  }

  const candidates: AnalysisCandidate[] = [];
  let combosScanned = 0;
  // For manual scans we await AI generation so the caller reads fresh results.
  const proJobs: Promise<unknown>[] = [];

  for (const symbol of symbols) {
    const ticker = tickers.get(symbol);
    if (!ticker) continue; // No price reference — skip this symbol.

    // Fetch the short/backbone windows once per symbol for the pattern layer.
    const [klines5m, klines1h] = await Promise.all([
      readWindow(symbol, "5m"),
      readWindow(symbol, "1h"),
    ]);

    for (const interval of intervals) {
      combosScanned += 1;
      const klines =
        interval === "5m"
          ? klines5m
          : interval === "1h"
            ? klines1h
            : await readWindow(symbol, interval);

      if (klines.length < MIN_HISTORY) continue;

      const { indicators, candidate } = analyzeSymbolInterval({
        symbol,
        interval,
        klines,
        klines1h: klines1h.length ? klines1h : undefined,
        klines5m: klines5m.length ? klines5m : undefined,
        ticker,
        regime,
      });

      // Cache the snapshot so the dashboard/API always has fresh per-symbol data.
      await saveSnapshot({
        symbol,
        interval,
        updatedAt: Date.now(),
        indicators,
        candidate,
      });

      if (!candidate) continue;
      candidates.push(candidate);

      // Publish every detected candidate on Pub/Sub (consumers filter by tier).
      await publishSignal({
        symbol,
        interval,
        pattern: candidate.patternType,
        direction: candidate.direction,
        score: candidate.score,
        price: candidate.price,
        indicators,
        timestamp: Date.now(),
      });

      // Pro AI dispatch (gated by score + cooldown inside the orchestrator).
      if (
        dispatchPro &&
        candidate.score >= PRO_SCORE_THRESHOLD &&
        !candidate.isExhausted
      ) {
        const job = generateProAnalysis({
          candidate,
          indicators,
          regime,
          ignoreCooldown: options.ignoreCooldown,
        }).catch(() => {
          /* AI failures fall back internally; never break the scan. */
        });
        // Manual scans await results; automatic scans stay fire-and-forget.
        if (options.ignoreCooldown) proJobs.push(job);
        else void job;
      }
    }
  }

  // Manual scans: wait for AI analyses to finish so the caller reads them.
  if (proJobs.length) await Promise.all(proJobs);

  candidates.sort((a, b) => b.score - a.score);
  const finishedAt = Date.now();

  // Record per-interval last-scan times ONLY for automatic, boundary-aligned
  // single-interval scans. The startup warm-up pass (all intervals at once) and
  // manual scans must NOT overwrite these — otherwise every period would show
  // the same time. `recordTimes` lets the caller opt in explicitly.
  if (options.recordTimes) {
    await recordScanTimes(intervals, finishedAt);
  }

  // Final heartbeat: scan complete.
  await publishScanStatus({
    scanning: false,
    lastScanAt: finishedAt,
    symbolsScanned: symbols.length,
    combosScanned,
    candidatesFound: candidates.length,
    trigger,
    everySec,
    intervals,
  });

  return {
    candidates,
    symbolsScanned: symbols.length,
    combosScanned,
    startedAt,
    finishedAt,
  };
}
