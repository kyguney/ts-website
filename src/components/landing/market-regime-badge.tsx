import { Globe } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PublicRegime } from "@/lib/landing/public-market";

/** Formats a large USDT figure to a compact `$53.48B` style string. */
function formatVolume(usdt: number): string {
  if (usdt >= 1e12) return `$${(usdt / 1e12).toFixed(2)}T`;
  if (usdt >= 1e9) return `$${(usdt / 1e9).toFixed(2)}B`;
  if (usdt >= 1e6) return `$${(usdt / 1e6).toFixed(2)}M`;
  return `$${usdt.toFixed(0)}`;
}

/**
 * Market regime banner shown inside the hero preview card. Matches the design:
 * overline "MARKET REGIME & 24H VOL", a bold status line with emoji + volume,
 * and a "Total Market Liquidity" subtitle.
 */
export function MarketRegimeBadge({
  regime,
  loading,
  className,
}: {
  regime?: PublicRegime | null;
  loading?: boolean;
  className?: string;
}) {
  const statusColor =
    regime?.status === "BEARISH"
      ? "text-[var(--ts-red)]"
      : regime?.status === "NEUTRAL"
        ? "text-[var(--ts-slate)]"
        : "text-[var(--ts-emerald)]";

  return (
    <div className={cn("ts-card px-4 py-3", className)}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ts-text-muted)]">
          Market Regime &amp; 24h Vol
        </span>
        <Globe className="size-4 text-[var(--ts-cyan-2)]" aria-hidden />
      </div>

      {loading ? (
        <div className="mt-2 h-6 w-40 rounded ts-skeleton" />
      ) : (
        <div className="mt-1 flex items-baseline gap-1.5 text-lg font-bold">
          <span aria-hidden>{regime?.emoji ?? "🚀"}</span>
          <span className={statusColor}>{regime?.status ?? "BULLISH"}</span>
          <span className="text-[var(--ts-text-muted)]">|</span>
          <span className="text-[var(--ts-cyan-2)]">
            {formatVolume(regime?.totalVolumeUsdt ?? 53.48e9)}
          </span>
        </div>
      )}

      <p className="mt-0.5 text-xs text-[var(--ts-text-muted)]">
        Total Market Liquidity
      </p>
    </div>
  );
}
