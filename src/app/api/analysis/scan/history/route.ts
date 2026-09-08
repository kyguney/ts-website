// ---------------------------------------------------------------------------
// GET /api/analysis/scan/history — the user's saved manual-scan results (Pro).
//
// Manual scans are persisted to a per-user Redis list so the user can hold and
// review past scans later. Free users don't run manual scans, so this returns
// an empty list for them.
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { getUserPlan } from "@/lib/user-entitlement";
import { readScanHistory } from "@/lib/market/redis-pipeline";

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

  const plan = await getUserPlan(userId);
  if (plan !== "pro") {
    return NextResponse.json({ ok: true, plan, history: [] });
  }

  const history = await readScanHistory(userId);
  return NextResponse.json({ ok: true, plan: "pro", history });
}
