// ---------------------------------------------------------------------------
// /api/user/preferences — read & update analysis preferences (Phase 3).
//
//   GET   — returns the current user's preferences (any authenticated user).
//   PATCH — updates active timeframes / favorite pairs. PRO ONLY: Free users
//           are blocked with HTTP 403 (upgrade required).
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

  // Gate: only Pro users can customize timeframes. Free users may still PATCH
  // their favorites — we simply ignore any interval field they send (and 403
  // only if they explicitly try to change intervals).
  if (plan !== "pro" && parsed.data.intervals !== undefined) {
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
    plan === "pro" && parsed.data.intervals !== undefined
      ? parsed.data.intervals
      : current.intervals;

  const nextFavorites =
    parsed.data.favoritePairs !== undefined
      ? parsed.data.favoritePairs
      : current.favoritePairs;

  const saved = await upsertUserPreferences(userId, {
    intervals: nextIntervals,
    favoritePairs: nextFavorites,
  });

  return NextResponse.json({
    ok: true,
    preferences: {
      intervals: saved.intervals,
      favoritePairs: saved.favoritePairs,
      updatedAt: saved.updatedAt,
    },
  });
}
