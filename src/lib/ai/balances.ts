// ---------------------------------------------------------------------------
// Tier demo balances (Req 7.5).
//
// USD TP/SL amounts are sized against a per-tier "demo balance" that acts as
// the position-sizing base. The balances themselves are defined by a prior
// issue and merely consumed here (Free $1k / Pro $10k / Ultimate $100k).
//
// The lookup is intentionally hidden behind a small pluggable interface so a
// future real-balance integration (e.g. reading the user's actual exchange
// balance) can replace the demo source without touching call sites.
// ---------------------------------------------------------------------------

import type { UserPlan } from "@/lib/user-entitlement";

/**
 * Resolves the position-sizing balance (in USD) for a user. Implementations
 * may be synchronous (demo, config-driven) — callers should treat the return
 * value as the notional base before leverage is applied.
 */
export interface BalanceProvider {
  /** Returns the USD balance used as the position-sizing base for a tier. */
  balanceForTier(tier: UserPlan): number;
}

/**
 * The demo balances defined by the prior issue, keyed by tier. Exported so
 * tests (and the E2E recompute) can reason about the exact sizing base.
 */
export const DEMO_TIER_BALANCE_USD: Record<UserPlan, number> = {
  free: 1_000,
  pro: 10_000,
  ultimate: 100_000,
};

/** The default, demo-backed balance provider. */
export const demoBalanceProvider: BalanceProvider = {
  balanceForTier(tier: UserPlan): number {
    return DEMO_TIER_BALANCE_USD[tier];
  },
};

/**
 * The active balance provider. Swap this out (or inject a different provider
 * via {@link demoBalanceForTier}) to plug in real balances later.
 */
let activeProvider: BalanceProvider = demoBalanceProvider;

/** Overrides the active balance provider (e.g. a future real-balance source). */
export function setBalanceProvider(provider: BalanceProvider): void {
  activeProvider = provider;
}

/**
 * Returns the USD demo balance for a tier via the active provider. This is the
 * primary call site used by the risk math / read path.
 */
export function demoBalanceForTier(
  tier: UserPlan,
  provider: BalanceProvider = activeProvider,
): number {
  return provider.balanceForTier(tier);
}
