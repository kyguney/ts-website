// ---------------------------------------------------------------------------
// Technical indicator math — pure, typed, side-effect-free functions.
//
// Ported faithfully from the local trade engine's scanner/regime agents
// (/Users/kyguney/Project-Datas/Trade/binance-trade/src/agents/*.ts). Each
// function preserves the source's exact formula, period defaults, and
// insufficient-data fallbacks so ported analysis reproduces the original
// output.
// ---------------------------------------------------------------------------

import type { Kline, IndicatorSnapshot, TrendState } from "@/lib/market/types";

/**
 * Simple Moving Average of the last `period` closes.
 * Returns 0 when there is insufficient history (matches source behavior).
 */
export function sma(klines: Kline[], period: number): number {
  if (klines.length < period) return 0;
  const slice = klines.slice(-period);
  const sum = slice.reduce((acc, k) => acc + k.close, 0);
  return sum / period;
}

/**
 * Exponential Moving Average of closes. The source engine relies on SMAs
 * (MA7/25/99); EMA is added here as a typed helper for the same close series,
 * seeded with the SMA of the first `period` values (standard convention).
 * Returns 0 on insufficient history.
 */
export function ema(klines: Kline[], period: number): number {
  if (klines.length < period) return 0;
  const closes = klines.map((k) => k.close);
  const k = 2 / (period + 1);
  // Seed with SMA of the first `period` closes.
  let prev = closes.slice(0, period).reduce((a, c) => a + c, 0) / period;
  for (let i = period; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
  }
  return prev;
}

/**
 * Wilder-style RSI computed over the last `period` diffs (simple average of
 * gains/losses, exactly as the source engine does).
 * Returns 50 on insufficient history, 100 when there are no losses.
 */
export function rsi(klines: Kline[], period = 14): number {
  if (klines.length < period + 1) return 50;
  const closes = klines.map((k) => k.close);
  let gains = 0;
  let losses = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Average True Range over the last `period` candles.
 * Returns 0 on insufficient history.
 */
export function atr(klines: Kline[], period = 20): number {
  if (klines.length < period + 1) return 0;
  const slice = klines.slice(-(period + 1));
  let trSum = 0;

  for (let i = 1; i < slice.length; i++) {
    const high = slice[i].high;
    const low = slice[i].low;
    const prevClose = slice[i - 1].close;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose),
    );
    trSum += tr;
  }

  return trSum / period;
}

/** ATR expressed as a percentage of the reference price. */
export function atrRatioPct(klines: Kline[], price: number, period = 20): number {
  const value = atr(klines, period);
  return price > 0 ? (value / price) * 100 : 0;
}

/**
 * Short-timeframe Volume Spurt: latest candle volume vs. the average of the
 * previous 20 candles (source `getVolumeSpurt5m`). Returns 1.0 when < 20
 * candles are available.
 */
export function volumeSpurtShort(klines: Kline[]): number {
  if (klines.length < 20) return 1.0;
  const latestVolume = klines[klines.length - 1].volume;
  const slice = klines.slice(-21, -1); // previous 20 candles
  const avgVolume = slice.reduce((acc, k) => acc + k.volume, 0) / slice.length;
  return avgVolume > 0 ? latestVolume / avgVolume : 1.0;
}

/**
 * Relative Volume vs. 24h average (source `getVolumeSpurt15mVs24hAvg`):
 * current 15m volume / average 15m volume over the last 96 candles (24h).
 * Falls back to full-history average when < 96 candles are available.
 */
export function volumeSpurtVs24hAvg(klines: Kline[]): number {
  if (klines.length < 96) {
    if (klines.length === 0) return 1.0;
    const recent = klines[klines.length - 1].volume;
    const avg = klines.reduce((acc, k) => acc + k.volume, 0) / klines.length;
    return avg > 0 ? recent / avg : 1.0;
  }
  const currentVolume = klines[klines.length - 1].volume;
  const slice24h = klines.slice(-96);
  const total24hVolume = slice24h.reduce((acc, k) => acc + k.volume, 0);
  const avg24hVolume = total24hVolume / 96;
  if (avg24hVolume === 0) return 1.0;
  return currentVolume / avg24hVolume;
}

/**
 * MA spread ("coiling" squeeze) as a percentage: the max/min spread across
 * MA7/MA25/MA99 normalized by MA25 (source formula). Returns 0 if MA25 is 0.
 */
