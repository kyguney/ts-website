// ---------------------------------------------------------------------------
// Public (unauthenticated) market data for the marketing landing page.
//
// The authenticated feed (`/api/analysis/feed`) is per-user and tier-gated, so
// it cannot power a public landing page. This module derives lightweight,
// public-safe views from the same sources the worker already populates:
//   • Binance public REST (klines / 24h tickers) — no API key required.
//   • Redis snapshots / signal pub-sub cache — read-only, best-effort.
//
// Every function degrades gracefully: if Binance is unreachable or Redis is
// unavailable, callers fall back to representative sample data so the landing
// page always renders (with a "sample data" affordance in the UI).
// ---------------------------------------------------------------------------

import {
  fetchKlines,
  fetch24hTicker,
  fetch24hTickers,
  fetchAll24hTickers,
  discoverTradableSymbols,
} from "@/lib/market/binance";
import { analyzeSymbolInterval, computeRegime } from "@/lib/market/engine";
import { sortCandidates } from "@/lib/patterns";
import { REGIME_SYMBOLS } from "@/lib/market/config";
import type { AnalysisCandidate, Interval, Kline } from "@/lib/market/types";
import {
  readSnapshotsByInterval,
  readWindow,
} from "@/lib/market/redis-pipeline";

/** Intervals exposed by the public hero chart timeframe toggles. */
export const PUBLIC_INTERVALS = ["15m", "1h", "4h", "1d"] as const;
export type PublicInterval = (typeof PUBLIC_INTERVALS)[number];

/** A single OHLC point for the public hero chart (trimmed Kline). */
export interface PublicCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface PublicChartResponse {
  symbol: string;
  interval: PublicInterval;
  candles: PublicCandle[];
  /** Latest close price. */
  price: number;
  /** 24h percent change. */
  changePct: number;
  /** Derived TrendScore gauge value (0..100) + label. */
  score: number;
  scoreLabel: "Bullish" | "Bearish" | "Neutral";
  /** Momentum / volume meter values (0..100) for the gauge sidebar. */
  momentum: number;
  volume: number;
  /** Whether the payload is live (from Binance) or sample fallback. */
  live: boolean;
}

export interface PublicRegime {
  status: "BULLISH" | "BEARISH" | "NEUTRAL";
  emoji: string;
  /** Total market 24h volume in USDT. */
  totalVolumeUsdt: number;
  live: boolean;
}

export interface PublicTicker {
  symbol: string;
  label: string;
  price: number;
  changePct: number;
  score: number;
  scoreLabel: "Bullish" | "Bearish" | "Neutral";
  spark: number[];
  live: boolean;
}

export interface PublicSignal {
  symbol: string;
  label: string;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  interval: string;
  score: number;
  price: number;
  spark: number[];
  updatedAt: number;
  live: boolean;
}

/** Maps our public interval labels to Binance-supported intervals. */
const BINANCE_INTERVAL: Record<PublicInterval, string> = {
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  "1d": "1d",
};

/** Human labels for the ticker/signal cards. */
export const ASSET_LABELS: Record<string, string> = {
  BTCUSDT: "Bitcoin",
  ETHUSDT: "Ethereum",
  SOLUSDT: "Solana",
  BNBUSDT: "BNB Chain",
};

/** RSI-lite momentum proxy from recent closes (0..100). */
function momentumFromCloses(closes: number[]): number {
  if (closes.length < 2) return 50;
  let up = 0;
  let down = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) up += d;
    else down -= d;
  }
  const total = up + down;
  if (total === 0) return 50;
  return Math.round((up / total) * 100);
}

/** Volume energy proxy: recent avg volume vs. window avg (0..100). */
function volumeEnergy(candles: Kline[]): number {
  if (candles.length < 10) return 50;
  const vols = candles.map((c) => c.volume);
  const recent = vols.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const base = vols.reduce((a, b) => a + b, 0) / vols.length;
  if (base === 0) return 50;
  return Math.max(0, Math.min(100, Math.round((recent / base) * 50)));
}

/**
 * Derives a 0..100 TrendScore + label from momentum and short-term trend.
 * This is a public, simplified proxy — NOT the proprietary engine score.
 */
function deriveScore(
  changePct: number,
  momentum: number,
): { score: number; label: "Bullish" | "Bearish" | "Neutral" } {
  const trendBias = Math.max(-15, Math.min(15, changePct)) / 15; // -1..1
  const raw = momentum * 0.7 + (trendBias * 0.5 + 0.5) * 100 * 0.3;
  const score = Math.max(1, Math.min(100, Math.round(raw)));
  const label = score >= 60 ? "Bullish" : score <= 42 ? "Bearish" : "Neutral";
  return { score, label };
}

