/**
 * Freemius webhook receiver. Keeps local entitlements in sync with license
 * lifecycle events (renewals, cancellations, expirations, plan changes).
 * The SDK verifies the webhook signature (via FREEMIUS_SECRET_KEY) before
 * invoking handlers.
 */
import { getFreemius } from "@/lib/freemius";
import {
  deleteEntitlement,
  syncEntitlementFromWebhook,
} from "@/lib/user-entitlement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Built lazily so the Freemius SDK isn't instantiated during `next build`.
let processor: ((request: Request) => Promise<Response>) | null = null;

function getProcessor() {
  if (!processor) {
    const freemius = getFreemius();
    const listener = freemius.webhook.createListener();

    listener.on(
      [
        "license.created",
        "license.extended",
        "license.shortened",
        "license.updated",
        "license.cancelled",
        "license.expired",
        "license.plan.changed",
      ],
      async ({ objects: { license } }) => {
        if (license && license.id) {
          await syncEntitlementFromWebhook(license.id);
        }
      }
    );

    listener.on("license.deleted", async ({ data }) => {
      await deleteEntitlement(data.license_id);
    });

    processor = freemius.webhook.createRequestProcessor(listener);
  }
  return processor;
}

export async function POST(request: Request) {
  return getProcessor()(request);
}
