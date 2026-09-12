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

// Load .env for local (non-Docker) runs. `tsx` does not auto-load it, and in
// Docker the env is injected by compose so this is a harmless no-op there.
import "dotenv/config";

import WebSocket from "ws";
import {
  getIntervals,
  REGIME_SYMBOLS,
  resolveTrackedSymbols,
} from "@/lib/market/config";
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
  publishCandleClosed,
  publishSignal,
  publishTick,
  pushCandle,
  readWindow,
  recordScanTimes,
  saveSnapshot,
  seedWindow,
  WINDOW_SIZE,
} from "@/lib/market/redis-pipeline";
import type {
  AnalysisCandidate,
  Interval,
  Kline,
  MarketRegime,
  Ticker24h,
} from "@/lib/market/types";
import {
  claimFreeCycleLeader,
  generateFreeBroadcast,
  generateProAnalysis,
  PRO_SCORE_THRESHOLD,
} from "@/lib/ai/orchestrator";
import { scanMarket } from "@/lib/market/scan";
import { getAllFavoritePairs } from "@/lib/user-preferences";
import { redis } from "@/lib/redis";
import { randomUUID } from "node:crypto";

// --- 1m distributed lock ----------------------------------------------------
// The 1m tick is the single source of truth for all tiers, so across replicas
// only one instance should run a given tick. A short-TTL Redis lock guarantees
// that: whoever wins the SET NX runs the pass; everyone else skips this tick
// (the next tick retries). The 55s TTL is < the 60s cadence, so a crashed
// holder self-heals before the next boundary.
const SCAN_1M_LOCK_KEY = "scan:lock:1m";
const SCAN_1M_LOCK_TTL_MS = 55_000;

// --- Tunables ---------------------------------------------------------------
const HEARTBEAT_INTERVAL_MS = 20_000; // send ping every 20s
const HEARTBEAT_TIMEOUT_MS = 60_000; // no traffic for 60s => reconnect
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
// Refresh 24h tickers (price/change/volume) periodically; klines arrive live.
const TICKER_REFRESH_MS = 30_000;
// Only publish/persist setups at or above this score (source alert gate).
const SIGNAL_MIN_SCORE = 200;
// Candle length per interval, used to derive a timeframe-aligned scan cadence.
const INTERVAL_MS: Record<Interval, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
};

/**
 * Grace delay after a candle boundary before scanning, so the just-closed
 * candle has been ingested from the WS stream. Overridable via
 * SCAN_ALIGN_GRACE_MS (default 3s).
 */
const SCAN_ALIGN_GRACE_MS = Math.max(
  500,
  Number(process.env.SCAN_ALIGN_GRACE_MS ?? 3_000) || 3_000,
);

/**
 * Market-data source:
 *   "rest" — poll klines via REST on the scan cadence (default). Works where
 *            the Binance WebSocket is geo-blocked but REST is reachable.
 *   "ws"   — rely on the live WebSocket combined stream (lowest latency).
 *   "both" — WS for live ticks + REST refresh on each scan (belt & suspenders).
 * Default "rest" because fstream WS is blocked on some networks while REST 200s.
 */
const MARKET_DATA_MODE = (process.env.MARKET_DATA_MODE ?? "rest").toLowerCase();
const USE_WS = MARKET_DATA_MODE === "ws" || MARKET_DATA_MODE === "both";
const USE_REST_REFRESH =
  MARKET_DATA_MODE === "rest" || MARKET_DATA_MODE === "both";

const INTERVALS = getIntervals();
// How often to re-resolve the universe (top-movers + user favorites). Kept
// short so a newly-added favorite starts streaming within a couple minutes;
// the refresh only reconnects the socket when the symbol set actually changes.
const UNIVERSE_REFRESH_MS = 2 * 60 * 1000; // every 2 minutes

// Binance combined-stream cap is ~200 streams/connection. We shard well under
// that so a large discovered universe (60+ symbols × 4 intervals) stays live.
const MAX_STREAMS_PER_SOCKET = 40; // 10 symbols × 4 intervals per socket.

class MarketWorker {
  private sockets: WebSocket[] = [];
  private reconnectAttempts = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private stalenessTimer: NodeJS.Timeout | null = null;
  private tickerTimer: NodeJS.Timeout | null = null;
  private scanTimers: NodeJS.Timeout[] = [];
  private scanInFlight = false;
  /** Intervals requested while a scan was in flight — drained after it ends. */
  private pendingScanIntervals = new Set<Interval>();
  private lastMessageAt = Date.now();
  private stopping = false;

