// ---------------------------------------------------------------------------
// GET /api/analysis/feed — tiered AI analysis feed (Phase 6, tier-slice read path).
//
//   The 1m background scanner is now the single source of truth. It writes a
//   per-tier slice for every tracked symbol to Redis (`scan:{tier}:{symbol}:latest`)
//   with the tier's cadence baked in (ultimate=1m, pro=5m, free=15m). This route
//   reads ONLY the caller's tier slice via `readTierSlices` — no per-user
//   recompute of the signal happens here (Req 3.3).
//
//   USD TP1/TP2/SL are the ONLY per-user numbers, and they are computed at read
//   time from the caller's risk profile (`default_leverage`, `default_rr_ratio`)
//   and their tier's demo balance (Req 3.3 / 7.1 / 7.2). The cached slice stays
//   user-agnostic (prices + candidate `atrRatioPct`); the USD amounts are layered
//   on here.
//
//   FREE  — 15m reduced slices (single TP), favorites pinned, plus locked
//           placeholder rows for the Pro-only timeframes with an upgrade CTA.
//   PRO   — 5m full-ladder slices across the tracked universe.
//   ULTIMATE — 1m full-ladder slices; the dashboard renders the 1m timeframe.
//
// --- Symbol-list sourcing decision -----------------------------------------
//   The tier `:latest` pointers are keyed by symbol, so a read needs the symbol
//   list up front. We build it from the SAME source the worker uses to write
//   the slices: `resolveTrackedSymbols()` (top-movers UNION regime symbols)
//   UNION the caller's favorites. We then MGET every tier `:latest` key in one
//   round-trip via `readTierSlices`. This deliberately avoids a Redis `SCAN` on
//   every request (unlike the legacy `readProAnalysesByIntervals` path) and
//   guarantees favorites are included even if they've dropped out of the
//   top-movers universe.
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { getUserPlan, type UserPlan } from "@/lib/user-entitlement";
import { getUserPreferences } from "@/lib/user-preferences";
import { readScanTimes } from "@/lib/market/redis-pipeline";
import { resolveTrackedSymbols } from "@/lib/market/config";
import {
  readTierSlices,
  type FreeTierSlice,
  type FullTierSlice,
} from "@/lib/market/tier-cache";
import { parseRrRatio } from "@/lib/ai/risk";
import { demoBalanceForTier } from "@/lib/ai/balances";
import {
  freeSliceToRow,
  fullSliceToRow,
  type RiskProfile,
} from "@/lib/ai/feed-usd";
import { SELECTABLE_INTERVALS, type SelectableInterval } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The slice interval each tier reads from (Ultimate exposes 1m). */
const TIER_INTERVAL: Record<UserPlan, "1m" | "5m" | "15m"> = {
  ultimate: "1m",
  pro: "5m",
  free: "15m",
};

/**
 * Timeframes shown as locked placeholders to Free users (everything but 15m).
 * Preserves the existing Free "blurred upgrade CTA" behaviour.
 */
const FREE_LOCKED_INTERVALS: SelectableInterval[] = SELECTABLE_INTERVALS.filter(
  (i) => i !== "15m",
);

// The per-user USD envelope + slice→row mapping helpers (RowUsdLevels, FeedRow,
// RiskProfile, usdForSlice, fullSliceToRow, freeSliceToRow) live in
// `@/lib/ai/feed-usd` so they are importable (Next.js route files may only
// export handlers + config fields) and reusable by the E2E acceptance test.

/** Builds the symbol list for a read: tracked universe UNION caller favorites. */
async function resolveFeedSymbols(favoritePairs: string[]): Promise<string[]> {
  let tracked: string[] = [];
  try {
    tracked = await resolveTrackedSymbols();
  } catch {
    // Discovery failure is non-fatal — fall back to favorites only.
    tracked = [];
  }
  const set = new Set<string>();
  for (const s of tracked) set.add(s.toUpperCase());
  for (const s of favoritePairs) set.add(s.toUpperCase());
  return Array.from(set);
}

