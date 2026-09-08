"use client";

import { useEffect, useRef, useState } from "react";
import { Lock, Star } from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import type { StoredAnalysis } from "@/lib/ai/store";
import type { MarketTick } from "@/lib/market/redis-pipeline";
import type { Interval } from "@/lib/market/types";

export interface SignalRow {
  symbol: string;
  interval: Interval;
  direction: "LONG" | "SHORT";
  pattern: string;
  price: number;
  changePct: number | null;
  rsi: number | null;
  atrPct: number | null;
  score: number;
  status: string;
  aiAction: string;
  /** The full analysis, when available, for the detail drawer. */
  analysis: StoredAnalysis | null;
  /** Pinned favorite (shows a star; always visible on Free). */
  isFavorite?: boolean;
  /** For Free view: rows beyond the top broadcast pick are obscured. */
  obscured?: boolean;
}

export interface LiveSignalsTableProps {
  plan: "free" | "pro";
  rows: SignalRow[];
  /** Live ticks keyed by `ticker:SYMBOL:INTERVAL`. */
  latestTicks: Record<string, MarketTick>;
  onRowClick: (analysis: StoredAnalysis) => void;
  onUpgradeClick: () => void;
  /** Toggle a symbol in the user's favorites (quick-add star). */
  onToggleFavorite: (symbol: string, isFavorite: boolean) => void;
}

function fmtPrice(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const digits = n >= 1 ? 2 : n >= 0.01 ? 4 : 8;
  return n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function LiveSignalsTable({
  plan,
  rows,
  latestTicks,
  onRowClick,
  onUpgradeClick,
  onToggleFavorite,
}: LiveSignalsTableProps) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-muted-foreground">
            <tr className="border-b border-white/10">
              <th className="w-8 px-2 py-3 font-medium" aria-label="Favorite"></th>
              <th className="px-4 py-3 font-medium">Symbol</th>
              <th className="px-3 py-3 font-medium">TF</th>
              <th className="px-3 py-3 font-medium">Dir</th>
              <th className="px-3 py-3 font-medium">Pattern</th>
              <th className="px-3 py-3 text-right font-medium">Price</th>
              <th className="px-3 py-3 text-right font-medium">24h</th>
              <th className="px-3 py-3 text-right font-medium">RSI</th>
              <th className="px-3 py-3 text-right font-medium">ATR%</th>
              <th className="px-3 py-3 text-right font-medium">Score</th>
              <th className="px-3 py-3 font-medium">Status</th>
              <th className="px-3 py-3 font-medium">AI</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={12}
                  className="px-4 py-10 text-center text-sm text-muted-foreground"
                >
                  Waiting for live signals…
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <SignalTableRow
                key={`${row.symbol}:${row.interval}`}
                row={row}
                tick={latestTicks[`ticker:${row.symbol}:${row.interval}`]}
                onClick={() => row.analysis && onRowClick(row.analysis)}
                onToggleFavorite={onToggleFavorite}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Free upgrade overlay covering the obscured region. */}
      {plan === "free" && rows.some((r) => r.obscured) && (
        <button
          type="button"
          onClick={onUpgradeClick}
          className="group absolute inset-x-0 bottom-0 flex h-1/2 flex-col items-center justify-end gap-2 bg-gradient-to-t from-background via-background/85 to-transparent pb-6 text-center"
        >
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/15 px-3 py-1 text-xs font-semibold text-primary">
            <Lock className="size-3.5" /> Pro
          </span>
          <span className="max-w-xs px-4 text-sm text-foreground group-hover:underline">
            Upgrade to Pro for real-time 5m/30m breakout alerts and instant AI
            trade signals.
          </span>
        </button>
      )}
    </div>
  );
}

function useFlash(value: number): "up" | "down" | null {
  const prev = useRef<number | null>(null);
  const [dir, setDir] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    if (prev.current != null && value !== prev.current) {
      setDir(value > prev.current ? "up" : "down");
      const t = setTimeout(() => setDir(null), 600);
      prev.current = value;
      return () => clearTimeout(t);
    }
    prev.current = value;
  }, [value]);

  return dir;
}

