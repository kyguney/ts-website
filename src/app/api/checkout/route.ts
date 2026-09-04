/**
 * Handles Freemius checkout purchase + hosted-checkout redirect processing.
 * The SDK verifies signatures and calls our callbacks to sync the license.
 */
import { getFreemius } from "@/lib/freemius";
import { processPurchaseInfo, processRedirect } from "@/lib/user-entitlement";
import { resolveAppUrl } from "@/lib/app-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function handler(request: Request) {
  const processor = getFreemius().checkout.request.createProcessor({
    onPurchase: processPurchaseInfo,
    proxyUrl: resolveAppUrl(request),
    onRedirect: processRedirect,
  });
  return processor(request);
}

export async function GET(request: Request) {
  return handler(request);
}

export async function POST(request: Request) {
  return handler(request);
}
