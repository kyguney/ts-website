// ---------------------------------------------------------------------------
// GET /api/analysis/feed — tiered AI analysis feed (Phase 3).
//
//   FREE users: receive ONLY the shared 15m broadcast payload
//     (analysis:broadcast:free:15m), plus locked placeholder rows for the
//     Pro-only timeframes with an upgrade CTA. Zero on-demand LLM calls.
//
//   PRO users: receive the active AI analyses matching their selected
//     timeframes (from their UserPreference), read from Redis.
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { getUserPlan } from "@/lib/user-entitlement";
import { getUserPreferences } from "@/lib/user-preferences";
import {
  readFreeBroadcast,
  readProAnalysesByIntervals,
  type StoredAnalysis,
} from "@/lib/ai/store";
import { readSnapshot, readScanTimes } from "@/lib/market/redis-pipeline";
import { INTERVALS, type Interval } from "@/lib/market/types";
import { SELECTABLE_INTERVALS } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Timeframes shown as locked placeholders to Free users (everything but 15m). */
const FREE_LOCKED_INTERVALS = SELECTABLE_INTERVALS.filter((i) => i !== "15m");

/**
 * Builds a lightweight StoredAnalysis-shaped row from a live snapshot for a
 * favorited symbol (Free tier). Free favorites are scanned but don't get an AI
 * pass, so we synthesize a minimal deterministic `ai` block from the candidate
 * so the table/drawer render consistently.
 */
async function favoriteRowFromSnapshot(
  symbol: string,
  interval: Interval,
): Promise<StoredAnalysis | null> {
  const snap = await readSnapshot(symbol, interval);
  if (!snap) return null;
  const c = snap.candidate;
  const price = snap.indicators.price;
  // Prefer the scored candidate; otherwise emit a neutral placeholder row.
  const direction = c?.direction ?? "LONG";
  return {
    symbol,
    interval,
    direction,
    pattern: c?.patternType ?? "Watching",
    score: c?.score ?? 0,
    price,
    ai: {
      sentiment:
        direction === "LONG" ? "BULLISH" : direction === "SHORT" ? "BEARISH" : "NEUTRAL",
      summary: c
        ? `${symbol} ${interval}: ${c.patternType} (${c.statusLabel}). Favorite — upgrade to Pro for full AI entry/SL/TP.`
        : `${symbol} ${interval}: no qualifying setup right now. Tracked as a favorite.`,
      entryRange: [price, price],
      stopLoss: price,
      takeProfitLevels: [price],
      riskLevel: "MEDIUM",
      keyFactors: ["Favorite"],
    },
    riskRewardRatio: "n/a",
    source: "fallback",
    model: "favorite-watch",
    generatedAt: snap.updatedAt,
  };
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

  const plan = await getUserPlan(userId);

  // --- FREE tier -----------------------------------------------------------
  if (plan === "free") {
    const [broadcast, prefs] = await Promise.all([
      readFreeBroadcast(),
      getUserPreferences(userId),
    ]);

    // Free favorites (max 3, enforced at the API): scanned on 15m and pinned
    // to the TOP of the list, ahead of the shared broadcast picks.
    const favoritePairs = prefs.favoritePairs.slice(0, 3);
    const favoriteRows: StoredAnalysis[] = [];
    for (const symbol of favoritePairs) {
      const row = await favoriteRowFromSnapshot(symbol, "15m");
      if (row) favoriteRows.push(row);
    }
    // Highest-scoring favorite first.
    favoriteRows.sort((a, b) => b.score - a.score);

    const scanTimes = await readScanTimes();
    return NextResponse.json({
      ok: true,
      plan: "free",
      broadcast, // may be null if not generated yet (worker warming up)
      scanTimes,
      favoritePairs,
      // Favorite rows are surfaced separately so the client can pin them first.
      favorites: favoriteRows,
      // Locked rows drive the dashboard's blurred upgrade CTA.
      lockedTimeframes: FREE_LOCKED_INTERVALS.map((interval) => ({
        interval,
        locked: true,
        upgradeCta: "Upgrade to Pro to unlock this timeframe.",
      })),
      analyses: [], // Free users get no per-symbol Pro analyses.
    });
  }

  // --- PRO tier ------------------------------------------------------------
  const prefs = await getUserPreferences(userId);

  // Intersect the user's selected intervals with those the engine actually
  // produces. The worker now streams all four supported timeframes
  // (5m/15m/30m/1h), so Pro users can fully consume 30m live feeds. Any
  // future picks outside the engine set are still surfaced separately so the
  // UI can indicate "coming soon" rather than silently dropping them.
  const engineIntervals = new Set<Interval>(INTERVALS);
  const activeIntervals = prefs.intervals.filter((i): i is Interval =>
    engineIntervals.has(i as Interval),
  );
  const unavailableIntervals = prefs.intervals.filter(
    (i) => !engineIntervals.has(i as Interval),
  );

  // Pro sees the FULL top-movers universe across ALL engine timeframes — the
  // client filters to the selected pill locally, so switching timeframes is
  // instant and never races the preference PATCH. Favorites are pinned to the
  // top instead of narrowing the list.
  const analyses = await readProAnalysesByIntervals([...INTERVALS]);

  // Pin favorites first (favorites capped at 10, enforced at the API), each
  // group sorted by score; non-favorites follow, sorted by score.
  const favoriteSet = new Set(prefs.favoritePairs.map((s) => s.toUpperCase()));
  const sorted = [...analyses].sort((a, b) => {
    const aFav = favoriteSet.has(a.symbol.toUpperCase()) ? 1 : 0;
    const bFav = favoriteSet.has(b.symbol.toUpperCase()) ? 1 : 0;
    if (aFav !== bFav) return bFav - aFav; // favorites first
    return b.score - a.score; // then by score
  });

  const scanTimes = await readScanTimes();
  return NextResponse.json({
    ok: true,
    plan: "pro",
    preferences: {
      intervals: prefs.intervals,
      favoritePairs: prefs.favoritePairs,
    },
    activeIntervals,
    unavailableIntervals,
    scanTimes,
    analyses: sorted,
  });
}
