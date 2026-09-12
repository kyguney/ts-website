// ---------------------------------------------------------------------------
// dashboard-live.helpers — pure, framework-free helpers shared between
// `DashboardLive` and the unit-test harness (scripts/test-unit.ts).
//
// Everything here is a pure function or constant so it can be asserted without
// a DOM/React test runner (see the design's Testing Strategy: PBT is not
// applicable; these helpers are covered by example assertions).
// ---------------------------------------------------------------------------

import type { SelectableInterval } from "@/lib/validation";
import type { ScanStatus } from "@/lib/market/redis-pipeline";
import type { Interval } from "@/lib/market/types";

/**
 * The tier plans the dashboard serves. Mirrors the inline `plan` union on
 * `DashboardLiveProps` / `UserMenuProps`.
 */
export type Plan = "free" | "pro" | "ultimate";

/**
 * The intervals the dashboard can display. Relocated from the (deleted)
 * `timeframe-selector.tsx`. "1m" is Ultimate-only and is not a user-selectable
 * preference interval, so it lives outside `SELECTABLE_INTERVALS`.
 */
export type DisplayInterval = SelectableInterval | "1m";

/**
 * The single interval each tier is served (Concern B). Each plan maps to
 * exactly one served `DisplayInterval`.
 */
export const SERVED_INTERVAL = {
  free: "15m",
  pro: "5m",
  ultimate: "1m",
} as const satisfies Record<Plan, DisplayInterval>;

/** Pure accessor for the served interval of a plan. */
export function servedIntervalForPlan(plan: Plan): DisplayInterval {
  return SERVED_INTERVAL[plan];
}

/**
 * Safety-net poll cadence per tier (ms). Deliberately much shorter than a full
 * candle period so a slow/absent heartbeat still refreshes the cheap feed read.
 * Faster tiers poll more often: ultimate < pro < free.
 */
export const REFRESH_MS = {
  free: 60_000, // 60s
  pro: 30_000, // 30s
  ultimate: 15_000, // 15s
} as const satisfies Record<Plan, number>;

/** Pure accessor for the safety-net poll cadence (ms) of a plan. */
export function refreshMsForPlan(plan: Plan): number {
  return REFRESH_MS[plan];
}

/**
 * Predicate behind the heartbeat-driven Feed_Refresh. Returns `true` only when
 * a scan for the served interval has newly completed:
 *
 *   • `false` when `scanStatus` is absent (no heartbeat yet),
 *   • `false` while a scan is actively running (`scanning`),
 *   • `false` when `intervals` omits the served interval,
 *   • `false` when `lastScanAt <= lastRefreshAt` (dedupe on the last-handled
 *     scan so a re-emitted heartbeat does not retrigger / loop),
 *   • `true` for a completed scan whose `intervals` include `servedInterval`
 *     with a strictly newer `lastScanAt`.
 */
export function shouldRefreshOnHeartbeat(
  scanStatus: ScanStatus | null | undefined,
  servedInterval: DisplayInterval,
  lastRefreshAt: number,
): boolean {
  if (!scanStatus) return false;
  if (scanStatus.scanning) return false;
  const intervals = scanStatus.intervals;
  if (!intervals || !intervals.includes(servedInterval as Interval)) {
    return false;
  }
  if (scanStatus.lastScanAt <= lastRefreshAt) return false; // dedupe
  return true;
}

/**
 * Derives 1–2 uppercase initials for the avatar trigger. Prefers the person's
 * name (first + last initial, or the first char of a single-word name), and
 * falls back to the local part of the email. Always returns 1–2 uppercase
 * characters; returns "?" only when neither name nor a usable email exists.
 */
export function initialsFromIdentity(
  name: string | null | undefined,
  email: string | null | undefined,
): string {
  const trimmedName = name?.trim() ?? "";
  if (trimmedName) {
    const parts = trimmedName.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
    }
    const single = parts[0]!;
    return single.slice(0, 2).toUpperCase();
  }

  const local = (email ?? "").trim().split("@")[0] ?? "";
  const cleaned = local.replace(/[^a-zA-Z0-9]/g, "");
  if (cleaned) return cleaned.slice(0, 2).toUpperCase();

  return "?";
}
