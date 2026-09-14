import { NextResponse } from "next/server";
import {
  getPublicChart,
  getPublicRegime,
  PUBLIC_INTERVALS,
  type PublicInterval,
} from "@/lib/landing/public-market";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

/**
 * Public hero chart data (BTC/USDT by default) + market regime badge data.
 * Always returns 200 with either live Binance data or a sample fallback.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbol = (searchParams.get("symbol") ?? "BTCUSDT").toUpperCase();
  const rawInterval = searchParams.get("interval") ?? "1h";
  const interval: PublicInterval = (PUBLIC_INTERVALS as readonly string[]).includes(
    rawInterval,
  )
    ? (rawInterval as PublicInterval)
    : "1h";

  const [chart, regime] = await Promise.all([
    getPublicChart(symbol, interval),
    getPublicRegime(),
  ]);

  return NextResponse.json(
    { chart, regime },
    { headers: { "Cache-Control": "public, max-age=15, s-maxage=15" } },
  );
}