  /** Live tradable universe (discovered from Binance, refreshed periodically). */
  private symbols: string[] = [];
  private universeTimer: NodeJS.Timeout | null = null;

  /** Latest 24h ticker per symbol (refreshed via REST). */
  private tickers = new Map<string, Ticker24h>();
  private regime: MarketRegime | null = null;

  /**
   * Latest detected 15m candidate per symbol, kept in-memory so the Free
   * broadcast (elected once per 15m window) can pick the top market-wide
   * candidates without re-scanning. Cleared after each broadcast.
   */
  private latest15mCandidates = new Map<string, AnalysisCandidate>();

  /**
   * The scan/stream universe = top-movers (discovered from Binance) UNION every
   * user's favorite pairs, so a favorited symbol is always tracked even when it
   * isn't a current top mover. Favorites are read from Postgres (best-effort).
   */
  private async resolveUniverse(): Promise<string[]> {
    const topMovers = await resolveTrackedSymbols();
    let favorites: string[] = [];
    try {
      favorites = await getAllFavoritePairs();
    } catch (e) {
      log(`Favorite union skipped (DB read failed): ${errMsg(e)}`);
    }
    return Array.from(new Set([...topMovers, ...favorites]));
  }

  async start(): Promise<void> {
    // Discover the tradable universe live from Binance before anything else.
    this.symbols = await this.resolveUniverse();
    log(
      `Starting market worker for ${this.symbols.length} symbols × ${INTERVALS.length} intervals (${INTERVALS.join(", ")}).`,
    );
    log(`Universe: ${this.symbols.slice(0, 20).join(", ")}${this.symbols.length > 20 ? ` … (+${this.symbols.length - 20})` : ""}`);

    await this.seedHistoricalWindows();
    await this.refreshTickersAndRegime();

    this.tickerTimer = setInterval(() => {
      this.refreshTickersAndRegime().catch((e) =>
        log(`Ticker refresh error: ${errMsg(e)}`),
      );
    }, TICKER_REFRESH_MS);

    // Periodically re-discover the universe; reconnect the stream if it changed.
    this.universeTimer = setInterval(() => {
      this.refreshUniverse().catch((e) =>
        log(`Universe refresh error: ${errMsg(e)}`),
      );
    }, UNIVERSE_REFRESH_MS);

    // Clock-aligned scanning: each interval is scanned right AFTER its candle
    // closes on the real wall clock (5m at :00/:05/:10…, 15m at :00/:15/:30/:45,
    // 1h on the hour), not on an arbitrary offset from startup. This makes
    // "15m scanned Xs ago" always correspond to an actual 15m candle close.
    // A full first pass warms the UI immediately.
    void this.runScanPass(); // all intervals once, on startup

    // Seed per-interval scan times to each interval's most recent real candle
    // boundary so the dashboard shows accurate "last close" times immediately
    // (before the first aligned scan of a long interval like 1h fires).
    for (const interval of INTERVALS) {
      const period = INTERVAL_MS[interval];
      const lastBoundary = Math.floor(Date.now() / period) * period;
      void recordScanTimes([interval], lastBoundary).catch(() => {});
      this.scheduleAlignedScan(interval);
    }

    log(`Market data mode: ${MARKET_DATA_MODE} (ws=${USE_WS}, restRefresh=${USE_REST_REFRESH}).`);
    if (USE_WS) this.connect();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearTimers();
    this.clearLifecycleTimers();
    this.closeAllSockets();
    log("Worker stopped.");
  }

  /**
   * Re-discovers the tradable universe. If the set changed, seeds windows for
   * any newly-added symbols and reconnects the WebSocket to the new stream set.
   */
  private async refreshUniverse(): Promise<void> {
    const next = await this.resolveUniverse();
    const prev = new Set(this.symbols);
    const nextSet = new Set(next);

    const added = next.filter((s) => !prev.has(s));
    const removed = this.symbols.filter((s) => !nextSet.has(s));
    if (added.length === 0 && removed.length === 0) return;

    log(`Universe changed: +${added.length} / -${removed.length}. Reconnecting stream.`);
    this.symbols = next;

    // Seed windows for new symbols so indicators have history immediately.
    for (const symbol of added) {
      for (const interval of INTERVALS) {
        try {
          const klines = await fetchKlines(symbol, interval, WINDOW_SIZE);
          await seedWindow(symbol, interval, klines);
        } catch (e) {
          log(`Seed failed for new ${symbol} ${interval}: ${errMsg(e)}`);
        }
        await sleep(15);
      }
    }

    // Rebuild the sharded socket set to pick up the new universe.
    this.connect();
  }

