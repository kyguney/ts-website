// ---------------------------------------------------------------------------
// /api/user/preferences — read & update analysis preferences (Phase 3).
//
//   GET   — returns the current user's preferences (any authenticated user).
//   PATCH — updates favorite pairs + risk params (all tiers) and active
//           timeframes (Pro/Ultimate only; Free is blocked with HTTP 403 if it
//           tries to change intervals).
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { getUserPlan } from "@/lib/user-entitlement";
import {
  getUserPreferences,
  upsertUserPreferences,
} from "@/lib/user-preferences";
import { makePreferencesSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json(
      { ok: false, error: "Authentication required." },
      { status: 401 },
    );
  }

  const [plan, preferences] = await Promise.all([
    getUserPlan(userId),
    getUserPreferences(userId),
  ]);

  return NextResponse.json({ ok: true, plan, preferences });
}

export async function PATCH(req: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json(
      { ok: false, error: "Authentication required." },
      { status: 401 },
    );
  }

  const plan = await getUserPlan(userId);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid request body." },
      { status: 400 },
    );
  }

  // Tier-aware validation: Free favorites capped at 3, Pro at 10.
  const parsed = makePreferencesSchema(plan).safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Invalid preferences.",
        // Surface upgrade intent when a Free user exceeds their favorite cap.
        upgradeRequired: plan === "free",
      },
      { status: 400 },
    );
  }

  // Gate: only Pro/Ultimate users can customize timeframes. Free users may
  // still PATCH favorites and risk params — we simply ignore any interval field
  // they send (and 403 only if they explicitly try to change intervals).
  const canCustomizeIntervals = plan === "pro" || plan === "ultimate";
  if (!canCustomizeIntervals && parsed.data.intervals !== undefined) {
    return NextResponse.json(
      {
        ok: false,
        error: "Upgrade to Pro to customize your timeframes.",
        upgradeRequired: true,
      },
      { status: 403 },
    );
  }

  // Read current prefs so we can PATCH only the provided fields.
  const current = await getUserPreferences(userId);

  const nextIntervals =
    canCustomizeIntervals && parsed.data.intervals !== undefined
      ? parsed.data.intervals
      : current.intervals;

  const nextFavorites =
    parsed.data.favoritePairs !== undefined
      ? parsed.data.favoritePairs
      : current.favoritePairs;

  // Risk params are editable for ALL tiers — merge whatever the caller sent.
  const nextLeverage =
    parsed.data.defaultLeverage !== undefined
      ? parsed.data.defaultLeverage
      : current.defaultLeverage;

  const nextRrRatio =
    parsed.data.defaultRrRatio !== undefined
      ? parsed.data.defaultRrRatio
      : current.defaultRrRatio;

  const saved = await upsertUserPreferences(userId, {
    intervals: nextIntervals,
    favoritePairs: nextFavorites,
    defaultLeverage: nextLeverage,
    defaultRrRatio: nextRrRatio,
  });

  return NextResponse.json({
    ok: true,
    preferences: {
      intervals: saved.intervals,
      favoritePairs: saved.favoritePairs,
      defaultLeverage: saved.defaultLeverage,
      defaultRrRatio: saved.defaultRrRatio,
      updatedAt: saved.updatedAt,
    },
  });
}
