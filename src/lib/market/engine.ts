// ---------------------------------------------------------------------------
// Analysis engine — glues the indicator layer, pattern layer, and regime
// analysis into a single reusable pass. Used by both the streaming worker and
// the CLI verification script so their results are guaranteed identical.
// ---------------------------------------------------------------------------

import { buildIndicatorSnapshot, evaluateTrend } from "@/lib/indicators";
import { detectCandidate } from "@/lib/patterns";
import type {
  AnalysisCandidate,
  IndicatorSnapshot,
  Interval,
  Kline,
  MarketRegime,
  Ticker24h,
  TrendState,
} from "@/lib/market/types";

export interface AnalyzeParams {
  symbol: string;
  interval: Interval;
  klines: Kline[];
  klines1h?: Kline[];
  klines5m?: Kline[];
  ticker: Ticker24h;
  regime?: MarketRegime;
}

export interface AnalyzeResult {
  indicators: IndicatorSnapshot;
  candidate: AnalysisCandidate | null;
}

/**
 * Computes the indicator snapshot and (optionally) a scored candidate for one
 * symbol/interval. `price` is taken from the live ticker (source uses ticker
 * lastPrice as the reference price).
 */
export function analyzeSymbolInterval(params: AnalyzeParams): AnalyzeResult {
  const { symbol, interval, klines, klines1h, klines5m, ticker, regime } = params;

  const price = parseFloat(ticker.lastPrice);
  const change24hPct = parseFloat(ticker.priceChangePercent);
  const high24h = parseFloat(ticker.highPrice);
  const volume24hUsdt = parseFloat(ticker.quoteVolume);

  const indicators = buildIndicatorSnapshot(klines, price);

  const candidate = detectCandidate({
    symbol,
    interval,
    klines,
    klines1h,
    klines5m,
    price,
    change24hPct,
    high24h,
    volume24hUsdt,
    isBearishRegime: regime?.overallRegime === "BEARISH",
    isDominanceSurging: regime?.isDominanceSurging,
  });

  return { indicators, candidate };
}

/**
 * Derives the overall market regime from BTC/ETH candle windows, ported from
 * MarketRegimeAgent.analyzeRegime (BTCDOM omitted; dominance surge conservative).
 */
export function computeRegime(input: {
  btc15m: Kline[];
  btc1h: Kline[];
  eth15m: Kline[];
  eth1h: Kline[];
  totalMarketVolume24hUsdt?: number;
}): MarketRegime {
  const btcTrend15m = evaluateTrend(input.btc15m);
  const btcTrend1h = evaluateTrend(input.btc1h);
  const ethTrend15m = evaluateTrend(input.eth15m);
  const ethTrend1h = evaluateTrend(input.eth1h);

  let overallRegime: TrendState = "NEUTRAL";
  if (
    (btcTrend1h === "BULLISH" || btcTrend15m === "BULLISH") &&
    (ethTrend1h === "BULLISH" || ethTrend15m === "BULLISH")
  ) {
    overallRegime = "BULLISH";
  } else if (btcTrend1h === "BEARISH" && ethTrend1h === "BEARISH") {
    overallRegime = "BEARISH";
  }

  return {
    btcTrend15m,
    btcTrend1h,
    ethTrend15m,
    ethTrend1h,
    overallRegime,
    isDominanceSurging: false,
    totalMarketVolume24hUsdt: input.totalMarketVolume24hUsdt ?? 0,
  };
}
