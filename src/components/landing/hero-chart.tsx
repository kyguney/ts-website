"use client";

import * as React from "react";
import { Maximize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { MarketRegimeBadge } from "./market-regime-badge";
import type {
  PublicChartResponse,
  PublicInterval,
  PublicRegime,
} from "@/lib/landing/public-market";

const TIMEFRAMES: PublicInterval[] = ["15m", "1h", "4h", "1d"];

type ApiPayload = { chart: PublicChartResponse; regime: PublicRegime };

/** Draws a dark-navy candlestick chart onto a canvas from OHLC candles. */
function CandleCanvas({ chart }: { chart: PublicChartResponse | null }) {
  const ref = React.useRef<HTMLCanvasElement>(null);

  React.useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !chart || chart.candles.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const W = rect.width;
    const H = rect.height;
    ctx.clearRect(0, 0, W, H);

    const candles = chart.candles;
    const highs = candles.map((c) => c.h);
    const lows = candles.map((c) => c.l);
    const max = Math.max(...highs);
    const min = Math.min(...lows);
    const range = max - min || 1;
    const padY = 12;

    const yOf = (v: number) => padY + (1 - (v - min) / range) * (H - padY * 2);

    // Subtle horizontal grid.
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padY + (i / 4) * (H - padY * 2);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }

    const slot = W / candles.length;
    const bodyW = Math.max(2, Math.min(10, slot * 0.62));

    candles.forEach((c, i) => {
      const x = i * slot + slot / 2;
      const up = c.c >= c.o;
      const color = up ? "#00b875" : "#ef4444";
      ctx.strokeStyle = color;
      ctx.fillStyle = color;

      // Wick.
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, yOf(c.h));
      ctx.lineTo(x, yOf(c.l));
      ctx.stroke();

      // Body.
      const yO = yOf(c.o);
      const yC = yOf(c.c);
      const top = Math.min(yO, yC);
      const h = Math.max(1.5, Math.abs(yC - yO));
      ctx.globalAlpha = up ? 0.95 : 0.9;
      ctx.fillRect(x - bodyW / 2, top, bodyW, h);
      ctx.globalAlpha = 1;
    });
  }, [chart]);

  return <canvas ref={ref} className="h-full w-full" aria-label="BTC/USDT candlestick chart" />;
}

