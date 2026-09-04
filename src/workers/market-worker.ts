// ---------------------------------------------------------------------------
// Market ingestion & analysis worker (pure TypeScript, no Python).
//
// Responsibilities:
//   • Connect to the Binance Futures combined WebSocket stream
//     (wss://fstream.binance.com/stream) for every TRACKED_SYMBOLS × interval
//     kline stream (5m / 15m / 1h).
//   • Maintain a resilient connection: heartbeat tracking via ws pong frames,
//     app-level staleness watchdog, and exponential backoff on drop.
//   • Keep 200-candle sliding windows in Redis (ZADD + ZREMRANGEBYRANK).
//   • On candle close (isClosed === true): recompute indicators + pattern
//     score, cache the snapshot, publish a `market:signal`, and async-insert
//     qualifying setups into PostgreSQL.
//
// Run with: `tsx src/workers/market-worker.ts` (or the compiled JS in Docker).
// ---------------------------------------------------------------------------

import WebSocket from "ws";
import { getIntervals, getTrackedSymbols } from "@/lib/market/config";
import {
  buildKlineStreamUrl,
  fetch24hTicker,
  fetch24hTickers,
  fetchKlines,
} from "@/lib/market/binance";
import { parseKlineMessage } from "@/lib/market/binance";
import { analyzeSymbolInterval, computeRegime } from "@/lib/market/engine";
import { persistCandidate } from "@/lib/market/persistence";
import {
  publishSignal,
  pushCandle,
  readWindow,
  saveSnapshot,
  seedWindow,
  WINDOW_SIZE,
} from "@/lib/market/redis-pipeline";
import type {
  Interval,
  Kline,
  MarketRegime,
  Ticker24h,
} from "@/lib/market/types";

// --- Tunables ---------------------------------------------------------------
const HEARTBEAT_INTERVAL_MS = 20_000; // send ping every 20s
const HEARTBEAT_TIMEOUT_MS = 60_000; // no traffic for 60s => reconnect
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
// Refresh 24h tickers (price/change/volume) periodically; klines arrive live.
const TICKER_REFRESH_MS = 30_000;
// Only publish/persist setups at or above this score (source alert gate).
const SIGNAL_MIN_SCORE = 200;

const SYMBOLS = getTrackedSymbols();
const INTERVALS = getIntervals();
// BTC/ETH regime context needs 15m + 1h; ensure they're tracked for regime.
const REGIME_SYMBOLS = ["BTCUSDT", "ETHUSDT"];

class MarketWorker {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private stalenessTimer: NodeJS.Timeout | null = null;
  private tickerTimer: NodeJS.Timeout | null = null;
  private lastMessageAt = Date.now();
  private stopping = false;

  /** Latest 24h ticker per symbol (refreshed via REST). */
  private tickers = new Map<string, Ticker24h>();
  private regime: MarketRegime | null = null;