  // --- Startup: seed sliding windows with REST history ----------------------
  private async seedHistoricalWindows(): Promise<void> {
    const symbolsToSeed = Array.from(new Set([...this.symbols, ...REGIME_SYMBOLS]));
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

  /**
   * One continuous scan pass over the current windows, reusing the worker's
   * cached tickers/regime to avoid extra REST calls. Guarded so overlapping
   * ticks can't stack scans.
   */
  /**
   * Schedules the next scan for an interval aligned to the real candle clock.
   * Fires shortly AFTER each boundary (SCAN_ALIGN_GRACE_MS) so the just-closed
   * candle has been ingested, then re-schedules itself for the next boundary.
   */
  private scheduleAlignedScan(interval: Interval): void {
    if (this.stopping) return;
    const period = INTERVAL_MS[interval];
    const now = Date.now();
    const nextBoundary = Math.ceil(now / period) * period;
    const delay = nextBoundary - now + SCAN_ALIGN_GRACE_MS;

    const timer = setTimeout(() => {
      void this.runScanPass([interval]).finally(() => {
        this.scheduleAlignedScan(interval); // schedule the next boundary
      });
    }, delay);
    this.scanTimers.push(timer);

    log(
      `Next ${interval} scan aligned to ${new Date(nextBoundary).toISOString()} (in ${Math.round(delay / 1000)}s).`,
    );
  }

  /**
   * Runs a scan for the given interval(s). Concurrent requests (e.g. 5m, 15m
   * and 30m boundaries all landing at :30) are QUEUED rather than dropped — a
   * single in-flight lock previously caused all-but-the-first to silently skip,
   * so only 5m updated at shared boundaries. Queued intervals run right after.
   */
  private async runScanPass(intervals?: Interval[]): Promise<void> {
    if (this.stopping) return;
    if (this.symbols.length === 0) return;

    const requested = intervals ?? [...INTERVALS];

    if (this.scanInFlight) {
      // Queue these intervals to run as soon as the current scan finishes.
      for (const iv of requested) this.pendingScanIntervals.add(iv);
      return;
    }

    // `aligned` = a per-interval boundary scan (records per-period times);
    // the startup warm-up passes intervals=undefined (aligned=false).
    const aligned = intervals !== undefined;

    this.scanInFlight = true;
    try {
      await this.scanIntervals(requested, aligned);
      // Drain anything queued while we were scanning (deduped). Queued scans are
      // always boundary-aligned, so they record their per-period times.
      while (this.pendingScanIntervals.size > 0 && !this.stopping) {
        const next = Array.from(this.pendingScanIntervals);
        this.pendingScanIntervals.clear();
        await this.scanIntervals(next, true);
      }
    } catch (e) {
      log(`Scan pass error: ${errMsg(e)}`);
    } finally {
      this.scanInFlight = false;
    }
  }

  /**
   * Executes scanMarket for the given intervals. When `aligned`, each scanned
   * interval records its own per-period "last scanned" time (so shared-boundary
   * batches like 15m+30m both stamp correctly, not just the first).
   */
  private async scanIntervals(
    scanIntervals: Interval[],
    aligned: boolean,
  ): Promise<void> {
    // The 1m tier scan is the single source of truth for all tiers and must be
    // guarded by a distributed lock so replicas don't double-scan. It is split
    // out and run separately; the other intervals keep their existing behaviour
    // (in-process overlap guard only).
    const has1m = scanIntervals.includes("1m");
    const otherIntervals = scanIntervals.filter((i) => i !== "1m");

    if (otherIntervals.length > 0) {
      await scanMarket({
        symbols: this.symbols,
        intervals: otherIntervals,
        tickers: this.tickers,
        regime: this.regime ?? undefined,
        trigger: "interval",
        everySec: Math.round(INTERVAL_MS[otherIntervals[0] ?? "5m"] / 1000),
        dispatchProAnalysis: true,
        recordTimes: aligned,
        refreshViaRest: USE_REST_REFRESH,
      });
    }

    if (has1m) {
      await this.run1mScanPass(aligned);
    }
  }

  /**
   * Runs the 1m scan pass under a distributed Redis lock so that, across
   * replicas, only one instance scans a given 1m tick. On failed acquisition
   * (another replica holds the lock) this tick is skipped — the next tick
   * retries, so a skipped/failed tick never blocks the following one. The whole
   * body is wrapped so a failure is logged and never rethrown into the caller
   * (which would otherwise stall the aligned re-scheduling loop).
   */
  private async run1mScanPass(aligned: boolean): Promise<void> {
    // Single-instance dev (no Redis / no replicas): skip the lock and just run.
    if (!redis) {
      try {
        await this.scan1m(aligned);
      } catch (e) {
        log(`1m scan pass error (no lock): ${errMsg(e)}`);
      }
      return;
    }

    const lockValue = randomUUID();
    let acquired = false;
    try {
      const res = await redis.set(
        SCAN_1M_LOCK_KEY,
        lockValue,
        "PX",
        SCAN_1M_LOCK_TTL_MS,
        "NX",
      );
      acquired = res === "OK";

      if (!acquired) {
        // Another replica is running this tick — skip; the next tick retries.
        log("1m tick skipped: lock held by another instance.");
        return;
      }

      await this.scan1m(aligned);
    } catch (e) {
      // Binance/engine/Redis errors must not break the next tick.
      log(`1m scan pass error: ${errMsg(e)}`);
    } finally {
      // Release only if we still own the lock (value match), so we never delete
      // a lock a later holder acquired after our TTL lapsed. Best-effort: the
      // short TTL self-heals if this cleanup itself fails.
      if (acquired && redis) {
        try {
          const current = await redis.get(SCAN_1M_LOCK_KEY);
          if (current === lockValue) {
            await redis.del(SCAN_1M_LOCK_KEY);
          }
        } catch (e) {
          log(`1m lock release error: ${errMsg(e)}`);
        }
      }
    }
  }

  /** The actual 1m scan work (no locking) — invoked by `run1mScanPass`. */
  private async scan1m(aligned: boolean): Promise<void> {
    await scanMarket({
      symbols: this.symbols,
      intervals: ["1m"],
      tickers: this.tickers,
      regime: this.regime ?? undefined,
      trigger: "interval",
      everySec: Math.round(INTERVAL_MS["1m"] / 1000),
      dispatchProAnalysis: true,
      recordTimes: aligned,
      refreshViaRest: USE_REST_REFRESH,
    });
  }

  private async refreshTickersAndRegime(): Promise<void> {
    const symbolsToFetch = Array.from(new Set([...this.symbols, ...REGIME_SYMBOLS]));
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
  /**
   * Opens one or more Binance combined-stream sockets, SHARDED so no single
   * connection exceeds the combined-stream cap. A single 240-stream URL is
   * silently rejected/starved by Binance (connects but delivers no data), which
   * froze all prices — sharding keeps every symbol live.
   */
  private connect(): void {
    if (this.stopping) return;
    this.closeAllSockets();

    // Include regime symbols so BTC/ETH windows stay live.
    const streamSymbols = Array.from(
      new Set([...this.symbols, ...REGIME_SYMBOLS]),
    );

    const symbolsPerSocket = Math.max(
      1,
      Math.floor(MAX_STREAMS_PER_SOCKET / INTERVALS.length),
    );
    const batches: string[][] = [];
    for (let i = 0; i < streamSymbols.length; i += symbolsPerSocket) {
      batches.push(streamSymbols.slice(i, i + symbolsPerSocket));
    }

    log(
      `Connecting ${batches.length} WebSocket(s) for ${streamSymbols.length} symbols × ${INTERVALS.length} intervals (${streamSymbols.length * INTERVALS.length} streams, ≤${MAX_STREAMS_PER_SOCKET}/socket)...`,
    );

    for (const batch of batches) this.openSocket(batch);

    this.startHeartbeat();
    this.startStalenessWatchdog();
  }

  private openSocket(batchSymbols: string[]): void {
    const url = buildKlineStreamUrl(batchSymbols, INTERVALS);
    const ws = new WebSocket(url);
    this.sockets.push(ws);

    ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.lastMessageAt = Date.now();
    });

    ws.on("message", (raw: WebSocket.RawData) => {
      this.lastMessageAt = Date.now();
      this.handleMessage(raw).catch((e) =>
        log(`Message handling error: ${errMsg(e)}`),
      );
    });

    ws.on("ping", () => {
      this.lastMessageAt = Date.now();
    });
    ws.on("pong", () => {
      this.lastMessageAt = Date.now();
    });

    ws.on("error", (err) => {
      log(`WebSocket error: ${errMsg(err)}`);
    });

    ws.on("close", (code) => {
      // If a socket drops (and we're not intentionally reconnecting), rebuild
      // the whole set on the next staleness/close cycle.
      if (this.stopping) return;
      log(`A WebSocket closed (code ${code}).`);
    });
  }

