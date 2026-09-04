// ---------------------------------------------------------------------------
// Pattern detection & scoring — pure, typed functions.
//
// Faithfully ported from the local trade engine's MarketScannerAgent.scan()
// (/Users/kyguney/Project-Datas/Trade/binance-trade/src/agents/scanner.ts).
//
// The detection *priority order*, backbone gating, base-score formulas, score
// multipliers/bonuses, exhaustion checks, and status labels are preserved
// verbatim so ported analysis reproduces the source's candidates and scores.
//
// The source scans full-market on 15m as the primary timeframe (with 1h
// backbone + 5m early-entry). This port is timeframe-parameterized: it accepts
// the candle windows for the analysis interval, the 1h backbone window, and an
// optional short (5m) window for early-entry triggers. When called on a single
// interval without the others, it degrades gracefully (skips checks that need
// the missing series), matching the source's insufficient-data guards.
// ---------------------------------------------------------------------------

import {
  sma,
  rsi,
  atrRatioPct,
  volumeSpurtVs24hAvg,
  volumeSpurtShort,
  coilingSqueezePct,
  wickAnalysis,
  hasManipulativeWick,
  isPreBreakoutSqueeze as detectPreBreakoutSqueeze,
} from "@/lib/indicators";
import {
  DEFAULT_SCANNER_CONFIG,
  type AnalysisCandidate,
  type Interval,
  type Kline,
  type PatternType,
  type ScannerConfig,
  type TradeDirection,
} from "@/lib/market/types";

export interface DetectionInput {
  symbol: string;
  interval: Interval;
  /** Primary analysis candle window (source uses 15m). */
  klines: Kline[];
  /** 1h backbone window (>= 168 candles ideal). Optional. */
  klines1h?: Kline[];
  /** Short-timeframe window for early-entry triggers (source uses 5m). Optional. */
  klines5m?: Kline[];
  /** Live/last price. Defaults to the last candle close. */
  price?: number;
  /** 24h stats from the ticker. */
  change24hPct: number;
  high24h: number;
  volume24hUsdt: number;
  fundingRate?: number;
  /** Market-regime context (from MarketRegimeAgent). */
  isBearishRegime?: boolean;
  isDominanceSurging?: boolean;
  config?: ScannerConfig;
}

/**
 * LONG exhaustion / rejection check (source `checkLongExhaustionPenalty`).
 */
function checkLongExhaustion(
  klines: Kline[],
  price: number,
  ma25: number,
  distTo24hHighPct: number,
  changePct: number,
  rsi14: number,
): boolean {
  if (rsi14 > 70) return true;
  if (price < ma25 * 0.998) return true;
  if (distTo24hHighPct > 2.5 || changePct > 10.0) return true;
  if (klines.length < 4) return false;
  const recent4 = klines.slice(-4);
  const localHigh = Math.max(...recent4.map((k) => k.high));
  if (localHigh > 0) {
    const localPullbackPct = ((localHigh - price) / localHigh) * 100;
    if (localPullbackPct > 2.5) return true;
  }
  return false;
}

/**
 * SHORT exhaustion / oversold-trap check (source `checkShortExhaustionPenalty`).
 */
function checkShortExhaustion(
  price: number,
  ma25: number,
  changePct: number,
  rsi14: number,
): boolean {
  if (rsi14 < 25) return true;
  if (price > ma25 * 1.005) return true;
  if (changePct < -15.0) return true;
  return false;
}

/**
 * Human-readable status label (source `getCandidateStatusLabel` +
 * renderDualHunterTable status logic).
 */
export function candidateStatusLabel(c: AnalysisCandidate): string {
  if (c.patternType === "⚡ EARLY_SHORT_ENTRY") {
    return c.isPreBreakoutSqueeze
      ? "🎯 Squeeze + Erken Short (+100)"
      : "⚡ 5m Erken Short Giriş";
  }
  if (c.patternType === "⚡ EARLY_LONG_ENTRY") {
    return c.isPreBreakoutSqueeze
      ? "🎯 Squeeze + Erken Long (+100)"
      : "⚡ 5m Erken Long Giriş";
  }

  if (c.direction === "SHORT") {
    if (c.rsi14 < 25) return "⚠️ Oversold / Trap";
    if (c.isVolumeFading) return "⚠️ Volume Fading (<0.5x)";
    if (c.hasHighWickRisk) return "⚠️ Lower Wick Trap (-30%)";
    if (c.isEarlyPumpBonus) return "🎯 +100 Early Dump";
    if (c.isExhausted) return "🔴 Exhausted (-50%)";
    return "🔻 Short Breakdown";
  }

  if (c.isVolumeFading) return "⚠️ Volume Fading (<0.5x)";
  if (c.hasHighWickRisk) return "⚠️ High Wick Risk (-30%)";
  if (c.isEarlyPumpBonus) return "🎯 +100 Early Bonus";
  if (c.isExhausted) return "🔴 Exhausted (-50%)";
  if (c.patternType === "🚀 GOLDEN COILING") return "🚀 Golden Coiling";
  if (c.patternType === "PATERN B (MANTRA Retest)") return "🎯 MANTRA Retest";
  if (c.patternType === "PATERN C (Dip Patlaması)") return "💥 Dip Patlaması";
  return "🟢 Fresh Surge";
}

