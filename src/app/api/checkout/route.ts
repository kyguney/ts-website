/**
 * Handles Freemius checkout purchase + hosted-checkout redirect processing.
 * The SDK verifies signatures and calls our callbacks to sync the license.
 */
import { getFreemius } from "@/lib/freemius";
import { processPurchaseInfo, processRedirect } from "@/lib/user-entitlement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Built lazily so the Freemius SDK isn't instantiated during `next build`
// (secrets are runtime-only). Cached after first request.
let processor: ((request: Request) => Promise<Response>) | null = null;

function getProcessor() {
  if (!processor) {
    processor = getFreemius().checkout.request.createProcessor({
      onPurchase: processPurchaseInfo,
      proxyUrl: process.env.NEXT_PUBLIC_APP_URL!,
      onRedirect: processRedirect,
    });
  }
  return processor;
}

export async function GET(request: Request) {
  return getProcessor()(request);
}

export async function POST(request: Request) {
  return getProcessor()(request);
}
