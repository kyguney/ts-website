"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RadarIcon, RefreshCw, Wifi, WifiOff } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import { cn } from "@/lib/utils";
import { useMarketSocket } from "@/hooks/useMarketSocket";
import {
  AI_SIGNALS_CHANNEL,
  PUBLIC_SIGNALS_CHANNEL,
  tickerChannel,
} from "@/lib/ws/protocol";
import { SELECTABLE_INTERVALS, type SelectableInterval } from "@/lib/validation";
import type { StoredAnalysis } from "@/lib/ai/store";
import type { MarketSignal, Interval } from "@/lib/market/types";

import { TimeframeSelector } from "@/components/dashboard/timeframe-selector";
import { FavoritesManager } from "@/components/dashboard/favorites-manager";
import { UpgradeModal } from "@/components/dashboard/upgrade-modal";
import { AiAnalysisDrawer } from "@/components/dashboard/ai-analysis-drawer";
import { ScanHistory } from "@/components/dashboard/scan-history";
import {
  LiveSignalsTable,
  type SignalRow,
} from "@/components/dashboard/live-signals-table";

// --- Feed API response shapes (from /api/analysis/feed) ---------------------

interface FeedFreeResponse {
  ok: true;
  plan: "free";
  broadcast: {
    analyses: StoredAnalysis[];
  } | null;
  favoritePairs?: string[];
  /** Favorite rows (15m), pinned above the broadcast picks. */
  favorites?: StoredAnalysis[];
  scanTimes?: Record<string, number>;
}

interface FeedProResponse {
  ok: true;
  plan: "pro";
  preferences: { intervals: SelectableInterval[]; favoritePairs: string[] };
  activeIntervals: Interval[];
  analyses: StoredAnalysis[];
  scanTimes?: Record<string, number>;
}

type FeedResponse = FeedFreeResponse | FeedProResponse;

/** A saved manual-scan result (mirrors the API's ScanHistoryEntry). */
interface ScanHistoryEntry {
  id: string;
  scannedAt: number;
  symbolsScanned: number;
  combosScanned: number;
  candidatesFound: number;
  analyses: StoredAnalysis[];
}

/**
 * The active table view: the live timeframe table, or the "Manual scans"
 * accordion list of saved scan results.
 */
type ActiveView = { kind: "live" } | { kind: "history" };

export interface DashboardLiveProps {
  plan: "free" | "pro";
  /** The user's persisted preferred intervals (Pro). Free is pinned to 15m. */
  initialIntervals: SelectableInterval[];
  /** The user's persisted favorite pairs. */
  initialFavorites: string[];
}

const FREE_INTERVAL: SelectableInterval = "15m";

