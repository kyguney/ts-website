"use client";

import { Lock } from "lucide-react";

import { cn } from "@/lib/utils";
import { SELECTABLE_INTERVALS, type SelectableInterval } from "@/lib/validation";

export interface TimeframeSelectorProps {
  plan: "free" | "pro";
  active: SelectableInterval;
  onSelect: (interval: SelectableInterval) => void;
  /** Called when a Free user clicks a locked timeframe. */
  onLockedClick: (interval: SelectableInterval) => void;
  /** Disable interaction (e.g. while a preference PATCH is in-flight). */
  disabled?: boolean;
}

/**
 * Interval pills (5m / 15m / 30m / 1h).
 *   FREE: only 15m selectable; the rest show a Lock icon and open the upgrade
 *         modal on click.
 *   PRO:  all four freely switchable.
 */
export function TimeframeSelector({
  plan,
  active,
  onSelect,
  onLockedClick,
  disabled = false,
}: TimeframeSelectorProps) {
  return (
    <div
      role="tablist"
      aria-label="Timeframe"
      className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] p-1"
    >
      {SELECTABLE_INTERVALS.map((interval) => {
        const locked = plan === "free" && interval !== "15m";
        const isActive = active === interval;
        return (
          <button
            key={interval}
            type="button"
            role="tab"
            aria-selected={isActive}
            disabled={disabled}
            onClick={() => {
              if (disabled) return;
              if (locked) {
                onLockedClick(interval);
              } else {
                onSelect(interval);
              }
            }}
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
              isActive
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
              locked && "opacity-70",
              disabled && "cursor-not-allowed",
            )}
          >
            {interval}
            {locked && <Lock className="size-3" aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}