  private closeAllSockets(): void {
    for (const ws of this.sockets) {
      try {
        ws.removeAllListeners();
        ws.terminate();
      } catch {
        // ignore
      }
    }
    this.sockets = [];
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      for (const ws of this.sockets) {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.ping();
          } catch {
            // ignore; staleness watchdog will catch a dead socket.
          }
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
        this.clearTimers();
        this.scheduleReconnect();
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

    // Fan out the live tick to the WS gateway on every update (in-progress or
    // closed). Fire-and-forget so Pub/Sub latency never stalls ingestion.
    void publishTick(symbol, interval, kline).catch((e) =>
      log(`Tick publish error: ${errMsg(e)}`),
    );

    // Only run the analysis pass when the candle finalizes.
    if (kline.isClosed) {
      void publishCandleClosed(symbol, interval, kline).catch((e) =>
        log(`Candle-closed publish error: ${errMsg(e)}`),
      );
      await this.onCandleClose(symbol, interval, kline);
    }
  }

  private async onCandleClose(
    symbol: string,
    interval: Interval,
    kline: Kline,
  ): Promise<void> {
    // Regime symbols feed context but aren't necessarily on the watchlist.
    const isWatched = this.symbols.includes(symbol);
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

    // Record the freshest 15m candidate per symbol for the Free broadcast.
    if (interval === "15m") {
      this.latest15mCandidates.set(symbol, candidate);
    }

    // Persist only qualifying (high-conviction) setups to Postgres.
    if (candidate.score >= SIGNAL_MIN_SCORE && !candidate.isExhausted) {
      void persistCandidate(candidate, indicators);
    }

    // --- Phase 3: tiered AI dispatch ---------------------------------------
    // Pro tier: any candidate at/above the score threshold gets a per-symbol/
    // interval AI analysis (cached, published, persisted with entry/SL/TP).
    if (candidate.score >= PRO_SCORE_THRESHOLD && !candidate.isExhausted) {
      void generateProAnalysis({
        candidate,
        indicators,
        regime: this.regime ?? undefined,
      }).catch((e) => log(`Pro AI analysis error: ${errMsg(e)}`));
    }

    // Free tier: on 15m close, the elected cycle leader regenerates the shared
    // broadcast from the top market-wide 15m candidates.
    if (interval === "15m") {
      void this.maybeRunFreeBroadcast().catch((e) =>
        log(`Free broadcast error: ${errMsg(e)}`),
      );
    }
  }

