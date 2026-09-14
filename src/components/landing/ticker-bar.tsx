"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Sparkline } from "./sparkline";
import type { PublicTicker } from "@/lib/landing/public-market";

function formatPrice(n: number): string {
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(2);
  return n.toPrecision(4);
}

function TickerCard({ t }: { t: PublicTicker }) {
  const up = t.changePct >= 0;
  const scoreColor =
    t.scoreLabel === "Bullish"
      ? "text-[var(--ts-emerald)]"
      : t.scoreLabel === "Bearish"
        ? "text-[var(--ts-red)]"
        : "text-[var(--ts-slate)]";
  return (
    <div className="ts-card flex items-center gap-3 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-semibold">{t.symbol.replace("USDT", "")}</span>
          <span className="text-[10px] text-[var(--ts-text-muted)]">{t.label}</span>
        </div>
        <div className="mt-0.5 flex items-baseline gap-1.5">
          <span className="text-sm tabular-nums">${formatPrice(t.price)}</span>
          <span
            className={cn(
              "text-[11px] tabular-nums",
              up ? "text-[var(--ts-emerald)]" : "text-[var(--ts-red)]",
            )}
          >
            {up ? "+" : ""}
            {t.changePct.toFixed(2)}%
          </span>
        </div>
      </div>
      <div className="ml-auto w-16 shrink-0">
        <Sparkline
          points={t.spark}
          stroke={up ? "var(--ts-emerald)" : "var(--ts-red)"}
          width={64}
          height={28}
        />
      </div>
      <div className={cn("shrink-0 text-right text-sm font-bold tabular-nums", scoreColor)}>
        {t.score}
      </div>
    </div>
  );
}

function TickerSkeleton() {
  return (
    <div className="ts-card flex items-center gap-3 px-4 py-3">
      <div className="space-y-2">
        <div className="h-3 w-16 rounded ts-skeleton" />
        <div className="h-3 w-20 rounded ts-skeleton" />
      </div>
      <div className="ml-auto h-7 w-16 rounded ts-skeleton" />
    </div>
  );
}

export function TickerBar() {
  const [tickers, setTickers] = React.useState<PublicTicker[] | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch("/api/public/tickers")
        .then((r) => r.json())
        .then((json: { tickers: PublicTicker[] }) => {
          if (!cancelled) setTickers(json.tickers);
        })
        .catch(() => {
          if (!cancelled) setTickers([]);
        });
    load();
    const id = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tickers === null
        ? Array.from({ length: 4 }).map((_, i) => <TickerSkeleton key={i} />)
        : tickers.map((t) => <TickerCard key={t.symbol} t={t} />)}
    </div>
  );
}