export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) {
    return NextResponse.json(
      { ok: false, error: "Authentication required." },
      { status: 401 },
    );
  }

  const [plan, prefs] = await Promise.all([
    getUserPlan(userId),
    getUserPreferences(userId),
  ]);

  // Resolve the caller's risk profile once — every row is sized against it.
  const profile: RiskProfile = {
    leverage: prefs.defaultLeverage,
    rrReward: parseRrRatio(prefs.defaultRrRatio),
    rrRatio: prefs.defaultRrRatio,
    balanceUsd: demoBalanceForTier(plan),
  };

  const symbols = await resolveFeedSymbols(prefs.favoritePairs);
  const favoriteSet = new Set(prefs.favoritePairs.map((s) => s.toUpperCase()));

  // --- FREE tier -----------------------------------------------------------
  if (plan === "free") {
    const slices = (await readTierSlices("free", symbols)) as FreeTierSlice[];
    const rows = slices.map((slice) => freeSliceToRow(slice, profile));

    // Favorites pinned first, then by score.
    const sorted = rows.sort((a, b) => {
      const aFav = favoriteSet.has(a.symbol.toUpperCase()) ? 1 : 0;
      const bFav = favoriteSet.has(b.symbol.toUpperCase()) ? 1 : 0;
      if (aFav !== bFav) return bFav - aFav;
      return b.score - a.score;
    });

    const favorites = sorted.filter((r) => favoriteSet.has(r.symbol.toUpperCase()));

    const scanTimes = await readScanTimes();
    return NextResponse.json({
      ok: true,
      plan: "free",
      interval: TIER_INTERVAL.free,
      profile: {
        defaultLeverage: profile.leverage,
        defaultRrRatio: profile.rrRatio,
        balanceUsd: profile.balanceUsd,
      },
      scanTimes,
      favoritePairs: prefs.favoritePairs.slice(0, 3),
      // Favorite rows surfaced separately so the client can pin them first.
      favorites,
      // Locked rows drive the dashboard's blurred upgrade CTA.
      lockedTimeframes: FREE_LOCKED_INTERVALS.map((interval) => ({
        interval,
        locked: true,
        upgradeCta: "Upgrade to Pro to unlock this timeframe.",
      })),
      analyses: sorted,
    });
  }

  // --- PRO / ULTIMATE tiers -----------------------------------------------
  const tierSlices = (await readTierSlices(plan, symbols)) as FullTierSlice[];
  const rows = tierSlices.map((slice) => fullSliceToRow(slice, profile));

  // Pin favorites first (each group by score); non-favorites follow by score.
  const sorted = rows.sort((a, b) => {
    const aFav = favoriteSet.has(a.symbol.toUpperCase()) ? 1 : 0;
    const bFav = favoriteSet.has(b.symbol.toUpperCase()) ? 1 : 0;
    if (aFav !== bFav) return bFav - aFav;
    return b.score - a.score;
  });

  // The single interval this tier reads (5m for Pro, 1m for Ultimate). Kept as
  // an array for backward-compatibility with the previous `activeIntervals`
  // multi-select shape the dashboard consumes.
  const tierInterval = TIER_INTERVAL[plan];

  const scanTimes = await readScanTimes();
  return NextResponse.json({
    ok: true,
    plan,
    interval: tierInterval,
    preferences: {
      intervals: prefs.intervals,
      favoritePairs: prefs.favoritePairs,
    },
    profile: {
      defaultLeverage: profile.leverage,
      defaultRrRatio: profile.rrRatio,
      balanceUsd: profile.balanceUsd,
    },
    // Backward-compat: the dashboard filters rows by `active` interval. The
    // tier's slice interval is the only one served now, so expose it here.
    activeIntervals: [tierInterval],
    scanTimes,
    analyses: sorted,
  });
}
