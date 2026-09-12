// ---------------------------------------------------------------------------
// Tier slice production from the 1m scan (Task 11, design C3).
//
// The continuous 1-minute scanner is the single source of truth. This module
// turns each scanned symbol's 1m window into the three per-tier slices and
// persists them via `writeTierSlices`:
//
//   • ultimate — raw 1m: the 1m klines/indicators/candidate directly.
//   • pro      — engine run on the resampled 5m series (full TP ladder).
//   • free     — engine run on the resampled 15m series (REDUCED signal set).
//
// The AI-derived signal on each slice is USER-AGNOSTIC (Req 3.3): it carries
// PRICE levels only (entry zone, stop, take-profit ladder) via
// `ruleBasedAnalysis`. Per-user USD TP/SL are computed at read time in the feed
// from the caller's leverage / R:R and their tier balance — never here.
//
// Null-candidate handling (documented decision):
//   A slice's payload requires a non-null `candidate`, so a symbol with NO 1m
//   candidate (no qualifying setup this tick) is skipped entirely — no keys are
//   written for it. Requirement 3.6 ("scan:free/pro/ultimate keys exist after a
//   scan") is satisfied for every symbol that DOES have a 1m candidate: all
//   three tiers are always written together for such symbols. When the derived
//   5m/15m engine run yields no candidate of its own (e.g. the resampled
//   timeframe doesn't re-qualify), we fall back to the 1m candidate/indicators
//   so the pro/free keys still exist for that symbol. This keeps the three tier
//   keyspaces populated in lock-step without inventing signals for symbols that
//   never qualified at 1m.
// ---------------------------------------------------------------------------

import { analyzeSymbolInterval } from "@/lib/market/engine";
import { readWindow } from "@/lib/market/redis-pipeline";
import { resampleSeries } from "@/lib/market/resample";
import {
  writeTierSlices,
  type FreeTierSlice,
  type FullTierSignal,
  type FullTierSlice,
  type ReducedTierSignal,
} from "@/lib/market/tier-cache";
import { ruleBasedAnalysis } from "@/lib/ai/analyzer";
import type {
  AnalysisCandidate,
  IndicatorSnapshot,
  Interval,
  Kline,
  MarketRegime,
  Ticker24h,
} from "@/lib/market/types";

/** MAs need at least this many candles — mirrors `scan.ts` MIN_HISTORY. */
const MIN_HISTORY = 25;

/** Resample factors per derived tier (5×1m → 5m, 15×1m → 15m). */
const PRO_FACTOR = 5;
const FREE_FACTOR = 15;

export interface SliceScanOptions {
  /** Symbols scanned this tick. */
  symbols: string[];
  /** 24h tickers for the scanned symbols (reused from the scan pass). */
  tickers: Map<string, Ticker24h>;
  /** Market regime for the tick (optional). */
  regime?: MarketRegime;
  /**
   * The 1m boundary (epoch ms) this scan represents. Defaults to the current
   * 1m boundary: `floor(now / 60000) * 60000`.
   */
  ts?: number;
}

/** Current 1m boundary in epoch ms. */
export function current1mBoundary(now = Date.now()): number {
  return Math.floor(now / 60_000) * 60_000;
}

/** Builds the full (Pro/Ultimate) AI signal from a candidate — prices only. */
function fullSignal(
  candidate: AnalysisCandidate,
  interval: Interval,
): FullTierSignal {
  const ai = ruleBasedAnalysis({ candidate, interval });
  return {
    sentiment: ai.sentiment,
    summary: ai.summary,
    entryRange: ai.entryRange,
    stopLoss: ai.stopLoss,
    takeProfitLevels: ai.takeProfitLevels,
    riskLevel: ai.riskLevel,
    keyFactors: ai.keyFactors,
  };
}

/** Builds the reduced (Free) AI signal — single take-profit, no full ladder. */
function reducedSignal(
  candidate: AnalysisCandidate,
  interval: Interval,
): ReducedTierSignal {
  const ai = ruleBasedAnalysis({ candidate, interval });
  return {
    sentiment: ai.sentiment,
    summary: ai.summary,
    entryRange: ai.entryRange,
    stopLoss: ai.stopLoss,
    // Reduced: keep only the first ladder rung as the single take-profit.
    takeProfit: ai.takeProfitLevels[0] ?? ai.stopLoss,
    riskLevel: ai.riskLevel,
  };
}

