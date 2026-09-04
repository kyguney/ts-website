// ---------------------------------------------------------------------------
// Binance USDⓈ-M Futures client — REST (fetch) + WebSocket URL helpers.
//
// Ported from the local trade engine's BinanceFuturesService
// (/Users/kyguney/Project-Datas/Trade/binance-trade/src/services/binance.ts),
// re-implemented with the platform-native `fetch` (Node 22) instead of axios,
// and adapted for the combined `/stream` multiplex the production worker uses.
// ---------------------------------------------------------------------------

import type { Interval, Kline, Ticker24h } from "@/lib/market/types";

/** Live vs. testnet base hosts, toggled by BINANCE_USE_TESTNET. */
const MAINNET_REST = "https://fapi.binance.com";
const TESTNET_REST = "https://testnet.binancefuture.com";
const MAINNET_WS = "wss://fstream.binance.com";
const TESTNET_WS = "wss://stream.binancefuture.com";

function useTestnet(): boolean {
  return process.env.BINANCE_USE_TESTNET === "true";
}

export function restBaseUrl(): string {
  return useTestnet() ? TESTNET_REST : MAINNET_REST;
}

export function wsBaseUrl(): string {
  return useTestnet() ? TESTNET_WS : MAINNET_WS;
}

function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "trendscore-market-worker/1.0",
    Accept: "application/json",
  };
  const apiKey = process.env.BINANCE_API_KEY;
  if (apiKey) headers["X-MBX-APIKEY"] = apiKey;
  return headers;
}

/** Maps a raw Binance kline array into the normalized Kline shape. */
function mapRawKline(raw: unknown[]): Kline {
  return {
    openTime: Number(raw[0]),
    open: parseFloat(raw[1] as string),
    high: parseFloat(raw[2] as string),
    low: parseFloat(raw[3] as string),
    close: parseFloat(raw[4] as string),
    volume: parseFloat(raw[5] as string),
    closeTime: Number(raw[6]),
    quoteVolume: parseFloat(raw[7] as string),
    trades: Number(raw[8]),
    isClosed: true, // REST klines are historical/closed.
  };
}

async function getJson<T>(path: string, timeoutMs = 10_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${restBaseUrl()}${path}`, {
      headers: apiHeaders(),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Binance ${path} -> HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch historical klines for a symbol/interval.
 * @param limit number of candles (max 1500).
 */
export async function fetchKlines(
  symbol: string,
  interval: Interval,
  limit = 200,
): Promise<Kline[]> {
  const params = new URLSearchParams({ symbol, interval, limit: String(limit) });
  const raw = await getJson<unknown[][]>(`/fapi/v1/klines?${params.toString()}`);
  return raw.map(mapRawKline);
}

/** Fetch 24h ticker stats for a single symbol. */
export async function fetch24hTicker(symbol: string): Promise<Ticker24h> {
  const params = new URLSearchParams({ symbol });
  return getJson<Ticker24h>(`/fapi/v1/ticker/24hr?${params.toString()}`);
}

/** Fetch 24h ticker stats for many symbols concurrently (bounded). */
export async function fetch24hTickers(
  symbols: string[],
  concurrency = 8,
): Promise<Map<string, Ticker24h>> {
  const result = new Map<string, Ticker24h>();
  let idx = 0;
  const worker = async () => {
    while (idx < symbols.length) {
      const current = idx++;
      const sym = symbols[current];
      try {
        result.set(sym, await fetch24hTicker(sym));
      } catch {
        // Skip symbols that fail; the caller degrades gracefully.
      }
      await new Promise((r) => setTimeout(r, 8));
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, symbols.length) }, () => worker()),
  );
  return result;
}

/** Fetch the last funding rate for a symbol (premiumIndex). */
export async function fetchFundingRate(symbol: string): Promise<number> {
  try {
    const params = new URLSearchParams({ symbol });
    const data = await getJson<{ lastFundingRate: string }>(
      `/fapi/v1/premiumIndex?${params.toString()}`,
    );
    const rate = parseFloat(data.lastFundingRate);
    return Number.isFinite(rate) ? rate : 0;
  } catch {
    return 0;
  }
}

/**
 * Builds the combined multiplex stream URL for the given symbols/intervals.
 * Example: wss://fstream.binance.com/stream?streams=btcusdt@kline_5m/...
 */
export function buildKlineStreamUrl(
  symbols: string[],
  intervals: Interval[],
): string {
  const streams: string[] = [];
  for (const sym of symbols) {
    for (const interval of intervals) {
      streams.push(`${sym.toLowerCase()}@kline_${interval}`);
    }
  }
  return `${wsBaseUrl()}/stream?streams=${streams.join("/")}`;
}

/** The shape of a Binance kline WS payload's `k` object (fields we use). */
export interface RawKlineEvent {
  t: number; // kline open time
  T: number; // kline close time
  s: string; // symbol
  i: Interval; // interval
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  q: string; // quote volume
  n: number; // number of trades
  x: boolean; // is this kline closed?
}

/** Parses a combined-stream kline message into (symbol, interval, Kline). */
export function parseKlineMessage(
  message: unknown,
): { symbol: string; interval: Interval; kline: Kline } | null {
  const data = (message as { data?: { e?: string; k?: RawKlineEvent } })?.data;
  if (!data || data.e !== "kline" || !data.k) return null;
  const k = data.k;
  return {
    symbol: k.s,
    interval: k.i,
    kline: {
      openTime: k.t,
      open: parseFloat(k.o),
      high: parseFloat(k.h),
      low: parseFloat(k.l),
      close: parseFloat(k.c),
      volume: parseFloat(k.v),
      closeTime: k.T,
      quoteVolume: parseFloat(k.q),
      trades: k.n,
      isClosed: k.x,
    },
  };
}
