/**
 * Backs the embedded Freemius Customer Portal (subscription management,
 * invoices, billing) rendered inside our dashboard at /dashboard/billing.
 */
import { getFreemius, IS_FREEMIUS_SANDBOX } from "@/lib/freemius";
import {
  getFsUser,
  processPurchaseInfo,
} from "@/lib/user-entitlement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PORTAL_ENDPOINT = () => process.env.NEXT_PUBLIC_APP_URL! + "/api/portal";

let processor: ((request: Request) => Promise<Response>) | null = null;

function getProcessor() {
  if (!processor) {
    const freemius = getFreemius();
    processor = freemius.customerPortal.request.createProcessor({
      getUser: getFsUser,
      portalEndpoint: PORTAL_ENDPOINT(),
      isSandbox: IS_FREEMIUS_SANDBOX,
      onRestore: freemius.customerPortal.createRestorer(processPurchaseInfo),
    });
  }
  return processor;
}

async function handle(request: Request): Promise<Response> {
  try {
    const res = await getProcessor()(request);

    // The SDK's processor returns a 500 Response (rather than throwing) when
    // the underlying Freemius call fails. Detect that and log details so we
    // can see the real cause in the server logs.
    if (res.status >= 500) {
      let body = "";
      try {
        body = await res.clone().text();
      } catch {
        /* ignore */
      }
      const fsUser = await getFsUser().catch((e) => ({ error: String(e) }));
      console.error("[api/portal] processor returned", res.status, {
        sandbox: IS_FREEMIUS_SANDBOX,
        endpoint: PORTAL_ENDPOINT(),
        body,
        fsUser,
      });
    }
    return res;
  } catch (err) {
    console.error("[api/portal] threw:", err);
    const message = err instanceof Error ? err.stack || err.message : String(err);
    return new Response(
      JSON.stringify({ error: message, sandbox: IS_FREEMIUS_SANDBOX }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
