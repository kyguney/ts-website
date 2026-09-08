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

// ---------------------------------------------------------------------------
// Dynamic symbol-universe discovery.
//
// Ported from the trade engine (MarketScannerAgent.scan + isCryptoOnly): the
// tradable universe is discovered live from Binance every refresh rather than
// pinned to a static list. We fetch all 24h tickers, keep only genuine crypto
// USDT perps (exchangeInfo underlyingType === 'COIN', minus stablecoins and a
// non-crypto base-asset blacklist), then qualify by volume / |change| / funding.
// ---------------------------------------------------------------------------

/** Stablecoin / fiat pairs to exclude (no directional edge to trade). */
const STABLECOIN_BLACKLIST = new Set<string>([
  "USDCUSDT", "FDUSDUSDT", "TUSDUSDT", "EURUSDT", "BUSDUSDT", "DAIUSDT",
  "USDPUSDT", "AEURUSDT", "USTCUSDT", "EURIUSDT", "USDEUSDT", "USD1USDT",
  // Bare base assets:
  "USDC", "FDUSD", "TUSD", "EUR", "BUSD", "DAI", "USDP", "AEUR", "EURI",
]);

/**
 * Non-crypto base assets: precious metals, commodities, synthetic/index, and
 * equity/stock-perp tickers. Belt-and-suspenders alongside the underlyingType
 * check (some listings don't set it reliably).
 */
const NON_CRYPTO_BASE_ASSETS = new Set<string>([
  // Metals / commodities / energy
  "XAU", "PAXG", "XAUT", "XAG", "XPT", "XPD", "COPPER", "CL", "BZ", "NATGAS",
  // Synthetic / index
  "DEFI", "BTCDOM", "ALL",
  // Equities / stock perps (subset — the underlyingType gate covers the rest)
  "MSFT", "GOOGL", "GOOG", "NVDA", "AAPL", "TSLA", "AMZN", "META", "NFLX",
  "COIN", "MSTR", "PLTR", "TSM", "AMD", "INTC", "SPY", "QQQ",
]);

/** Binance /fapi/v1/exchangeInfo symbol entry (fields we use). */
interface ExchangeInfoSymbol {
  symbol: string;
  contractType?: string;
  status?: string;
  underlyingType?: string;
}

let exchangeInfoCache: Map<string, ExchangeInfoSymbol> | null = null;

/** Fetches (and caches) the exchangeInfo map: symbol -> metadata. */
export async function getExchangeInfoMap(
  forceRefresh = false,
): Promise<Map<string, ExchangeInfoSymbol>> {
  if (exchangeInfoCache && !forceRefresh) return exchangeInfoCache;
  const data = await getJson<{ symbols?: ExchangeInfoSymbol[] }>(
    "/fapi/v1/exchangeInfo",
    15_000,
  );
  const map = new Map<string, ExchangeInfoSymbol>();
  for (const s of data.symbols ?? []) map.set(s.symbol, s);
  exchangeInfoCache = map;
  return map;
}

/** Fetches ALL 24h tickers (the raw tradable universe). */
export async function fetchAll24hTickers(): Promise<Ticker24h[]> {
  return getJson<Ticker24h[]>("/fapi/v1/ticker/24hr", 15_000);
}

/** Fetches the funding-rate map for ALL symbols (premiumIndex, no arg). */
export async function fetchPremiumIndexMap(): Promise<Map<string, number>> {
  const rows = await getJson<Array<{ symbol: string; lastFundingRate: string }>>(
    "/fapi/v1/premiumIndex",
    15_000,
  );
  const map = new Map<string, number>();
  for (const r of rows) {
    const rate = parseFloat(r.lastFundingRate);
    map.set(r.symbol, Number.isFinite(rate) ? rate : 0);
  }
  return map;
}

/**
 * True only for genuine crypto USDT perps. Rejects stablecoins, non-crypto
 * base assets, and anything whose exchangeInfo underlyingType isn't 'COIN'
 * (filters out stock / index / commodity perps).
 */
export function isCryptoOnly(
  symbol: string,
  infoMap: Map<string, ExchangeInfoSymbol>,
): boolean {
  if (!symbol.endsWith("USDT")) return false;
  if (STABLECOIN_BLACKLIST.has(symbol)) return false;

  const base = symbol.slice(0, -"USDT".length);
  if (STABLECOIN_BLACKLIST.has(base)) return false;
  if (NON_CRYPTO_BASE_ASSETS.has(base)) return false;

  const info = infoMap.get(symbol);
  if (info) {
    // PERPETUAL contracts only; skip delivery futures.
    if (info.contractType && info.contractType !== "PERPETUAL") return false;
    if (info.status && info.status !== "TRADING") return false;
    if (info.underlyingType && info.underlyingType.toUpperCase() !== "COIN") {
      return false;
    }
  }
  return true;
}

/** Qualification thresholds for the tradable universe (env-overridable). */
export interface UniverseFilter {
  min24hVolumeUsdt: number;
  max24hChangePct: number;
  minFundingRate: number;
  maxFundingRate: number;
}

/** Defaults copied from the trade engine's DEFAULT_CONFIG. */
export const DEFAULT_UNIVERSE_FILTER: UniverseFilter = {
  min24hVolumeUsdt: 10_000_000,
  max24hChangePct: 35.0,
  minFundingRate: -0.0001,
  maxFundingRate: 0.00015,
};

export interface DiscoverOptions {
  filter?: Partial<UniverseFilter>;
  /** Symbols always kept regardless of filters (e.g. BTC/ETH for regime). */
  alwaysInclude?: string[];
  /** Hard cap on the number of symbols returned (highest volume first). */
  limit?: number;
}

/**
 * Discovers the tradable symbol universe live from Binance, mirroring the
 * trade engine: all tickers → crypto-only → volume/|change|/funding filters,
 * sorted by 24h quote volume (desc). `alwaysInclude` symbols are appended even
 * if they don't pass the filters (so regime symbols are always present).
 */
export async function discoverTradableSymbols(
  opts: DiscoverOptions = {},
): Promise<string[]> {
  const filter = { ...DEFAULT_UNIVERSE_FILTER, ...opts.filter };
  const [tickers, infoMap, funding] = await Promise.all([
    fetchAll24hTickers(),
    getExchangeInfoMap(),
    fetchPremiumIndexMap().catch(() => new Map<string, number>()),
  ]);

  const qualified = tickers
    .filter((t) => isCryptoOnly(t.symbol, infoMap))
    .filter((t) => {
      const quoteVol = parseFloat(t.quoteVolume);
      if (!Number.isFinite(quoteVol) || quoteVol < filter.min24hVolumeUsdt) {
        return false;
      }
      const absChange = Math.abs(parseFloat(t.priceChangePercent));
      if (Number.isFinite(absChange) && absChange > filter.max24hChangePct) {
        return false;
      }
      // Funding window (skip when premiumIndex has no entry, like the engine).
      const rate = funding.get(t.symbol);
      if (rate !== undefined) {
        if (rate < filter.minFundingRate || rate > filter.maxFundingRate) {
          return false;
        }
      }
      return true;
    })
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));

  let symbols = qualified.map((t) => t.symbol);
  if (opts.limit && symbols.length > opts.limit) {
    symbols = symbols.slice(0, opts.limit);
  }

  // Guarantee always-include symbols are present, de-duplicated, order-stable.
  const always = (opts.alwaysInclude ?? []).map((s) => s.toUpperCase());
  return Array.from(new Set([...symbols, ...always]));
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
