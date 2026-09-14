import { NextResponse } from "next/server";
import { getPublicSignals } from "@/lib/landing/public-market";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
// A cold live scan makes several dozen Binance REST calls; give it headroom.
export const maxDuration = 30;

/**
 * Top-3 public "Latest Signals". Resolution order: Redis scanner snapshots →
 * on-demand LIVE Binance scan (same ported engine, no Redis) → sample signals.
 * Read-only and public-safe (no per-user TP/SL ladders).
 */
export async function GET() {
  const signals = await getPublicSignals();
  return NextResponse.json(
    { signals },
    { headers: { "Cache-Control": "public, max-age=30, s-maxage=30" } },
  );
}