// ---------------------------------------------------------------------------
// Sample fallbacks (used when Binance/Redis are unreachable).
// ---------------------------------------------------------------------------

function sampleCandles(base: number, n = 60): PublicCandle[] {
  const out: PublicCandle[] = [];
  let price = base;
  const now = Date.now();
  for (let i = n - 1; i >= 0; i--) {
    const drift = Math.sin(i / 5) * base * 0.004 + (Math.random() - 0.45) * base * 0.003;
    const o = price;
    const c = price + drift;
    const h = Math.max(o, c) + Math.abs(drift) * 0.6;
    const l = Math.min(o, c) - Math.abs(drift) * 0.6;
    out.push({ t: now - i * 60_000, o, h, l, c });
    price = c;
  }
  return out;
}

const SAMPLE_BASE: Record<string, number> = {
  BTCUSDT: 68342,
  ETHUSDT: 3197,
  SOLUSDT: 154.28,
  BNBUSDT: 593.41,
};

export function sampleChart(
  symbol: string,
  interval: PublicInterval,
): PublicChartResponse {
  const base = SAMPLE_BASE[symbol] ?? 100;
  const candles = sampleCandles(base);
  const closes = candles.map((c) => c.c);
  const momentum = momentumFromCloses(closes);
  const changePct = 1.52;
  const { score, label } = deriveScore(changePct, 78);
  return {
    symbol,
    interval,
    candles,
    price: closes[closes.length - 1],
    changePct,
    score: 84,
    scoreLabel: "Bullish",
    momentum,
    volume: 72,
    live: false,
  };
}

// ---------------------------------------------------------------------------
// Live fetchers.
// ---------------------------------------------------------------------------

export async function getPublicChart(
  symbol: string,
  interval: PublicInterval,
): Promise<PublicChartResponse> {
  try {
    const [klines, ticker] = await Promise.all([
      fetchKlines(symbol, BINANCE_INTERVAL[interval] as Interval, 60),
      fetch24hTicker(symbol).catch(() => null),
    ]);
    if (!klines.length) return sampleChart(symbol, interval);

    const candles: PublicCandle[] = klines.map((k) => ({
      t: k.openTime,
      o: k.open,
      h: k.high,
      l: k.low,
      c: k.close,
    }));
    const closes = klines.map((k) => k.close);
    const price = ticker ? parseFloat(ticker.lastPrice) : closes[closes.length - 1];
    const changePct = ticker ? parseFloat(ticker.priceChangePercent) : 0;
    const momentum = momentumFromCloses(closes);
    const volume = volumeEnergy(klines);
    const { score, label } = deriveScore(changePct, momentum);
    return {
      symbol,
      interval,
      candles,
      price,
      changePct,
      score,
      scoreLabel: label,
      momentum,
      volume,
      live: true,
    };
  } catch {
    return sampleChart(symbol, interval);
  }
}

export async function getPublicRegime(): Promise<PublicRegime> {
  try {
    // Total market volume mirrors the trade engine EXACTLY: sum quoteVolume
    // across the ENTIRE 24h ticker universe (all futures symbols, no filter) —
    // this reproduces `tickers.reduce(...)` over `get24hTickers()` in the engine
    // so the landing figure matches the TrendScore app value.
    const tickers = await fetchAll24hTickers();
    if (!tickers.length) throw new Error("no tickers");

    const totalVolumeUsdt = tickers.reduce((sum, t) => {
      const vol = parseFloat(t.quoteVolume);
      return sum + (Number.isFinite(vol) ? vol : 0);
    }, 0);

    // Trend from BTC's 24h change (fast, single lookup from the same payload).
    const btc = tickers.find((t) => t.symbol === "BTCUSDT");
    const btcChange = btc ? parseFloat(btc.priceChangePercent) : 0;
    const status: PublicRegime["status"] =
      btcChange > 0.8 ? "BULLISH" : btcChange < -0.8 ? "BEARISH" : "NEUTRAL";
    const emoji =
      status === "BULLISH" ? "🚀" : status === "BEARISH" ? "🔻" : "⚖️";
    return { status, emoji, totalVolumeUsdt, live: true };
  } catch {
    return {
      status: "BULLISH",
      emoji: "🚀",
      totalVolumeUsdt: 53.48e9,
      live: false,
    };
  }
}

