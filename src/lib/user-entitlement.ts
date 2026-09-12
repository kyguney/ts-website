import type {
  PurchaseInfo,
  CheckoutRedirectInfo,
  UserRetriever,
} from "@freemius/sdk";
import type { UserFsEntitlement } from "@prisma/client";

import { getFreemius, PRO_PRICING_ID, ULTIMATE_PRICING_ID } from "./freemius";
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

export type UserPlan = "free" | "pro" | "ultimate";

/**
 * Pure plan-resolution logic: map an already-resolved active entitlement to a
 * plan tier. Extracted from {@link getUserPlan} so the mapping (which is the
 * only non-trivial branch) can be unit-tested without touching Prisma/Freemius.
 *
 * Everyone is "free" by default; an Ultimate entitlement unlocks "ultimate",
 * otherwise a Pro entitlement unlocks "pro". Ultimate is checked first so a
 * user holding both entitlements resolves to Ultimate (Req 1.1–1.3).
 *
 * @param entitlement The user's active entitlement, or null if none.
 */
export function resolvePlanFromEntitlement(
  entitlement: Pick<UserFsEntitlement, "fsPricingId"> | null
): UserPlan {
  if (!entitlement) {
    return "free";
  }
  if (entitlement.fsPricingId === ULTIMATE_PRICING_ID) {
    return "ultimate";
  }
  if (entitlement.fsPricingId === PRO_PRICING_ID) {
    return "pro";
  }
  return "free";
}

/**
 * Resolve the current user's plan for feature gating. Delegates the mapping to
 * the pure {@link resolvePlanFromEntitlement} helper after fetching the active
 * entitlement.
 */
export async function getUserPlan(userId: string): Promise<UserPlan> {
  const entitlement = await getUserEntitlement(userId);
  return resolvePlanFromEntitlement(entitlement);
}