/**
 * Runs the full pattern-detection + scoring pipeline for a single symbol on a
 * single analysis interval. Returns a scored candidate, or `null` if no
 * pattern matched (or the data failed the source's guards).
 */
export function detectCandidate(input: DetectionInput): AnalysisCandidate | null {
  const config = input.config ?? DEFAULT_SCANNER_CONFIG;
  const { klines, klines1h, klines5m } = input;
  const isBearishRegime = !!input.isBearishRegime;
  const isDominanceSurging = !!input.isDominanceSurging;

  if (klines.length === 0) return null;

  // Manipulative wick guard (source: `continue`).
  if (hasManipulativeWick(klines, 4)) return null;

  const ma7 = sma(klines, 7);
  const ma25 = sma(klines, 25);
  const ma99 = sma(klines, 99);
  if (ma7 === 0 || ma25 === 0 || ma99 === 0) return null;

  // 1h backbone. When 1h data is unavailable, treat the backbone as neutral so
  // detection still runs on the analysis interval alone.
  let isBullishBackbone = true;
  let isBearishBackbone = false;
  if (klines1h && klines1h.length >= 99) {
    const ma25_1h = sma(klines1h, 25);
    const ma99_1h = sma(klines1h, 99);
    if (ma25_1h === 0 || ma99_1h === 0) return null;
    isBullishBackbone = ma25_1h > ma99_1h;
    isBearishBackbone = ma25_1h < ma99_1h;
  }

  const lastCandle = klines[klines.length - 1];
  const price = input.price ?? lastCandle.close;
  const changePct = input.change24hPct;
  const high24h = input.high24h;
  const distTo24hHighPct =
    high24h > 0 ? ((high24h - price) / high24h) * 100 : 0;

  const squeeze = coilingSqueezePct(ma7, ma25, ma99);
  const volumeSpurtRatio = volumeSpurtVs24hAvg(klines);
  const rsi14 = rsi(klines, 14);
  const atrRatio = atrRatioPct(klines, price, 20);

  const wick = wickAnalysis(lastCandle);
  const upperWickRatio = wick.upperWickRatio;
  const lowerWickRatio = wick.lowerWickRatio;
  const hasHighWickRisk = upperWickRatio > 0.4;
  const isRedCandle = wick.isRedCandle;

  // ---- 5m early-entry pre-computation ------------------------------------
  let ma7_5m = 0;
  let ma25_5m = 0;
  let volumeSpurtRatio5m = 1.0;
  let isPreBreakoutSqueeze = false;
  let impulseLongPct = 0;
  let impulseShortPct = 0;
  let isChasingLong = false;
  let isChasingShort = false;
  const has5m = !!klines5m && klines5m.length >= 25;

  if (has5m && klines5m) {
    ma7_5m = sma(klines5m, 7);
    ma25_5m = sma(klines5m, 25);
    volumeSpurtRatio5m = volumeSpurtShort(klines5m);
    isPreBreakoutSqueeze = detectPreBreakoutSqueeze(klines5m);
    const preSlice5m = klines5m.slice(-7, -1);
    const recentLow5m = Math.min(...preSlice5m.map((k) => k.low));
    const recentHigh5m = Math.max(...preSlice5m.map((k) => k.high));
    impulseLongPct =
      recentLow5m > 0 ? ((price - recentLow5m) / recentLow5m) * 100 : 0;
    impulseShortPct =
      recentHigh5m > 0 ? ((recentHigh5m - price) / recentHigh5m) * 100 : 0;
    isChasingLong = impulseLongPct > 4.0 || changePct > 12.0;
    isChasingShort = impulseShortPct > 4.0 || changePct < -12.0;
  }

  let direction: TradeDirection | null = null;
  let patternType: PatternType | null = null;
  let baseScore = 0;
  let isEarlyPumpBonus = false;
  let isEarlyEntryTrigger = false;

  // ---- Priority 1 & 2: 5m early-entry triggers ---------------------------
  if (has5m && klines5m) {
    const latest5m = klines5m[klines5m.length - 1];
    const isGreen5m = latest5m.close > latest5m.open;
    const isRed5m = latest5m.close < latest5m.open;

    if (
      volumeSpurtRatio5m >= 2.5 &&
      isGreen5m &&
      price >= ma7_5m &&
      price >= ma25_5m &&
      latest5m.close >= ma25_5m * 0.999 &&
      impulseLongPct >= 0.5 &&
      impulseLongPct <= 3.0 &&
      !isChasingLong &&
      rsi14 <= 68
    ) {
      direction = "LONG";
      patternType = "⚡ EARLY_LONG_ENTRY";
      isEarlyEntryTrigger = true;
      baseScore = 160 + volumeSpurtRatio5m * 20 + impulseLongPct * 10;
      if (isPreBreakoutSqueeze) {
        baseScore += 100;
        isEarlyPumpBonus = true;
      }
    } else if (
      volumeSpurtRatio5m >= 2.5 &&
      isRed5m &&
      price <= ma7_5m &&
      price <= ma25_5m &&
      latest5m.close <= ma25_5m * 1.001 &&
      impulseShortPct >= 0.5 &&
      impulseShortPct <= 3.0 &&
      !isChasingShort &&
      rsi14 >= 32
    ) {
      direction = "SHORT";
      patternType = "⚡ EARLY_SHORT_ENTRY";
      isEarlyEntryTrigger = true;
      baseScore = 160 + volumeSpurtRatio5m * 20 + impulseShortPct * 10;
      if (isPreBreakoutSqueeze) {
        baseScore += 100;
        isEarlyPumpBonus = true;
      }
    }
  }

  // ---- Priority 3: SHORT patterns ----------------------------------------
  if (!patternType) {
    const isShortBackboneEligible =
      isBearishBackbone || price <= ma25 * 1.002;
    if (isShortBackboneEligible) {
      if (
        rsi14 >= 30 &&
        rsi14 <= 48 &&
        volumeSpurtRatio >= 1.5 &&
        isRedCandle &&
        price <= ma25 * 1.002 &&
        lowerWickRatio < 0.4
      ) {
        direction = "SHORT";
        patternType = "🔻 SHORT C (Hacimli Satış Dalgası)";
        baseScore = 130 + volumeSpurtRatio * 25 + (50 - rsi14) * 2;
      } else if (
        rsi14 >= 35 &&
        rsi14 <= 52 &&
        lastCandle.high >= ma7 * 0.998 &&
        price < ma7 &&
        ma7 < ma25 &&
        lowerWickRatio < 0.45
      ) {
        direction = "SHORT";
        patternType = "🔻 SHORT A (Direnç Reddi / Retest)";
        baseScore = 120 + volumeSpurtRatio * 20 + (50 - rsi14) * 2;
      } else if (
        rsi14 >= 30 &&
        rsi14 <= 50 &&
        price <= ma25 &&
        price <= ma99 &&
        volumeSpurtRatio >= 1.5 &&
        lowerWickRatio < 0.4
      ) {
        direction = "SHORT";
        patternType = "🔻 SHORT B (Destek Kırılımı / Breakdown)";
        baseScore = 125 + volumeSpurtRatio * 22 + (50 - rsi14) * 2;
      }
    }
  }

  // ---- Priority 4: LONG patterns -----------------------------------------
  if (!patternType && isBullishBackbone && price >= ma25 * 0.998) {
    const isVolFadingLong = distTo24hHighPct <= 4.0 && volumeSpurtRatio < 0.5;
    if (
      rsi14 >= 55 &&
      rsi14 <= 70 &&
      !hasHighWickRisk &&
      atrRatio < 1.5 &&
      !isVolFadingLong
    ) {
      direction = "LONG";
      patternType = "PATERN C (Dip Patlaması)";
      baseScore = 130 + volumeSpurtRatio * 25 + (rsi14 - 50) * 2.0;
    } else if (
      rsi14 <= 70 &&
      !hasHighWickRisk &&
      squeeze < 1.5 &&
      price >= ma99 * 0.998 &&
      volumeSpurtRatio > 1.8 &&
      !isVolFadingLong
    ) {
      direction = "LONG";
      patternType = "🚀 GOLDEN COILING";
      baseScore =
        100 +
        (1 / (squeeze + 0.05)) * 40 +
        volumeSpurtRatio * 30 +
        changePct * 2.0;
    } else if (
      rsi14 <= 70 &&
      !hasHighWickRisk &&
      squeeze <= config.maxSqueezePctA &&
      volumeSpurtRatio >= config.minVolumeSpurtRatioA
    ) {
      direction = "LONG";
      patternType = "PATERN A (Sıkışma)";
      baseScore =
        (1 / (squeeze + 0.05)) * 40 + volumeSpurtRatio * 30 + changePct * 2.0;
    } else if (
      !isDominanceSurging &&
      !hasHighWickRisk &&
      rsi14 >= 40 &&
      rsi14 <= 60 &&
      distTo24hHighPct <= config.maxDistTo24hHighPctB &&
      price >= ma7 * 0.995
    ) {
      direction = "LONG";
      patternType = "PATERN B (MANTRA Retest)";
      baseScore =
        (1 / (distTo24hHighPct + 0.05)) * 40 +
        volumeSpurtRatio * 25 +
        changePct * 2.5;
    }
  }

  if (!patternType || !direction) return null;

  const distToMa25Pct = ((price - ma25) / ma25) * 100;

  // ---- Score adjustments (bonuses & penalties) ---------------------------
  let score = baseScore;
  const isVolumeFading =
    direction === "LONG"
      ? distTo24hHighPct <= 4.0 && volumeSpurtRatio < 0.5
      : volumeSpurtRatio < 0.5;
  let isExhausted = false;

  if (direction === "LONG") {
    if (
      !isEarlyEntryTrigger &&
      volumeSpurtRatio >= 3.0 &&
      changePct >= 1.0 &&
      changePct <= 6.0
    ) {
      isEarlyPumpBonus = true;
      score += 100;
    }
    if (hasHighWickRisk) score *= 0.7;
    if (isVolumeFading && !isEarlyEntryTrigger) score *= 0.75;
    if (isBearishRegime && !isEarlyEntryTrigger) score *= 0.85;
    isExhausted = checkLongExhaustion(
      klines,
      price,
      ma25,
      distTo24hHighPct,
      changePct,
      rsi14,
    );
    if (isExhausted) score *= 0.5;
  } else {
    if (
      !isEarlyEntryTrigger &&
      volumeSpurtRatio >= 3.0 &&
      changePct <= -1.0 &&
      changePct >= -6.0
    ) {
      isEarlyPumpBonus = true;
      score += 100;
    }
    if (lowerWickRatio > 0.4) score *= 0.7;
    if (isVolumeFading && !isEarlyEntryTrigger) score *= 0.75;
    if (isBearishRegime) score *= 1.15;
    isExhausted = checkShortExhaustion(price, ma25, changePct, rsi14);
    if (isExhausted) score *= 0.5;
  }

  // For SHORT setups the source tracks the *lower* wick as the wick-risk axis.
  const wickRatioPct =
    direction === "SHORT" ? lowerWickRatio * 100 : upperWickRatio * 100;
  const effectiveHighWickRisk =
    direction === "SHORT" ? lowerWickRatio > 0.4 : hasHighWickRisk;

  const candidate: AnalysisCandidate = {
    symbol: input.symbol,
    interval: input.interval,
    direction,
    patternType,
    price,
    change24hPct: changePct,
    volume24hUsdt: input.volume24hUsdt,
    high24h,
    ma7,
    ma25,
    ma99,
    rsi14,
    atrRatioPct: atrRatio,
    volumeSpurtRatio,
    coilingSqueezePct: squeeze,
    wickRatioPct,
    hasHighWickRisk: effectiveHighWickRisk,
    isVolumeFading,
    isExhausted,
    isEarlyPumpBonus,
    isPreBreakoutSqueeze,
    distTo24hHighPct,
    distToMa25Pct,
    score,
    statusLabel: "",
  };

  candidate.statusLabel = candidateStatusLabel(candidate);
  return candidate;
}

/**
 * Sorts candidates the way the source does: non-exhausted first, then by
 * descending score.
 */
export function sortCandidates(candidates: AnalysisCandidate[]): AnalysisCandidate[] {
  return [...candidates].sort((a, b) => {
    if (a.isExhausted !== b.isExhausted) return a.isExhausted ? 1 : -1;
    return b.score - a.score;
  });
}