export function DashboardLive({
  plan,
  initialIntervals,
  initialFavorites,
}: DashboardLiveProps) {
  const [active, setActive] = useState<SelectableInterval>(
    plan === "pro"
      ? (initialIntervals.find((i) => SELECTABLE_INTERVALS.includes(i)) ??
          FREE_INTERVAL)
      : FREE_INTERVAL,
  );
  const [analyses, setAnalyses] = useState<StoredAnalysis[]>([]);
  const [favorites, setFavorites] = useState<string[]>(initialFavorites);
  const [loadingFeed, setLoadingFeed] = useState(true);
  const [savingPref, setSavingPref] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [upgradeReason, setUpgradeReason] = useState<string | undefined>();
  const [selected, setSelected] = useState<StoredAnalysis | null>(null);

  // --- Live socket --------------------------------------------------------
  // Subscribe to the AI signal stream (Pro) or the public free channel, plus a
  // ticker channel per visible symbol at the active timeframe.
  const visibleSymbols = useMemo(
    () => analyses.map((a) => a.symbol),
    [analyses],
  );

  const channels = useMemo(() => {
    const set = new Set<string>();
    if (plan === "pro") {
      set.add(AI_SIGNALS_CHANNEL);
    }
    set.add(PUBLIC_SIGNALS_CHANNEL);

    // Visible rows for the active timeframe get live ticks.
    for (const symbol of visibleSymbols) {
      set.add(tickerChannel(symbol, active as Interval));
    }

    // Favorites are always pinned/visible, so subscribe to their live ticks
    // regardless of whether they're in the current analyses set. Pro favorites
    // render at the active timeframe; Free favorites are always 15m.
    const favInterval: Interval = plan === "pro" ? (active as Interval) : "15m";
    for (const sym of favorites) {
      set.add(tickerChannel(sym.toUpperCase(), favInterval));
    }
    return Array.from(set);
  }, [plan, visibleSymbols, active, favorites]);

  const {
    isConnected,
    latestTicks,
    latestSignals,
    freeSignals,
    latestBroadcast,
    scanStatus,
  } = useMarketSocket({ channels });

  const [scanning, setScanning] = useState(false);
  // Free-tier favorite rows (15m), pinned above the broadcast picks.
  const [freeFavoriteRows, setFreeFavoriteRows] = useState<StoredAnalysis[]>([]);
  // Manual scan history (Pro): dated, frozen result tabs after the 1h pill.
  const [history, setHistory] = useState<ScanHistoryEntry[]>([]);
  const [view, setView] = useState<ActiveView>({ kind: "live" });
  // Which saved scan is expanded in the "Manual scans" accordion.
  const [expandedScanId, setExpandedScanId] = useState<string | null>(null);
  // Per-interval last-scan timestamps (5m/15m/30m/1h → epoch ms).
  const [scanTimes, setScanTimes] = useState<Record<string, number>>({});
  // Ticks every few seconds so the "Scanned Xs ago" label stays fresh.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 3_000);
    return () => clearInterval(id);
  }, []);

  // --- Feed fetch (initial + on timeframe change for Pro) -----------------
  const loadFeed = useCallback(async () => {
    setLoadingFeed(true);
    try {
      const res = await fetch("/api/analysis/feed", { cache: "no-store" });
      const data = (await res.json()) as FeedResponse;
      if (data.scanTimes) setScanTimes((cur) => ({ ...cur, ...data.scanTimes }));
      if (data.plan === "free") {
        setAnalyses(data.broadcast?.analyses ?? []);
        setFreeFavoriteRows(data.favorites ?? []);
        if (data.favoritePairs) setFavorites(data.favoritePairs);
      } else if (data.plan === "pro") {
        setAnalyses(data.analyses ?? []);
        if (data.preferences?.favoritePairs) {
          setFavorites(data.preferences.favoritePairs);
        }
      }
    } catch {
      // Keep whatever we have; live socket still updates rows.
    } finally {
      setLoadingFeed(false);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    if (plan !== "pro") return;
    try {
      const res = await fetch("/api/analysis/scan/history", {
        cache: "no-store",
      });
      if (!res.ok) return; // Don't clobber existing history on a transient error.
      const data = (await res.json()) as {
        ok?: boolean;
        history?: ScanHistoryEntry[];
      };
      // Only replace when the server actually returned a history array.
      if (data.ok && Array.isArray(data.history)) {
        setHistory(data.history);
      }
    } catch {
      // best-effort — keep whatever we already have.
    }
  }, [plan]);

  useEffect(() => {
    void loadFeed();
    void loadHistory();
  }, [loadFeed, loadHistory]);

  // Merge live AI analyses into the feed set (Pro): newest wins per symbol.
  useEffect(() => {
    if (plan !== "pro" || latestSignals.length === 0) return;
    setAnalyses((prev) => {
      const byKey = new Map<string, StoredAnalysis>();
      for (const a of prev) byKey.set(`${a.symbol}:${a.interval}`, a);
      for (const a of latestSignals) byKey.set(`${a.symbol}:${a.interval}`, a);
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
  // the startup warm-up and manual scans (all intervals at once) are ignored so
  // each period reflects its own real candle close.
  useEffect(() => {
    if (!scanStatus || scanStatus.scanning) return;
    const ivs = scanStatus.intervals;
    if (!ivs || ivs.length !== 1 || scanStatus.trigger !== "interval") return;
    setScanTimes((cur) => ({ ...cur, [ivs[0]]: scanStatus.lastScanAt }));
  }, [scanStatus]);

  // --- Preference persistence (Pro) ---------------------------------------
  const persistInterval = useCallback(
    async (interval: SelectableInterval) => {
      setSavingPref(true);
      try {
        const res = await fetch("/api/user/preferences", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ intervals: [interval] }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: string;
          } | null;
          toast.error(body?.error ?? "Couldn't save your timeframe.");
        }
      } catch {
        toast.error("Couldn't save your timeframe.");
      } finally {
        setSavingPref(false);
      }
    },
    [],
  );

  const handleSelect = useCallback(
    (interval: SelectableInterval) => {
      // Switch instantly — analyses for all intervals are already loaded, so
      // the table filters client-side with no refetch (no empty flash / race).
      setActive(interval);
      // Persist the preference in the background so it's the default next load.
      if (plan === "pro") void persistInterval(interval);
    },
    [plan, persistInterval],
  );

  const handleLockedClick = useCallback((interval: SelectableInterval) => {
    setUpgradeReason(`The ${interval} timeframe is available on the Pro plan.`);
    setUpgradeOpen(true);
  }, []);

  const maxFavorites = plan === "pro" ? 10 : 3;

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

  // Pro-only manual scan: forces an immediate scan pass and refreshes the feed.
  const handleManualScan = useCallback(async () => {
    if (scanning) return;
    setScanning(true);
    try {
      const res = await fetch("/api/analysis/scan", { method: "POST" });
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        id?: string;
        candidatesFound?: number;
        matchedForUser?: number;
        symbolsScanned?: number;
        error?: string;
      } | null;
      if (res.ok && body?.ok) {
        const shown = body.matchedForUser ?? 0;
        const total = body.candidatesFound ?? 0;
        toast.success(
          `Scanned ${body.symbolsScanned ?? 0} symbols · ${shown} on ${active}` +
            (total > shown ? ` (${total} across all timeframes)` : ""),
        );
        // Refresh the LIVE table the user is viewing (and the saved history in
        // the background). Stay on the current live view — a manual scan should
        // update what's on screen, not yank the user into the history tab.
        await Promise.all([loadFeed(), loadHistory()]);
        if (view.kind !== "live") setView({ kind: "live" });
      } else if (res.status === 429) {
        toast.info("A scan is already running. Try again in a moment.");
      } else {
        toast.error(body?.error ?? "Scan failed.");
      }
    } catch {
      toast.error("Scan failed.");
    } finally {
      setScanning(false);
    }
  }, [scanning, active, loadFeed, loadHistory, view.kind]);

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

  // Scan label for the CURRENTLY selected timeframe (per-period, latest one).
  const scanLabel = useMemo(() => {
    if (scanStatus?.scanning || scanning) return "Scanning…";
    const ago = timeAgo(scanTimes[active]);
    if (ago) return `${active} scanned ${ago}`;
    return isConnected ? `Waiting for first ${active} scan…` : null;
  }, [scanStatus, scanning, isConnected, scanTimes, active, timeAgo]);

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
    let source: StoredAnalysis[];
    if (plan === "pro") {
      source = analyses.filter((a) => a.interval === active);
    } else {
      // Free: favorite rows (15m) + broadcast picks, de-duplicated by symbol.
      const byKey = new Map<string, StoredAnalysis>();
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
      } satisfies SignalRow;
    });
  }, [plan, analyses, freeFavoriteRows, active, signalIndex, favoriteSet]);

  // Builds frozen rows for a saved manual scan (favorites pinned; no obscuring).
  const buildHistoryRows = useCallback(
    (entry: ScanHistoryEntry): SignalRow[] => {
      const sorted = [...entry.analyses].sort((a, b) => {
        const aFav = favoriteSet.has(a.symbol.toUpperCase()) ? 1 : 0;
        const bFav = favoriteSet.has(b.symbol.toUpperCase()) ? 1 : 0;
        if (aFav !== bFav) return bFav - aFav;
        return b.score - a.score;
      });
      return sorted.map((a) => ({
        symbol: a.symbol,
        interval: a.interval,
        direction: a.direction,
        pattern: a.pattern,
        price: a.price,
        changePct: null,
        rsi: null,
        atrPct: null,
        score: a.score,
        status: a.ai.riskLevel,
        aiAction: a.direction,
        analysis: a,
        isFavorite: favoriteSet.has(a.symbol.toUpperCase()),
        obscured: false,
      }));
    },
    [favoriteSet],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <TimeframeSelector
            plan={plan}
            active={active}
            onSelect={(iv) => {
              setView({ kind: "live" });
              handleSelect(iv);
            }}
            onLockedClick={handleLockedClick}
            disabled={savingPref}
          />
          {/* "Manual scans" tab (Pro): opens the saved-scans accordion. */}
          {plan === "pro" && (
            <button
              type="button"
              onClick={() => {
                setView({ kind: "history" });
                void loadHistory();
              }}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
                view.kind === "history"
                  ? "border-primary/40 bg-primary/15 text-primary"
                  : "border-white/10 text-muted-foreground hover:text-foreground",
              )}
            >
              <RadarIcon className="size-3.5" />
              Manual scans
              {history.length > 0 && (
                <span className="rounded-full bg-white/10 px-1.5 text-[10px] tabular-nums">
                  {history.length}
                </span>
              )}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs">
          {savingPref && (
            <span className="flex items-center gap-1 text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Saving…
            </span>
          )}

          {/* Live scan-status indicator (both tiers). */}
          {scanLabel && (
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium",
                scanStatus?.scanning || scanning
                  ? "bg-primary/15 text-primary"
                  : "bg-white/10 text-muted-foreground",
              )}
            >
              <RadarIcon
                className={cn(
                  "size-3.5",
                  (scanStatus?.scanning || scanning) && "animate-pulse",
                )}
              />
              {scanLabel}
            </span>
          )}

          {/* Manual scan (Pro only). */}
          {plan === "pro" && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 px-2.5 text-xs"
              onClick={handleManualScan}
              disabled={scanning}
            >
              <RefreshCw
                className={cn("size-3.5", scanning && "animate-spin")}
              />
              Scan now
            </Button>
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
        </div>
      </div>

      {/* Per-period scan times: latest scan for each timeframe. */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium">Last scan:</span>
        {SELECTABLE_INTERVALS.map((iv) => {
          const ago = timeAgo(scanTimes[iv]);
          return (
            <span
              key={iv}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border border-white/10 px-2 py-0.5",
                iv === active && "border-primary/40 bg-primary/10 text-primary",
              )}
            >
              <span className="font-semibold">{iv}</span>
              <span>{ago ?? "—"}</span>
            </span>
          );
        })}
      </div>

      <FavoritesManager
        plan={plan}
        favorites={favorites}
        onAdd={(sym) => handleToggleFavorite(sym, false)}
        onRemove={(sym) => handleToggleFavorite(sym, true)}
      />

      {view.kind === "history" ? (
        <ScanHistory
          entries={history}
          expandedId={expandedScanId}
          onToggleExpand={(id) =>
            setExpandedScanId((cur) => (cur === id ? null : id))
          }
          buildRows={buildHistoryRows}
          latestTicks={latestTicks}
          onRowClick={(a) => setSelected(a)}
          onToggleFavorite={handleToggleFavorite}
        />
      ) : loadingFeed && rows.length === 0 ? (
        <div className="flex h-40 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" /> Loading signals…
        </div>
      ) : (
        <LiveSignalsTable
          plan={plan}
          rows={rows}
          latestTicks={latestTicks}
          onRowClick={(a) => setSelected(a)}
          onToggleFavorite={handleToggleFavorite}
          onUpgradeClick={() => {
            setUpgradeReason(undefined);
            setUpgradeOpen(true);
          }}
        />
      )}

      <AiAnalysisDrawer
        analysis={selected}
        open={selected != null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
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