function SignalTableRow({
  row,
  tick,
  onClick,
  onToggleFavorite,
}: {
  row: SignalRow;
  tick?: MarketTick;
  onClick: () => void;
  onToggleFavorite: (symbol: string, isFavorite: boolean) => void;
}) {
  // Live price overrides the snapshot price when a tick has arrived.
  const price = tick?.price ?? row.price;
  const priceFlash = useFlash(price);
  const scoreFlash = useFlash(row.score);
  const isLong = row.direction === "LONG";

  const clickable = row.analysis != null && !row.obscured;

  return (
    <tr
      onClick={clickable ? onClick : undefined}
      className={cn(
        "border-b border-white/5 transition-colors last:border-0",
        clickable && "cursor-pointer hover:bg-white/[0.04]",
        row.obscured && "select-none blur-sm",
      )}
      aria-hidden={row.obscured}
    >
      <td className="px-2 py-3 text-center">
        {!row.obscured && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(row.symbol, Boolean(row.isFavorite));
            }}
            className="rounded p-1 transition-colors hover:bg-white/10"
            aria-label={
              row.isFavorite
                ? `Remove ${row.symbol} from favorites`
                : `Add ${row.symbol} to favorites`
            }
            title={row.isFavorite ? "Remove favorite" : "Add to favorites"}
          >
            <Star
              className={cn(
                "size-4 transition-colors",
                row.isFavorite
                  ? "fill-amber-400 text-amber-400"
                  : "text-muted-foreground hover:text-amber-300",
              )}
            />
          </button>
        )}
      </td>
      <td className="px-4 py-3 font-semibold">{row.symbol}</td>
      <td className="px-3 py-3 text-muted-foreground">{row.interval}</td>
      <td className="px-3 py-3">
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold",
            isLong
              ? "bg-emerald-500/15 text-emerald-400"
              : "bg-rose-500/15 text-rose-400",
          )}
        >
          {row.direction}
        </span>
      </td>
      <td className="max-w-[180px] truncate px-3 py-3 text-muted-foreground">
        {row.pattern}
      </td>
      <td
        className={cn(
          "px-3 py-3 text-right font-mono tabular-nums",
          priceFlash === "up" && "flash-up",
          priceFlash === "down" && "flash-down",
        )}
      >
        {fmtPrice(price)}
      </td>
      <td
        className={cn(
          "px-3 py-3 text-right tabular-nums",
          row.changePct == null
            ? "text-muted-foreground"
            : row.changePct >= 0
              ? "text-emerald-400"
              : "text-rose-400",
        )}
      >
        {row.changePct == null
          ? "—"
          : `${row.changePct >= 0 ? "+" : ""}${row.changePct.toFixed(2)}%`}
      </td>
      <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
        {row.rsi == null ? "—" : row.rsi.toFixed(0)}
      </td>
      <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
        {row.atrPct == null ? "—" : `${row.atrPct.toFixed(2)}%`}
      </td>
      <td
        className={cn(
          "px-3 py-3 text-right",
          scoreFlash === "up" && "flash-up",
          scoreFlash === "down" && "flash-down",
        )}
      >
        <div className="flex items-center justify-end gap-2">
          <div className="h-1.5 w-14 overflow-hidden rounded-full bg-white/10">
            <div
              className={cn(
                "h-full rounded-full",
                isLong ? "bg-emerald-500" : "bg-rose-500",
              )}
              style={{ width: `${Math.min(100, (row.score / 300) * 100)}%` }}
            />
          </div>
          <span className="tabular-nums">{row.score.toFixed(0)}</span>
        </div>
      </td>
      <td className="px-3 py-3">
        <span className="text-xs text-muted-foreground">{row.status}</span>
      </td>
      <td className="px-3 py-3">
        {row.analysis ? (
          <Badge
            variant="outline"
            className={cn(
              "text-[11px]",
              row.aiAction === "LONG" && "text-emerald-400",
              row.aiAction === "SHORT" && "text-rose-400",
            )}
          >
            {row.aiAction}
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>
    </tr>
  );
}
