"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RadarIcon, Wifi, WifiOff } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { useMarketSocket } from "@/hooks/useMarketSocket";
import {
  AI_SIGNALS_CHANNEL,
  PUBLIC_SIGNALS_CHANNEL,
  tickerChannel,
} from "@/lib/ws/protocol";
import { type SelectableInterval } from "@/lib/validation";
import type { StoredAnalysis } from "@/lib/ai/store";
import type { MarketSignal, Interval } from "@/lib/market/types";

import {
  SERVED_INTERVAL,
  REFRESH_MS,
  shouldRefreshOnHeartbeat,
  type DisplayInterval,
} from "@/components/dashboard/dashboard-live.helpers";
import { UserMenu } from "@/components/dashboard/user-menu";
import { UpgradeModal } from "@/components/dashboard/upgrade-modal";
import { AiAnalysisDrawer } from "@/components/dashboard/ai-analysis-drawer";
import {
  LiveSignalsTable,
  type SignalRow,
  type RowUsd,
} from "@/components/dashboard/live-signals-table";

// --- Feed API response shapes (from /api/analysis/feed) ---------------------

/** The read-time profile the feed echoes back (USD sizing inputs). */
interface FeedProfile {
  defaultLeverage: number;
  defaultRrRatio: string;
  balanceUsd: number;
}

/** A feed row is a StoredAnalysis plus the per-user USD envelope. */
type FeedRow = StoredAnalysis & { usd?: RowUsd };

interface FeedFreeResponse {
  ok: true;
  plan: "free";
  interval: "15m";
  profile?: FeedProfile;
  favoritePairs?: string[];
  /** Favorite rows (15m), pinned above the broadcast picks. */
  favorites?: FeedRow[];
  /** Free reduced slices (favorites + top pick), served at 15m. */
  analyses?: FeedRow[];
  scanTimes?: Record<string, number>;
}

/**
 * Pro (5m) and Ultimate (1m) share the same feed shape: a single served
 * interval, the tier's slices, and the read-time profile.
 */
interface FeedFullResponse {
  ok: true;
  plan: "pro" | "ultimate";
  interval: DisplayInterval;
  preferences: { intervals: SelectableInterval[]; favoritePairs: string[] };
  activeIntervals: Interval[];
  profile?: FeedProfile;
  analyses: FeedRow[];
  scanTimes?: Record<string, number>;
}

type FeedResponse = FeedFreeResponse | FeedFullResponse;

export interface DashboardLiveProps {
  plan: "free" | "pro" | "ultimate";
  /** The signed-in user's email — for the avatar menu label + initials. */
  email: string;
  /** The signed-in user's display name (optional) — for the avatar initials. */
  name?: string | null;
  /** The user's persisted preferred intervals (Pro). Free is pinned to 15m. */
  initialIntervals: SelectableInterval[];
  /** The user's persisted favorite pairs. */
  initialFavorites: string[];
  /** Seed for the Risk defaults form (server-loaded preferences). */
  initialLeverage: number;
  initialRrRatio: string;
}