export async function getPublicTickers(): Promise<PublicTicker[]> {
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"];
  const results = await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const [klines, ticker] = await Promise.all([
          fetchKlines(symbol, "15m" as Interval, 24),
          fetch24hTicker(symbol).catch(() => null),
        ]);
        const closes = klines.map((k) => k.close);
        const price = ticker
          ? parseFloat(ticker.lastPrice)
          : closes[closes.length - 1] ?? SAMPLE_BASE[symbol];
        const changePct = ticker ? parseFloat(ticker.priceChangePercent) : 0;
        const momentum = momentumFromCloses(closes);
        const { score, label } = deriveScore(changePct, momentum);
        const spark = closes.length ? closes : sampleCandles(SAMPLE_BASE[symbol], 24).map((c) => c.c);
        return {
          symbol,
          label: ASSET_LABELS[symbol] ?? symbol,
          price,
          changePct,
          score,
          scoreLabel: label,
          spark,
          live: closes.length > 0,
        } satisfies PublicTicker;
      } catch {
        const spark = sampleCandles(SAMPLE_BASE[symbol], 24).map((c) => c.c);
        return {
          symbol,
          label: ASSET_LABELS[symbol] ?? symbol,
          price: SAMPLE_BASE[symbol],
          changePct: 0,
          score: 55,
          scoreLabel: "Neutral" as const,
          spark,
          live: false,
        } satisfies PublicTicker;
      }
    }),
  );
  return results;
}

/**
 * Top-3 live signals. Resolution order:
 *   1. Redis scanner snapshots (populated by the market worker) — cheapest.
 *   2. On-demand LIVE scan against Binance REST (no Redis needed) — the same
 *      ported pattern/scoring engine the worker uses, run inline.
 *   3. Representative sample signals — only if both Binance and Redis fail.
 */
export async function getPublicSignals(): Promise<PublicSignal[]> {
  // 1. Redis snapshots (if the worker has populated them).
  try {
    const snapshots = await readSnapshotsByInterval("15m" as Interval);
    const withCandidate = snapshots.filter((s) => s.candidate);
    if (withCandidate.length > 0) {
      const top = withCandidate
        .sort((a, b) => (b.candidate!.score ?? 0) - (a.candidate!.score ?? 0))
        .slice(0, 3);
      // Attach a REAL sparkline from each symbol's cached candle window (the
      // worker keeps it fresh), falling back to the MA-derived curve if the
      // window is empty.
      return await Promise.all(
        top.map(async (s) => {
          const c = s.candidate!;
          let spark: number[] | undefined;
          try {
            const window = await readWindow(c.symbol, c.interval);
            if (window.length >= 2) {
              spark = window.slice(-24).map((k) => k.close);
            }
          } catch {
            spark = undefined;
          }
          return signalFromCandidate(c, s.updatedAt, spark);
        }),
      );
    }
  } catch {
    // fall through to live scan
  }

  // 2. Live scan against Binance REST (works even with an empty Redis).
  try {
    const { candidates, sparks } = await runLiveScanCached();
    if (candidates.length > 0) {
      const now = Date.now();
      return candidates
        .slice(0, 3)
        .map((c) => signalFromCandidate(c, now, sparks.get(c.symbol)));
    }
  } catch {
    // fall through to sample
  }

  // 3. Last-resort sample data.
  return SAMPLE_SIGNALS;
}

/** Maps a scored engine candidate to the public signal shape. */
function signalFromCandidate(
  c: AnalysisCandidate,
  updatedAt: number,
  spark?: number[],
): PublicSignal {
  return {
    symbol: c.symbol,
    label: ASSET_LABELS[c.symbol] ?? c.symbol,
    direction: c.direction as PublicSignal["direction"],
    interval: c.interval,
    score: Math.round(c.score),
    price: c.price,
    // Prefer a real recent-close sparkline (from the live scan's klines);
    // otherwise derive a public-safe curve from the candidate's MA context.
    spark:
      spark && spark.length >= 2
        ? spark
        : buildSparkFromCandidate(c.price, c.ma7, c.ma25, c.ma99),
    updatedAt,
    live: true,
  };
}

// ---------------------------------------------------------------------------
// Live scan (Binance REST → ported engine). Cached briefly in-process so a
// burst of landing requests doesn't trigger a scan storm against Binance.
// ---------------------------------------------------------------------------

interface LiveScanResult {
  candidates: AnalysisCandidate[];
  /** symbol -> recent close sparkline (from the analysis-interval klines). */
  sparks: Map<string, number[]>;
}

const LIVE_SCAN_TTL_MS = 45_000;
let liveScanCache: { at: number; result: LiveScanResult } | null = null;
let liveScanInFlight: Promise<LiveScanResult> | null = null;

