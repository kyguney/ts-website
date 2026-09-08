"use client";

import { ChevronDown, History } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  LiveSignalsTable,
  type SignalRow,
} from "@/components/dashboard/live-signals-table";
import type { StoredAnalysis } from "@/lib/ai/store";
import type { MarketTick } from "@/lib/market/redis-pipeline";

export interface ScanHistoryEntry {
  id: string;
  scannedAt: number;
  symbolsScanned: number;
  combosScanned: number;
  candidatesFound: number;
  analyses: StoredAnalysis[];
}

export interface ScanHistoryProps {
  entries: ScanHistoryEntry[];
  expandedId: string | null;
  onToggleExpand: (id: string) => void;
  buildRows: (entry: ScanHistoryEntry) => SignalRow[];
  latestTicks: Record<string, MarketTick>;
  onRowClick: (analysis: StoredAnalysis) => void;
  onToggleFavorite: (symbol: string, isFavorite: boolean) => void;
}

function formatWhen(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * "Manual scans" view: an accordion list of saved scan results. Each row is
 * titled with its date/time; expanding it reveals that scan's frozen table.
 */
export function ScanHistory({
  entries,
  expandedId,
  onToggleExpand,
  buildRows,
  latestTicks,
  onRowClick,
  onToggleFavorite,
}: ScanHistoryProps) {
  if (entries.length === 0) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] text-center text-sm text-muted-foreground">
        <History className="size-5" />
        No manual scans yet. Hit <span className="text-foreground">Scan now</span>{" "}
        to save a snapshot you can review later.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <History className="size-4" /> Manual scans
        <span className="text-xs">({entries.length} saved)</span>
      </div>

      {entries.map((entry) => {
        const open = expandedId === entry.id;
        return (
          <div
            key={entry.id}
            className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]"
          >
            <button
              type="button"
              onClick={() => onToggleExpand(entry.id)}
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.04]"
              aria-expanded={open}
            >
              <div className="flex flex-col">
                <span className="text-sm font-semibold">
                  {formatWhen(entry.scannedAt)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {entry.candidatesFound} candidate(s) across{" "}
                  {entry.symbolsScanned} symbols
                </span>
              </div>
              <ChevronDown
                className={cn(
                  "size-4 shrink-0 text-muted-foreground transition-transform",
                  open && "rotate-180",
                )}
              />
            </button>

            {open && (
              <div className="border-t border-white/10 p-2">
                <LiveSignalsTable
                  plan="pro"
                  rows={buildRows(entry)}
                  latestTicks={latestTicks}
                  onRowClick={onRowClick}
                  onToggleFavorite={onToggleFavorite}
                  onUpgradeClick={() => {}}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
