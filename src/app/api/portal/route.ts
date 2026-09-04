/**
 * Backs the embedded Freemius Customer Portal (subscription management,
 * invoices, billing) rendered inside our dashboard at /dashboard/billing.
 */
import { getFreemius, IS_FREEMIUS_SANDBOX } from "@/lib/freemius";
import { getFsUser, processPurchaseInfo } from "@/lib/user-entitlement";
import { resolveAppUrl } from "@/lib/app-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request: Request): Promise<Response> {
  const endpoint = resolveAppUrl(request) + "/api/portal";
  const freemius = getFreemius();

  const processor = freemius.customerPortal.request.createProcessor({
    getUser: getFsUser,
    portalEndpoint: endpoint,
    isSandbox: IS_FREEMIUS_SANDBOX,
    onRestore: freemius.customerPortal.createRestorer(processPurchaseInfo),
  });

  try {
    const res = await processor(request);
    if (res.status >= 500) {
      let body = "";
      try {
        body = await res.clone().text();
      } catch {
        /* ignore */
      }
      const fsUser = await getFsUser().catch((e) => ({ error: String(e) }));
      console.error("[api/portal] processor 500", {
        sandbox: IS_FREEMIUS_SANDBOX,
        endpoint,
        body,
        fsUser,
      });
    }
    return res;
  } catch (err) {
    console.error("[api/portal] threw:", err);
    const message = err instanceof Error ? err.stack || err.message : String(err);
    return new Response(
      JSON.stringify({ error: message, sandbox: IS_FREEMIUS_SANDBOX, endpoint }),
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
