/**
 * Backs the embedded Freemius Customer Portal (subscription management,
 * invoices, billing) rendered inside our dashboard at /dashboard/billing.
 */
import { getFreemius } from "@/lib/freemius";
import { getFsUser, processPurchaseInfo } from "@/lib/user-entitlement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Built lazily so the Freemius SDK isn't instantiated during `next build`.
let processor: ((request: Request) => Promise<Response>) | null = null;

function getProcessor() {
  if (!processor) {
    const freemius = getFreemius();
    processor = freemius.customerPortal.request.createProcessor({
      getUser: getFsUser,
      portalEndpoint: process.env.NEXT_PUBLIC_APP_URL! + "/api/portal",
      isSandbox: process.env.NODE_ENV !== "production",
      onRestore: freemius.customerPortal.createRestorer(processPurchaseInfo),
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