export function coilingSqueezePct(ma7: number, ma25: number, ma99: number): number {
  if (ma25 === 0) return 0;
  const maxMA = Math.max(ma7, ma25, ma99);
  const minMA = Math.min(ma7, ma25, ma99);
  return ((maxMA - minMA) / ma25) * 100;
}

export interface WickAnalysis {
  upperWickRatio: number;
  lowerWickRatio: number;
  isRedCandle: boolean;
}

/** Upper/lower wick ratios of a single candle, plus red/green classification. */
export function wickAnalysis(candle: Kline): WickAnalysis {
  const totalRange = candle.high - candle.low;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  return {
    upperWickRatio: totalRange > 0 ? upperWick / totalRange : 0,
    lowerWickRatio: totalRange > 0 ? lowerWick / totalRange : 0,
    isRedCandle: candle.close < candle.open,
  };
}

/**
 * Detects manipulative saw-tooth wick anomalies over the last `lookback`
 * candles (source `hasManipulativeWick`). Extreme wick = > 1.2% of price AND
 * > 5x the candle body.
 */
export function hasManipulativeWick(klines: Kline[], lookback = 4): boolean {
  if (klines.length < lookback) return false;
  const slice = klines.slice(-lookback);
  for (const k of slice) {
    const body = Math.abs(k.close - k.open);
    const totalRange = k.high - k.low;
    const upperWick = k.high - Math.max(k.open, k.close);
    const lowerWick = Math.min(k.open, k.close) - k.low;

    if (totalRange > 0 && k.close > 0) {
      const upperWickPct = (upperWick / k.close) * 100;
      const lowerWickPct = (lowerWick / k.close) * 100;
      if (
        (upperWickPct > 1.2 && upperWick > 5.0 * body) ||
        (lowerWickPct > 1.2 && lowerWick > 5.0 * body)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Pre-breakout squeeze on the short timeframe (source
 * `checkPreBreakoutSqueeze5m`): the 6 candles before the active candle
 * consolidated within a <= 1.8% range.
 */
export function isPreBreakoutSqueeze(klines: Kline[]): boolean {
  if (klines.length < 10) return false;
  const preSlice = klines.slice(-7, -1); // 6 candles before the active one
  const maxHigh = Math.max(...preSlice.map((k) => k.high));
  const minLow = Math.min(...preSlice.map((k) => k.low));
  const avgPrice = (maxHigh + minLow) / 2;
  if (avgPrice <= 0) return false;
  const rangePct = ((maxHigh - minLow) / avgPrice) * 100;
  return rangePct <= 1.8;
}

/**
 * Trend classification from price relative to MA25/MA99 (source
 * `evaluateTrend`). Requires >= 99 candles, else NEUTRAL.
 */
export function evaluateTrend(klines: Kline[]): TrendState {
  if (klines.length < 99) return "NEUTRAL";
  const lastPrice = klines[klines.length - 1].close;
  const ma25 = sma(klines, 25);
  const ma99 = sma(klines, 99);
  if (lastPrice > ma25 && ma25 > ma99) return "BULLISH";
  if (lastPrice < ma25 && ma25 < ma99) return "BEARISH";
  return "NEUTRAL";
}

/**
 * Builds the full indicator snapshot for a symbol/interval from its candle
 * window. `price` is the live/last price (may differ from the last candle
 * close when streaming). Pure and cacheable.
 */
export function buildIndicatorSnapshot(
  klines: Kline[],
  price: number,
): IndicatorSnapshot {
  const ma7 = sma(klines, 7);
  const ma25 = sma(klines, 25);
  const ma99 = sma(klines, 99);
  const last = klines[klines.length - 1];
  const wick = last
    ? wickAnalysis(last)
    : { upperWickRatio: 0, lowerWickRatio: 0, isRedCandle: false };

  return {
    price,
    ma7,
    ma25,
    ma99,
    ema7: ema(klines, 7),
    rsi14: rsi(klines, 14),
    atr: atr(klines, 20),
    atrRatioPct: atrRatioPct(klines, price, 20),
    volumeSpurtRatio: volumeSpurtVs24hAvg(klines),
    coilingSqueezePct: coilingSqueezePct(ma7, ma25, ma99),
    upperWickRatio: wick.upperWickRatio,
    lowerWickRatio: wick.lowerWickRatio,
    hasHighWickRisk: wick.upperWickRatio > 0.4,
    isRedCandle: wick.isRedCandle,
  };
}
