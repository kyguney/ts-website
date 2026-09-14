"use client";

import * as React from "react";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Sparkline } from "./sparkline";
import type { PublicSignal } from "@/lib/landing/public-market";

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatPrice(n: number): string {
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(2);
  return n.toPrecision(4);
}

const DIRECTION_META = {
  LONG: {
    pill: "bg-[var(--ts-emerald)]/15 text-[var(--ts-emerald)]",
    stroke: "var(--ts-emerald)",
    Icon: TrendingUp,
  },
  SHORT: {
    pill: "bg-[var(--ts-red)]/15 text-[var(--ts-red)]",
    stroke: "var(--ts-red)",
    Icon: TrendingDown,
  },
  NEUTRAL: {
    pill: "bg-white/10 text-[var(--ts-slate)]",
    stroke: "var(--ts-slate)",
    Icon: Minus,
  },
} as const;

function SignalCard({ s }: { s: PublicSignal }) {
  const meta = DIRECTION_META[s.direction];
  const { Icon } = meta;
  return (
    <div className="ts-card flex flex-col p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="grid size-8 place-items-center rounded-full bg-white/[0.06] text-xs font-bold">
            {s.symbol.replace("USDT", "").slice(0, 3)}
          </span>
          <div>
            <div className="text-sm font-semibold">
              {s.symbol.replace("USDT", "")} / USDT
            </div>
            <div className="text-[11px] text-[var(--ts-text-muted)]">{s.label}</div>
          </div>
        </div>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold",
            meta.pill,
          )}
        >
          <Icon className="size-3" />
          {s.direction}
        </span>
      </div>

      <div className="my-4 h-12 w-full">
        <Sparkline points={s.spark} stroke={meta.stroke} width={280} height={48} />
      </div>

      <div className="mt-auto grid grid-cols-3 gap-2 border-t border-[var(--ts-stroke)] pt-3 text-xs">
        <div>
          <div className="text-[10px] uppercase text-[var(--ts-text-muted)]">Timeframe</div>
          <div className="mt-0.5 font-medium">{s.interval}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-[var(--ts-text-muted)]">TrendScore</div>
          <div className="mt-0.5 font-medium tabular-nums">{s.score}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-[var(--ts-text-muted)]">Updated</div>
          <div className="mt-0.5 font-medium">{timeAgo(s.updatedAt)}</div>
        </div>
      </div>
    </div>
  );
}

function SignalSkeleton() {
  return (
    <div className="ts-card flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="size-8 rounded-full ts-skeleton" />
          <div className="space-y-1.5">
            <div className="h-3 w-24 rounded ts-skeleton" />
            <div className="h-2.5 w-16 rounded ts-skeleton" />
          </div>
        </div>
        <div className="h-6 w-16 rounded-full ts-skeleton" />
      </div>
      <div className="h-12 w-full rounded ts-skeleton" />
      <div className="h-8 w-full rounded ts-skeleton" />
    </div>
  );
}

export function SignalsList() {
  const [signals, setSignals] = React.useState<PublicSignal[] | null>(null);
  const [error, setError] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch("/api/public/signals")
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((json: { signals: PublicSignal[] }) => {
          if (!cancelled) {
            setSignals(json.signals);
            setError(false);
          }
        })
        .catch(() => {
          if (!cancelled) setError(true);
        });
    load();
    const id = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  if (error && !signals) {
    return (
      <div className="ts-card p-8 text-center text-sm text-[var(--ts-text-muted)]">
        Signals are temporarily unavailable. Please check back in a moment.
      </div>
    );
  }

  return (
    <div className="grid gap-5 md:grid-cols-3">
      {signals === null
        ? Array.from({ length: 3 }).map((_, i) => <SignalSkeleton key={i} />)
        : signals.map((s) => <SignalCard key={`${s.symbol}-${s.interval}`} s={s} />)}
    </div>
  );
}