export function DashboardLive({
  plan,
  email,
  name,
  initialIntervals,
  initialFavorites,
  initialLeverage,
  initialRrRatio,
}: DashboardLiveProps) {
  // Each tier is served exactly one interval (Free 15m, Pro 5m, Ultimate 1m).
  // Derived from the plan; there is no user-switchable timeframe anymore.
  const servedInterval: DisplayInterval = SERVED_INTERVAL[plan];
  const [analyses, setAnalyses] = useState<FeedRow[]>([]);
  // Per-row USD envelope keyed by `${symbol}:${interval}`, sourced from the feed.
  const [usdByKey, setUsdByKey] = useState<Map<string, RowUsd>>(new Map());
  const [favorites, setFavorites] = useState<string[]>(initialFavorites);
  const [loadingFeed, setLoadingFeed] = useState(true);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [upgradeReason, setUpgradeReason] = useState<string | undefined>();
  const [selected, setSelected] = useState<StoredAnalysis | null>(null);
  const [selectedUsd, setSelectedUsd] = useState<RowUsd | null>(null);

  // --- Live socket --------------------------------------------------------
  // Subscribe to the AI signal stream (Pro) or the public free channel, plus a
  // ticker channel per visible symbol at the active timeframe.
  const visibleSymbols = useMemo(
    () => analyses.map((a) => a.symbol),
    [analyses],
  );

  const channels = useMemo(() => {
    const set = new Set<string>();
    // Pro and Ultimate both consume the per-symbol AI signal stream.
    if (plan === "pro" || plan === "ultimate") {
      set.add(AI_SIGNALS_CHANNEL);
    }
    set.add(PUBLIC_SIGNALS_CHANNEL);

    // Visible rows for the served timeframe get live ticks.
    for (const symbol of visibleSymbols) {
      set.add(tickerChannel(symbol, servedInterval as Interval));
    }

    // Favorites are always pinned/visible, so subscribe to their live ticks
    // regardless of whether they're in the current analyses set. All tiers
    // render favorites at the tier's served interval.
    for (const sym of favorites) {
      set.add(tickerChannel(sym.toUpperCase(), servedInterval as Interval));
    }
    return Array.from(set);
  }, [plan, visibleSymbols, servedInterval, favorites]);

  const {
    isConnected,
    latestTicks,
    latestSignals,
    freeSignals,
    latestBroadcast,
    scanStatus,
  } = useMarketSocket({ channels });

  // Free-tier favorite rows (15m), pinned above the broadcast picks.
  const [freeFavoriteRows, setFreeFavoriteRows] = useState<FeedRow[]>([]);
  // Per-interval last-scan timestamps (5m/15m/30m/1h → epoch ms).
  const [scanTimes, setScanTimes] = useState<Record<string, number>>({});
  // Ticks every few seconds so the "Scanned Xs ago" label stays fresh.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 3_000);
    return () => clearInterval(id);
  }, []);

  // --- Feed fetch (initial + on timeframe change for Pro) -----------------
  // Indexes the per-row USD envelopes from a set of feed rows.
  const indexUsd = useCallback((rows: FeedRow[]): Map<string, RowUsd> => {
    const idx = new Map<string, RowUsd>();
    for (const r of rows) {
      if (r.usd) idx.set(`${r.symbol}:${r.interval}`, r.usd);
    }
    return idx;
  }, []);

  const loadFeed = useCallback(async () => {
    setLoadingFeed(true);
    try {
      const res = await fetch("/api/analysis/feed", { cache: "no-store" });
      const data = (await res.json()) as FeedResponse;
      if (data.scanTimes) setScanTimes((cur) => ({ ...cur, ...data.scanTimes }));
      if (data.plan === "free") {
        const rows = data.analyses ?? [];
        const favRows = data.favorites ?? [];
        setAnalyses(rows);
        setFreeFavoriteRows(favRows);
        setUsdByKey(indexUsd([...rows, ...favRows]));
        if (data.favoritePairs) setFavorites(data.favoritePairs);
      } else {
        // Pro (5m) and Ultimate (1m) share one shape.
        const rows = data.analyses ?? [];
        setAnalyses(rows);
        setUsdByKey(indexUsd(rows));
        if (data.preferences?.favoritePairs) {
          setFavorites(data.preferences.favoritePairs);
        }
      }
    } catch {
      // Keep whatever we have; live socket still updates rows.
    } finally {
      setLoadingFeed(false);
    }
  }, [indexUsd]);

  useEffect(() => {
    void loadFeed();
  }, [loadFeed]);

  // --- Auto-refresh (Concern A) -------------------------------------------
  // Safety-net poll: refresh the (cheap) feed read on the tier-scaled cadence
  // regardless of socket state, so signals stay current even when the socket
  // is disconnected or a heartbeat is missed (Req 1.1, 2.4). `loadFeed` is a
  // stable useCallback, so the interval is created once per plan.
  useEffect(() => {
    const id = setInterval(() => {
      void loadFeed();
    }, REFRESH_MS[plan]);
    return () => clearInterval(id);
  }, [plan, loadFeed]);

  // Heartbeat-driven refresh: when a scan for the served interval newly
  // completes, refetch the feed (Req 1.2, 2.1–2.3). Deduped on `lastScanAt`
  // via a ref so a re-emitted heartbeat does not retrigger / loop.
  const lastRefreshAtRef = useRef<number>(0);
  useEffect(() => {
    if (
      shouldRefreshOnHeartbeat(
        scanStatus,
        servedInterval,
        lastRefreshAtRef.current,
      )
    ) {
      lastRefreshAtRef.current = scanStatus!.lastScanAt;
      void loadFeed();
    }
  }, [scanStatus, servedInterval, loadFeed]);

  // Merge live AI analyses into the feed set (Pro/Ultimate): newest wins per
  // symbol. Live signals carry no per-user USD envelope, so `usd` stays sourced
  // from the last feed fetch (keyed by symbol:interval). The feed is the source
  // of truth for row membership: only keys already present in the current feed
  // set are updated, so a symbol dropped by a refresh is never re-introduced by
  // a stale live signal and stale rows are removed (Req 1.6).
  useEffect(() => {
    if ((plan !== "pro" && plan !== "ultimate") || latestSignals.length === 0)
      return;
    setAnalyses((prev) => {
      const present = new Set(prev.map((a) => `${a.symbol}:${a.interval}`));
      const byKey = new Map<string, FeedRow>();
      for (const a of prev) byKey.set(`${a.symbol}:${a.interval}`, a);
      for (const a of latestSignals) {
        const key = `${a.symbol}:${a.interval}`;
        if (present.has(key)) byKey.set(key, a); // update only; never introduce
      }
      return Array.from(byKey.values());
    });
  }, [plan, latestSignals]);

  // Merge live free broadcast into the free view.
  useEffect(() => {
    if (plan !== "free" || !latestBroadcast) return;
    setAnalyses(latestBroadcast.analyses ?? []);
  }, [plan, latestBroadcast]);

  // Track per-interval last-scan times from the live scan-status heartbeat.
  // Only automatic, single-interval (boundary-aligned) scans update the times;
  // the startup warm-up (all intervals at once) is ignored so each period
  // reflects its own real candle close.
  useEffect(() => {
    if (!scanStatus || scanStatus.scanning) return;
    const ivs = scanStatus.intervals;
    if (!ivs || ivs.length !== 1 || scanStatus.trigger !== "interval") return;
    setScanTimes((cur) => ({ ...cur, [ivs[0]]: scanStatus.lastScanAt }));
  }, [scanStatus]);

  const maxFavorites = plan === "free" ? 3 : 10;

  // Single source of truth for saving favorites (used by row star + manager).
  const saveFavorites = useCallback(
    async (next: string[]) => {
      const prev = favorites;
      setFavorites(next); // optimistic
      try {
        const res = await fetch("/api/user/preferences", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ favoritePairs: next }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: string;
            upgradeRequired?: boolean;
          } | null;
          setFavorites(prev);
          if (body?.upgradeRequired) {
            setUpgradeReason(
              "Free plans can pin up to 3 favorites. Upgrade to Pro for up to 10.",
            );
            setUpgradeOpen(true);
          } else {
            toast.error(body?.error ?? "Couldn't save favorites.");
          }
        } else {
          await loadFeed();
        }
      } catch {
        setFavorites(prev);
        toast.error("Couldn't save favorites.");
      }
    },
    [favorites, loadFeed, plan],
  );

  // Quick-add/remove favorite from a table row's star button.
  const handleToggleFavorite = useCallback(
    (symbol: string, isCurrentlyFav: boolean) => {
      const sym = symbol.toUpperCase();
      if (isCurrentlyFav) {
        void saveFavorites(favorites.filter((s) => s.toUpperCase() !== sym));
        return;
      }
      if (favorites.length >= maxFavorites) {
        if (plan === "free") {
          setUpgradeReason(
            "Free plans can pin up to 3 favorites. Upgrade to Pro for up to 10.",
          );
          setUpgradeOpen(true);
        } else {
          toast.info("Pro plans can pin up to 10 favorites.");
        }
        return;
      }
      void saveFavorites([...favorites, sym]);
    },
    [favorites, maxFavorites, plan, saveFavorites],
  );

  // Human "time ago" from an epoch-ms timestamp.
  const timeAgo = useCallback(
    (at: number | undefined): string | null => {
      if (!at) return null;
      const secs = Math.max(0, Math.round((nowTick - at) / 1000));
      if (secs < 5) return "just now";
      if (secs < 60) return `${secs}s ago`;
      const mins = Math.round(secs / 60);
      return `${mins}m ago`;
    },
    [nowTick],
  );

  // Scan label for the served timeframe (per-period, latest one).
  const scanLabel = useMemo(() => {
    if (scanStatus?.scanning) return "Scanning…";
    const ago = timeAgo(scanTimes[servedInterval]);
    if (ago) return `${servedInterval} scanned ${ago}`;
    return isConnected ? `Waiting for first ${servedInterval} scan…` : null;
  }, [scanStatus, isConnected, scanTimes, servedInterval, timeAgo]);

  // --- Build display rows -------------------------------------------------
  // Index live signals (which carry indicators) so Pro/Free rows can show
  // RSI / ATR% / 24h change when a matching signal has arrived.
  const signalIndex = useMemo(() => {
    const idx = new Map<string, MarketSignal>();
    for (const s of freeSignals) idx.set(`${s.symbol}:${s.interval}`, s);
    return idx;
  }, [freeSignals]);

  const favoriteSet = useMemo(
    () => new Set(favorites.map((s) => s.toUpperCase())),
    [favorites],
  );

  const rows = useMemo<SignalRow[]>(() => {
    // Assemble the source analyses for the active view.
    let source: FeedRow[];
    if (plan === "pro" || plan === "ultimate") {
      // Each tier serves a single interval (pro=5m, ultimate=1m) which equals
      // `servedInterval`, so a straight interval match yields the served rows.
      source = analyses.filter((a) => a.interval === servedInterval);
    } else {
      // Free: favorite rows (15m) + broadcast picks, de-duplicated by symbol.
      const byKey = new Map<string, FeedRow>();
      for (const a of analyses) byKey.set(`${a.symbol}:${a.interval}`, a);
      for (const f of freeFavoriteRows) byKey.set(`${f.symbol}:${f.interval}`, f);
      source = Array.from(byKey.values());
    }

    // Sort: favorites first (each group by score), then the rest by score.
    const sorted = [...source].sort((a, b) => {
      const aFav = favoriteSet.has(a.symbol.toUpperCase()) ? 1 : 0;
      const bFav = favoriteSet.has(b.symbol.toUpperCase()) ? 1 : 0;
      if (aFav !== bFav) return bFav - aFav;
      return b.score - a.score;
    });

    // Free visibility: favorites are always visible; among non-favorites only
    // the top broadcast pick stays clear, the rest are obscured with the CTA.
    let nonFavShown = 0;
    return sorted.map((a) => {
      const isFav = favoriteSet.has(a.symbol.toUpperCase());
      let obscured = false;
      if (plan === "free" && !isFav) {
        obscured = nonFavShown >= 1;
        nonFavShown += 1;
      }
      const sig = signalIndex.get(`${a.symbol}:${a.interval}`);
      const ind = sig?.indicators;
      const usd = a.usd ?? usdByKey.get(`${a.symbol}:${a.interval}`) ?? null;
      return {
        symbol: a.symbol,
        interval: a.interval,
        direction: a.direction,
        pattern: a.pattern,
        price: a.price,
        changePct: null,
        rsi: ind?.rsi14 ?? null,
        atrPct: ind?.atrRatioPct ?? null,
        score: a.score,
        status: a.ai.riskLevel,
        aiAction: a.direction,
        analysis: a,
        isFavorite: isFav,
        obscured,
        usd,
      } satisfies SignalRow;
    });
  }, [
    plan,
    analyses,
    freeFavoriteRows,
    servedInterval,
    signalIndex,
    favoriteSet,
    usdByKey,
  ]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2" />
        <div className="flex items-center gap-2 text-xs">
          {/* Live scan-status indicator (both tiers). */}
          {scanLabel && (
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium",
                scanStatus?.scanning
                  ? "bg-primary/15 text-primary"
                  : "bg-white/10 text-muted-foreground",
              )}
            >
              <RadarIcon
                className={cn(
                  "size-3.5",
                  scanStatus?.scanning && "animate-pulse",
                )}
              />
              {scanLabel}
            </span>
          )}

          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium",
              isConnected
                ? "bg-emerald-500/10 text-emerald-400"
                : "bg-white/10 text-muted-foreground",
            )}
          >
            {isConnected ? (
              <>
                <Wifi className="size-3.5" /> Live
              </>
            ) : (
              <>
                <WifiOff className="size-3.5" /> Connecting…
              </>
            )}
          </span>

          {/* Avatar settings menu (Concern C, Option 1): co-located here so the
              row star and the menu share one favorites source of truth. */}
          <UserMenu
            plan={plan}
            email={email}
            name={name}
            initialLeverage={initialLeverage}
            initialRrRatio={initialRrRatio}
            favorites={favorites}
            onAddFavorite={(sym) => handleToggleFavorite(sym, false)}
            onRemoveFavorite={(sym) => handleToggleFavorite(sym, true)}
          />
        </div>
      </div>

      {/* Read-only last-scan indicator for the served interval only. There is
          no timeframe control — each tier is served a single fixed cadence. */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium">Last scan:</span>
        <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-primary">
          <span className="font-semibold">{servedInterval}</span>
          <span>· scanned {timeAgo(scanTimes[servedInterval]) ?? "—"}</span>
        </span>
      </div>

      {loadingFeed && rows.length === 0 ? (
        <div className="flex h-40 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" /> Loading signals…
        </div>
      ) : (
        <LiveSignalsTable
          plan={plan}
          rows={rows}
          latestTicks={latestTicks}
          onRowClick={(a) => {
            setSelected(a);
            setSelectedUsd(usdByKey.get(`${a.symbol}:${a.interval}`) ?? null);
          }}
          onToggleFavorite={handleToggleFavorite}
          onUpgradeClick={() => {
            setUpgradeReason(undefined);
            setUpgradeOpen(true);
          }}
        />
      )}

      <AiAnalysisDrawer
        analysis={selected}
        usd={selectedUsd}
        open={selected != null}
        onOpenChange={(open) => {
          if (!open) {
            setSelected(null);
            setSelectedUsd(null);
          }
        }}
      />
      <UpgradeModal
        open={upgradeOpen}
        onOpenChange={setUpgradeOpen}
        reason={upgradeReason}
      />
    </div>
  );
}