  async start(): Promise<void> {
    log(
      `Starting market worker for ${SYMBOLS.length} symbols × ${INTERVALS.length} intervals (${INTERVALS.join(", ")}).`,
    );
    await this.seedHistoricalWindows();
    await this.refreshTickersAndRegime();

    this.tickerTimer = setInterval(() => {
      this.refreshTickersAndRegime().catch((e) =>
        log(`Ticker refresh error: ${errMsg(e)}`),
      );
    }, TICKER_REFRESH_MS);

    this.connect();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.terminate();
      this.ws = null;
    }
    log("Worker stopped.");
  }

  // --- Startup: seed sliding windows with REST history ----------------------
  private async seedHistoricalWindows(): Promise<void> {
    const symbolsToSeed = Array.from(new Set([...SYMBOLS, ...REGIME_SYMBOLS]));
    log(`Seeding ${WINDOW_SIZE}-candle windows for ${symbolsToSeed.length} symbols...`);
    for (const symbol of symbolsToSeed) {
      for (const interval of INTERVALS) {
        try {
          const klines = await fetchKlines(symbol, interval, WINDOW_SIZE);
          await seedWindow(symbol, interval, klines);
        } catch (e) {
          log(`Seed failed for ${symbol} ${interval}: ${errMsg(e)}`);
        }
        await sleep(15);
      }
    }
    log("Historical seeding complete.");
  }

  private async refreshTickersAndRegime(): Promise<void> {
    const symbolsToFetch = Array.from(new Set([...SYMBOLS, ...REGIME_SYMBOLS]));
    const fresh = await fetch24hTickers(symbolsToFetch);
    for (const [sym, t] of fresh) this.tickers.set(sym, t);

    // Recompute regime from BTC/ETH windows in Redis.
    const [btc15m, btc1h, eth15m, eth1h] = await Promise.all([
      readWindow("BTCUSDT", "15m"),
      readWindow("BTCUSDT", "1h"),
      readWindow("ETHUSDT", "15m"),
      readWindow("ETHUSDT", "1h"),
    ]);
    if (btc15m.length && eth15m.length) {
      this.regime = computeRegime({ btc15m, btc1h, eth15m, eth1h });
    }
  }

  // --- WebSocket lifecycle --------------------------------------------------
  private connect(): void {
    if (this.stopping) return;
    const url = buildKlineStreamUrl(SYMBOLS, INTERVALS);
    log(`Connecting WebSocket (${SYMBOLS.length * INTERVALS.length} streams)...`);

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.lastMessageAt = Date.now();
      log("WebSocket connected.");
      this.startHeartbeat();
      this.startStalenessWatchdog();
    });

    this.ws.on("message", (raw: WebSocket.RawData) => {
      this.lastMessageAt = Date.now();
      this.handleMessage(raw).catch((e) =>
        log(`Message handling error: ${errMsg(e)}`),
      );
    });

    // Binance sends ping frames; `ws` auto-responds with pong. We also track
    // pong replies to our own pings for liveness.
    this.ws.on("ping", () => {
      this.lastMessageAt = Date.now();
    });
    this.ws.on("pong", () => {
      this.lastMessageAt = Date.now();
    });

    this.ws.on("error", (err) => {
      log(`WebSocket error: ${errMsg(err)}`);
    });

    this.ws.on("close", (code) => {
      log(`WebSocket closed (code ${code}).`);
      this.clearTimers();
      this.scheduleReconnect();
    });
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping();
        } catch {
          // ignore; staleness watchdog will catch a dead socket.
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private startStalenessWatchdog(): void {
    this.clearStaleness();
    this.stalenessTimer = setInterval(() => {
      const idleFor = Date.now() - this.lastMessageAt;
      if (idleFor > HEARTBEAT_TIMEOUT_MS) {
        log(`No traffic for ${Math.round(idleFor / 1000)}s — forcing reconnect.`);
        if (this.ws) this.ws.terminate();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private scheduleReconnect(): void {
    if (this.stopping) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(
      BACKOFF_BASE_MS * 2 ** (this.reconnectAttempts - 1),
      BACKOFF_MAX_MS,
    );
    // Full jitter to avoid thundering-herd reconnects.
    const jittered = Math.round(Math.random() * delay);
    log(`Reconnecting in ${jittered}ms (attempt ${this.reconnectAttempts}).`);
    setTimeout(() => this.connect(), jittered);
  }

  // --- Message handling -----------------------------------------------------
  private async handleMessage(raw: WebSocket.RawData): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const evt = parseKlineMessage(parsed);
    if (!evt) return;

    const { symbol, interval, kline } = evt;

    // Keep the sliding window fresh on every tick (idempotent per openTime).
    await pushCandle(symbol, interval, kline);

    // Only run the analysis pass when the candle finalizes.
    if (kline.isClosed) {
      await this.onCandleClose(symbol, interval, kline);
    }
  }

  private async onCandleClose(
    symbol: string,
    interval: Interval,
    kline: Kline,
  ): Promise<void> {
    // Regime symbols feed context but aren't necessarily on the watchlist.
    const isWatched = SYMBOLS.includes(symbol);
    if (!isWatched) return;

    const ticker = this.tickers.get(symbol) ?? (await this.safeFetchTicker(symbol));
    if (!ticker) return;

    const klines = await readWindow(symbol, interval);
    if (klines.length < 25) return; // insufficient history for MAs.

    // Backbone (1h) + short (5m) windows for the pattern layer.
    const [klines1h, klines5m] = await Promise.all([
      interval === "1h" ? Promise.resolve(klines) : readWindow(symbol, "1h"),
      interval === "5m" ? Promise.resolve(klines) : readWindow(symbol, "5m"),
    ]);

    const { indicators, candidate } = analyzeSymbolInterval({
      symbol,
      interval,
      klines,
      klines1h: klines1h.length ? klines1h : undefined,
      klines5m: klines5m.length ? klines5m : undefined,
      ticker,
      regime: this.regime ?? undefined,
    });

    // Cache the snapshot for dashboard/API consumers.
    await saveSnapshot({
      symbol,
      interval,
      updatedAt: Date.now(),
      indicators,
      candidate,
    });

    if (!candidate) return;

    // Publish every detected candidate on Pub/Sub (real-time consumers filter).
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

    log(
      `SIGNAL ${symbol} ${interval} ${candidate.direction} ${candidate.patternType} score=${candidate.score.toFixed(1)} (${candidate.statusLabel})`,
    );

    // Persist only qualifying (high-conviction) setups to Postgres.
    if (candidate.score >= SIGNAL_MIN_SCORE && !candidate.isExhausted) {
      void persistCandidate(candidate, indicators);
    }
  }

  private async safeFetchTicker(symbol: string): Promise<Ticker24h | null> {
    try {
      const t = await fetch24hTicker(symbol);
      this.tickers.set(symbol, t);
      return t;
    } catch {
      return null;
    }
  }

  // --- Timer cleanup --------------------------------------------------------
  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
  private clearStaleness(): void {
    if (this.stalenessTimer) clearInterval(this.stalenessTimer);
    this.stalenessTimer = null;
  }
  private clearTimers(): void {
    this.clearHeartbeat();
    this.clearStaleness();
  }
}

function log(msg: string): void {
  console.log(`[market-worker] ${new Date().toISOString()} ${msg}`);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Bootstrap --------------------------------------------------------------
const worker = new MarketWorker();

async function shutdown(signal: string): Promise<void> {
  log(`Received ${signal}, shutting down...`);
  await worker.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  log(`Unhandled rejection: ${errMsg(reason)}`);
});

worker.start().catch((e) => {
  log(`Fatal startup error: ${errMsg(e)}`);
  process.exit(1);
});