/**
 * Runs the scoring engine on a resampled series for a derived tier. Falls back
 * to the raw 1m candidate/indicators when the resampled series is too short to
 * score or produces no candidate of its own, so the derived tier's key is still
 * written (Req 3.6). Returns null only when there is no usable input at all.
 */
function deriveTierResult(params: {
  symbol: string;
  interval: Interval;
  series: Kline[];
  ticker: Ticker24h;
  regime?: MarketRegime;
  fallbackCandidate: AnalysisCandidate;
  fallbackIndicators: IndicatorSnapshot;
}): { candidate: AnalysisCandidate; indicators: IndicatorSnapshot } {
  const { symbol, interval, series, ticker, regime, fallbackCandidate, fallbackIndicators } =
    params;

  if (series.length >= MIN_HISTORY) {
    const { indicators, candidate } = analyzeSymbolInterval({
      symbol,
      interval,
      klines: series,
      ticker,
      regime,
    });
    if (candidate) return { candidate, indicators };
    // Resampled timeframe didn't re-qualify — keep the tier key alive by
    // reusing the 1m candidate, but with the derived-timeframe indicators.
    return { candidate: { ...fallbackCandidate, interval }, indicators };
  }

  // Not enough resampled history to score — fall back to the 1m result.
  return {
    candidate: { ...fallbackCandidate, interval },
    indicators: fallbackIndicators,
  };
}

/**
 * Produces and persists the three tier slices for every scanned symbol that has
 * a 1m candidate. Reads each symbol's 1m window, resamples to 5m/15m, runs the
 * engine per derived timeframe, derives user-agnostic price signals, and calls
 * `writeTierSlices`. Per-symbol failures are isolated so a single bad symbol
 * never breaks the scan.
 */
export async function writeTierSlicesForScan(
  options: SliceScanOptions,
): Promise<void> {
  const ts = options.ts ?? current1mBoundary();
  const { symbols, tickers, regime } = options;

  for (const symbol of symbols) {
    try {
      const ticker = tickers.get(symbol);
      if (!ticker) continue; // No price reference — can't build a slice.

      const klines1m = await readWindow(symbol, "1m");
      if (klines1m.length < MIN_HISTORY) continue;

      // Ultimate = raw 1m.
      const { indicators, candidate } = analyzeSymbolInterval({
        symbol,
        interval: "1m",
        klines: klines1m,
        ticker,
        regime,
      });

      // No qualifying 1m setup → no slice for this symbol (see module header).
      if (!candidate) continue;

      const ultimate: FullTierSlice = {
        tier: "ultimate",
        symbol,
        interval: "1m",
        ts,
        candidate,
        indicators,
        ai: fullSignal(candidate, "1m"),
      };

      // Pro = engine on resampled 5m series (full ladder).
      const pro5m = deriveTierResult({
        symbol,
        interval: "5m",
        series: resampleSeries(klines1m, PRO_FACTOR),
        ticker,
        regime,
        fallbackCandidate: candidate,
        fallbackIndicators: indicators,
      });
      const pro: FullTierSlice = {
        tier: "pro",
        symbol,
        interval: "5m",
        ts,
        candidate: pro5m.candidate,
        indicators: pro5m.indicators,
        ai: fullSignal(pro5m.candidate, "5m"),
      };

      // Free = engine on resampled 15m series (reduced fields).
      const free15m = deriveTierResult({
        symbol,
        interval: "15m",
        series: resampleSeries(klines1m, FREE_FACTOR),
        ticker,
        regime,
        fallbackCandidate: candidate,
        fallbackIndicators: indicators,
      });
      const free: FreeTierSlice = {
        tier: "free",
        symbol,
        interval: "15m",
        ts,
        candidate: free15m.candidate,
        indicators: free15m.indicators,
        ai: reducedSignal(free15m.candidate, "15m"),
      };

      await writeTierSlices({ symbol, ts, ultimate, pro, free });
    } catch {
      // A single symbol's slicing failure must never break the scan.
    }
  }
}