/** Returns cached live-scan candidates, or runs a fresh scan (deduped). */
async function runLiveScanCached(): Promise<LiveScanResult> {
  const now = Date.now();
  if (liveScanCache && now - liveScanCache.at < LIVE_SCAN_TTL_MS) {
    return liveScanCache.result;
  }
  // Coalesce concurrent callers onto a single in-flight scan.
  if (!liveScanInFlight) {
    liveScanInFlight = runLiveScan()
      .then((result) => {
        liveScanCache = { at: Date.now(), result };
        return result;
      })
      .finally(() => {
        liveScanInFlight = null;
      });
  }
  return liveScanInFlight;
}

/**
 * Runs one live scan pass over the top-volume crypto USDT perps using the same
 * ported detection/scoring engine as the worker — no Redis. Faithful setup:
 * 15m analysis timeframe with a 1h backbone and 5m early-entry window. Returns
 * ranked candidates (non-exhausted first, then score desc).
 */
async function runLiveScan(): Promise<LiveScanResult> {
  const interval: Interval = "15m";
  // Keep the universe small so a single request stays well within timeout.
  const symbols = await discoverTradableSymbols({
    alwaysInclude: REGIME_SYMBOLS,
    limit: 24,
  });

  // One batched ticker fetch for the whole universe.
  const tickers = await fetch24hTickers(symbols);

  // Optional regime context from BTC/ETH.
  let regime: ReturnType<typeof computeRegime> | undefined;
  try {
    const [btc15m, btc1h, eth15m, eth1h] = await Promise.all([
      fetchKlines("BTCUSDT", "15m", 170),
      fetchKlines("BTCUSDT", "1h", 170),
      fetchKlines("ETHUSDT", "15m", 170),
      fetchKlines("ETHUSDT", "1h", 170),
    ]);
    if (btc15m.length && eth15m.length) {
      regime = computeRegime({ btc15m, btc1h, eth15m, eth1h });
    }
  } catch {
    regime = undefined;
  }

  // Analyze each symbol with bounded concurrency.
  const candidates: AnalysisCandidate[] = [];
  const sparks = new Map<string, number[]>();
  const CONCURRENCY = 8;
  let cursor = 0;
  const worker = async () => {
    while (cursor < symbols.length) {
      const symbol = symbols[cursor++];
      const ticker = tickers.get(symbol);
      if (!ticker) continue;
      try {
        const [klines, klines1h, klines5m] = await Promise.all([
          fetchKlines(symbol, interval, 120),
          fetchKlines(symbol, "1h", 170),
          fetchKlines(symbol, "5m", 60),
        ]);
        if (klines.length < 25) continue;
        const { candidate } = analyzeSymbolInterval({
          symbol,
          interval,
          klines,
          klines1h: klines1h.length ? klines1h : undefined,
          klines5m: klines5m.length ? klines5m : undefined,
          ticker,
          regime,
        });
        if (candidate) {
          candidates.push(candidate);
          // Keep the last ~24 closes as a real sparkline for the signal card.
          sparks.set(symbol, klines.slice(-24).map((k) => k.close));
        }
      } catch {
        // Skip transient per-symbol REST errors; the scan degrades gracefully.
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, symbols.length) }, () => worker()),
  );

  return { candidates: sortCandidates(candidates), sparks };
}

/** Synthesizes a short sparkline curve from a candidate's MA context. */
function buildSparkFromCandidate(
  price: number,
  ma7: number,
  ma25: number,
  ma99: number,
): number[] {
  const anchors = [ma99, ma25, ma7, price].filter((n) => Number.isFinite(n) && n > 0);
  if (anchors.length < 2) return [price, price];
  const out: number[] = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    for (let s = 0; s < 6; s++) {
      const t = s / 6;
      out.push(a + (b - a) * t);
    }
  }
  out.push(price);
  return out;
}

const now = Date.now();
export const SAMPLE_SIGNALS: PublicSignal[] = [
  {
    symbol: "BTCUSDT",
    label: "Bitcoin",
    direction: "LONG",
    interval: "4h",
    score: 84,
    price: 68342.5,
    spark: [67200, 67400, 67300, 67800, 68050, 68100, 68342.5],
    updatedAt: now - 3 * 60_000,
    live: false,
  },
  {
    symbol: "ETHUSDT",
    label: "Ethereum",
    direction: "SHORT",
    interval: "1h",
    score: 62,
    price: 3197.24,
    spark: [3260, 3245, 3230, 3210, 3205, 3200, 3197.24],
    updatedAt: now - 6 * 60_000,
    live: false,
  },
  {
    symbol: "SOLUSDT",
    label: "Solana",
    direction: "NEUTRAL",
    interval: "4h",
    score: 48,
    price: 154.28,
    spark: [153, 154, 153.5, 154.2, 153.9, 154.1, 154.28],
    updatedAt: now - 9 * 60_000,
    live: false,
  },
];
