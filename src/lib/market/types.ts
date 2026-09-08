// ---------------------------------------------------------------------------
// Shared market-analysis types.
//
// Faithfully ported from the local trade engine
// (/Users/kyguney/Project-Datas/Trade/binance-trade/src/types/index.ts) and
// narrowed to what the production ingestion/analysis pipeline needs.
// ---------------------------------------------------------------------------

export type TrendState = "BULLISH" | "NEUTRAL" | "BEARISH";
export type TradeDirection = "LONG" | "SHORT";

/** Supported Binance Futures kline intervals for the worker. */
export type Interval = "5m" | "15m" | "30m" | "1h";

export const INTERVALS: Interval[] = ["5m", "15m", "30m", "1h"];

/** Normalized OHLCV candle. Matches the source engine's `Kline` shape. */
export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
  trades: number;
  /** Only set for streamed candles: whether the candle is finalized. */
  isClosed?: boolean;
}

/** Pattern taxonomy, verbatim from the source engine. */
export type PatternType =
  | "🚀 GOLDEN COILING"
  | "PATERN A (Sıkışma)"
  | "PATERN B (MANTRA Retest)"
  | "PATERN C (Dip Patlaması)"
  | "⚡ EARLY_LONG_ENTRY"
  | "⚡ EARLY_SHORT_ENTRY"
  | "🔻 SHORT A (Direnç Reddi / Retest)"
  | "🔻 SHORT B (Destek Kırılımı / Breakdown)"
  | "🔻 SHORT C (Hacimli Satış Dalgası)";

/** 24h rolling ticker stats (subset of Binance's /ticker/24hr response). */
export interface Ticker24h {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  highPrice: string;
  lowPrice: string;
  quoteVolume: string;
}

/**
 * The indicator snapshot for a single symbol/interval. This is the pure,
 * cacheable output of the indicator layer — no scoring, no side effects.
 */
export interface IndicatorSnapshot {
  price: number;
  ma7: number;
  ma25: number;
  ma99: number;
  ema7: number;
  rsi14: number;
  atr: number;
  atrRatioPct: number;
  volumeSpurtRatio: number;
  coilingSqueezePct: number;
  upperWickRatio: number;
  lowerWickRatio: number;
  hasHighWickRisk: boolean;
  isRedCandle: boolean;
}

/**
 * A qualifying trade setup. Mirrors the source engine's `ScanCandidate`,
 * trimmed to the fields the production pipeline persists and publishes.
 */
export interface AnalysisCandidate {
  symbol: string;
  interval: Interval;
  direction: TradeDirection;
  patternType: PatternType;
  price: number;
  change24hPct: number;
  volume24hUsdt: number;
  high24h: number;
  ma7: number;
  ma25: number;
  ma99: number;
  rsi14: number;
  atrRatioPct: number;
  volumeSpurtRatio: number;
  coilingSqueezePct: number;
  wickRatioPct: number;
  hasHighWickRisk: boolean;
  isVolumeFading: boolean;
  isExhausted: boolean;
  isEarlyPumpBonus: boolean;
  isPreBreakoutSqueeze: boolean;
  distTo24hHighPct: number;
  distToMa25Pct: number;
  score: number;
  statusLabel: string;
}

/** Snapshot persisted to Redis (`market:snapshot:{symbol}:{interval}`). */
export interface MarketSnapshot {
  symbol: string;
  interval: Interval;
  updatedAt: number;
  indicators: IndicatorSnapshot;
  candidate: AnalysisCandidate | null;
}

/** Pub/Sub payload broadcast on the `market:signal` channel. */
export interface MarketSignal {
  symbol: string;
  interval: Interval;
  pattern: PatternType;
  direction: TradeDirection;
  score: number;
  price: number;
  indicators: IndicatorSnapshot;
  timestamp: number;
}

/** Overall market regime, ported from MarketRegimeAgent. */
export interface MarketRegime {
  btcTrend15m: TrendState;
  btcTrend1h: TrendState;
  ethTrend15m: TrendState;
  ethTrend1h: TrendState;
  overallRegime: TrendState;
  isDominanceSurging: boolean;
  totalMarketVolume24hUsdt: number;
}

/**
 * Scanner thresholds. Defaults are copied verbatim from the source engine's
 * DEFAULT_CONFIG so ported detection behaves identically.
 */
export interface ScannerConfig {
  min24hVolumeUsdt: number;
  min24hChangePct: number;
  max24hChangePct: number;
  maxSqueezePctA: number;
  minVolumeSpurtRatioA: number;
  minVolumeSpurtRatioAnomaly: number;
  maxDistTo24hHighPctB: number;
  minFundingRate: number;
  maxFundingRate: number;
}

export const DEFAULT_SCANNER_CONFIG: ScannerConfig = {
  min24hVolumeUsdt: 10_000_000,
  min24hChangePct: 1.0,
  max24hChangePct: 35.0,
  maxSqueezePctA: 2.0,
  minVolumeSpurtRatioA: 1.5,
  minVolumeSpurtRatioAnomaly: 2.0,
  maxDistTo24hHighPctB: 4.0,
  minFundingRate: -0.0001,
  maxFundingRate: 0.00015,
};
