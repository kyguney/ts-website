import type {
  PurchaseInfo,
  CheckoutRedirectInfo,
  UserRetriever,
} from "@freemius/sdk";
import type { UserFsEntitlement } from "@prisma/client";

import { getFreemius, PRO_PRICING_ID } from "./freemius";
import { prisma } from "./prisma";
import { auth } from "@/auth";

/**
 * Process a Freemius purchase and upsert the local entitlement record.
 * Called on checkout success, redirect, and webhook sync.
 */
export async function processPurchaseInfo(
  fsPurchase: PurchaseInfo
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { email: fsPurchase.email.toLowerCase() },
  });

  // If the buyer isn't a registered app user yet, we skip. (They register
  // free first; matching is by email.)
  if (!user) return;

  await prisma.userFsEntitlement.upsert({
    where: { fsLicenseId: fsPurchase.licenseId },
    update: fsPurchase.toEntitlementRecord(),
    create: fsPurchase.toEntitlementRecord({ userId: user.id }),
  });
}

/**
 * Get the user's active entitlement (validated by the SDK: not expired,
 * not canceled). Returns null if the user has no active entitlement.
 */
export async function getUserEntitlement(
  userId: string
): Promise<UserFsEntitlement | null> {
  const entitlements = await prisma.userFsEntitlement.findMany({
    where: { userId, type: "subscription" },
  });
  return getFreemius().entitlement.getActive(entitlements);
}

/** Freemius user retriever, backed by the NextAuth session. */
export const getFsUser: UserRetriever = async () => {
  const session = await auth();
  const userId = session?.user?.id;
  const entitlement = userId ? await getUserEntitlement(userId) : null;
  const email = session?.user?.email ?? undefined;
  return getFreemius().entitlement.getFsUser(entitlement, email);
};

/** Process a hosted-checkout redirect back into our database. */
export async function processRedirect(
  info: CheckoutRedirectInfo
): Promise<void> {
  const purchaseInfo = await getFreemius().purchase.retrievePurchase(
    info.license_id
  );
  if (purchaseInfo) {
    await processPurchaseInfo(purchaseInfo);
  }
}

/** Webhook: re-fetch the license from Freemius and sync it locally. */
export async function syncEntitlementFromWebhook(
  fsLicenseId: string
): Promise<void> {
  const purchaseInfo = await getFreemius().purchase.retrievePurchase(fsLicenseId);
  if (purchaseInfo) {
    await processPurchaseInfo(purchaseInfo);
  }
}

/** Webhook: license.deleted — remove the local record. */
export async function deleteEntitlement(fsLicenseId: string): Promise<void> {
  await prisma.userFsEntitlement
    .delete({ where: { fsLicenseId } })
    .catch(() => {
      // Already absent — nothing to do.
    });
}

export type UserPlan = "free" | "pro";

/**
 * Resolve the current user's plan for feature gating.
 * Everyone is "free" by default; an active Pro entitlement unlocks "pro".
 */
export async function getUserPlan(userId: string): Promise<UserPlan> {
  const entitlement = await getUserEntitlement(userId);
  if (entitlement && entitlement.fsPricingId === PRO_PRICING_ID) {
    return "pro";
  }
  return "free";
}
