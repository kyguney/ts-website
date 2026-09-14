import { NextResponse } from "next/server";
import { getPublicTickers } from "@/lib/landing/public-market";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

/** Public ticker bar data (BTC/ETH/SOL/BNB) with mini sparklines + scores. */
export async function GET() {
  const tickers = await getPublicTickers();
  return NextResponse.json(
    { tickers },
    { headers: { "Cache-Control": "public, max-age=15, s-maxage=15" } },
  );
}