  /**
   * Runs the Free broadcast at most once per 15m window (cycle-leader lock).
   * Uses the accumulated per-symbol 15m candidates as the market snapshot.
   */
  private async maybeRunFreeBroadcast(): Promise<void> {
    const isLeader = await claimFreeCycleLeader();
    if (!isLeader) return;

    const candidates = Array.from(this.latest15mCandidates.values());
    const payload = await generateFreeBroadcast({
      candidates,
      regime: this.regime ?? undefined,
    });

    if (payload) {
      log(
        `FREE BROADCAST regenerated with ${payload.analyses.length} pick(s): ${payload.analyses
          .map((a) => `${a.symbol}(${a.score.toFixed(0)})`)
          .join(", ")}`,
      );
    } else {
      log("FREE BROADCAST: no qualifying 15m candidates this cycle.");
    }

    // Reset the accumulator so the next window starts fresh.
    this.latest15mCandidates.clear();
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
  /** Connection-level timers only — cleared on every reconnect. */
  private clearTimers(): void {
    this.clearHeartbeat();
    this.clearStaleness();
  }

  /** Lifecycle timers (ticker/universe/scan) — cleared only on shutdown. */
  private clearLifecycleTimers(): void {
    if (this.tickerTimer) {
      clearInterval(this.tickerTimer);
      this.tickerTimer = null;
    }
    if (this.universeTimer) {
      clearInterval(this.universeTimer);
      this.universeTimer = null;
    }
    for (const t of this.scanTimers) clearTimeout(t);
    this.scanTimers = [];
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