/** Circular TrendScore gauge (0..100). */
function ScoreGauge({
  score,
  label,
  loading,
}: {
  score: number;
  label: string;
  loading?: boolean;
}) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const dash = c * pct;

  return (
    <div className="flex flex-col items-center">
      <span className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--ts-text-muted)]">
        TrendScore
      </span>
      <div className="relative size-[84px]">
        <svg viewBox="0 0 84 84" className="size-full -rotate-90">
          <circle cx="42" cy="42" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="7" />
          <circle
            cx="42"
            cy="42"
            r={r}
            fill="none"
            stroke="url(#gauge-grad)"
            strokeWidth="7"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${c}`}
            className="transition-[stroke-dasharray] duration-700 ease-out"
          />
          <defs>
            <linearGradient id="gauge-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#00b875" />
              <stop offset="100%" stopColor="#38bdf8" />
            </linearGradient>
          </defs>
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-bold leading-none tabular-nums">
            {loading ? "–" : score}
          </span>
          <span className="text-[9px] text-[var(--ts-text-muted)]">/ 100</span>
        </div>
      </div>
      <span
        className={cn(
          "mt-1 text-xs font-semibold",
          label === "Bullish"
            ? "text-[var(--ts-emerald)]"
            : label === "Bearish"
              ? "text-[var(--ts-red)]"
              : "text-[var(--ts-slate)]",
        )}
      >
        {loading ? "—" : label}
      </span>
    </div>
  );
}

/** A labeled meter bar (Momentum / Volume). */
function Meter({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[10px] text-[var(--ts-text-muted)]">
        <span>{label}</span>
        <span className="tabular-nums">{value}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full transition-[width] duration-700 ease-out"
          style={{ width: `${value}%`, background: color }}
        />
      </div>
    </div>
  );
}

function formatPrice(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function HeroChart() {
  const [interval, setInterval] = React.useState<PublicInterval>("1h");
  const [data, setData] = React.useState<ApiPayload | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    fetch(`/api/public/chart?symbol=BTCUSDT&interval=${interval}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((json: ApiPayload) => {
        if (!cancelled) {
          setData(json);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [interval]);

  const chart = data?.chart ?? null;
  const isLive = chart?.live ?? false;

  return (
    <div className="ts-card overflow-hidden">
      {/* Header: pair, badge, timeframe toggles */}
      <div className="flex items-center justify-between border-b border-[var(--ts-stroke)] px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">BTC / USDT</span>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-semibold",
              isLive
                ? "bg-[var(--ts-emerald)]/15 text-[var(--ts-emerald)]"
                : "bg-white/10 text-[var(--ts-text-muted)]",
            )}
          >
            {isLive ? "LIVE" : "SAMPLE"}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <div className="flex items-center rounded-lg border border-[var(--ts-stroke)] p-0.5">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                type="button"
                onClick={() => setInterval(tf)}
                className={cn(
                  "rounded-md px-2 py-1 text-xs font-medium transition-colors",
                  interval === tf
                    ? "bg-[var(--ts-cyan)]/20 text-[var(--ts-cyan-2)]"
                    : "text-[var(--ts-text-muted)] hover:text-[var(--ts-text)]",
                )}
                aria-pressed={interval === tf}
              >
                {tf}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="ml-1 rounded-md p-1.5 text-[var(--ts-text-muted)] hover:text-[var(--ts-text)]"
            aria-label="Expand chart"
            tabIndex={-1}
          >
            <Maximize2 className="size-3.5" />
          </button>
        </div>
      </div>

      {/* Regime badge */}
      <div className="px-4 pt-4">
        <MarketRegimeBadge regime={data?.regime} loading={loading} />
      </div>

      {/* Chart + gauge */}
      <div className="grid gap-4 px-4 py-4 sm:grid-cols-[1fr_auto]">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-bold tabular-nums">
              {loading ? (
                <span className="inline-block h-6 w-28 rounded ts-skeleton align-middle" />
              ) : (
                `$${formatPrice(chart?.price ?? 0)}`
              )}
            </span>
            {!loading && chart && (
              <span
                className={cn(
                  "text-sm font-medium tabular-nums",
                  chart.changePct >= 0 ? "text-[var(--ts-emerald)]" : "text-[var(--ts-red)]",
                )}
              >
                {chart.changePct >= 0 ? "+" : ""}
                {chart.changePct.toFixed(2)}%
              </span>
            )}
          </div>

          <div className="mt-2 h-[180px] w-full">
            {loading ? (
              <div className="h-full w-full rounded-lg ts-skeleton" />
            ) : error && !chart ? (
              <div className="flex h-full w-full items-center justify-center rounded-lg border border-dashed border-[var(--ts-stroke)] text-xs text-[var(--ts-text-muted)]">
                Chart data unavailable. Retrying shortly…
              </div>
            ) : (
              <CandleCanvas chart={chart} />
            )}
          </div>
        </div>

        {/* Gauge + meters */}
        <div className="flex w-full flex-row items-center gap-4 sm:w-[150px] sm:flex-col sm:items-stretch">
          <ScoreGauge
            score={chart?.score ?? 84}
            label={chart?.scoreLabel ?? "Bullish"}
            loading={loading}
          />
          <div className="flex-1 space-y-3 sm:flex-none">
            <Meter label="Momentum" value={loading ? 0 : chart?.momentum ?? 0} color="var(--ts-emerald)" />
            <Meter label="Volume" value={loading ? 0 : chart?.volume ?? 0} color="var(--ts-cyan)" />
          </div>
        </div>
      </div>
    </div>
  );
}
