import { type CheckoutSerialized } from "@freemius/sdk";
import AppCheckoutProvider from "@/components/app-checkout-provider";
import {
  getFreemius,
  IS_FREEMIUS_SANDBOX,
  PRO_PRICING_ID,
  ULTIMATE_PRICING_ID,
} from "@/lib/freemius";
import { PricingSection, type PricingPlan } from "./pricing-section";

/**
 * The public landing pricing tiers, aligned to the real Freemius catalog:
 *   • Free      (plan 64048)  — free tier, links to register.
 *   • Pro       (plan 64049)  — $14.95/mo · $149.95/yr — FEATURED/recommended.
 *   • Ultimate  (plan 67357)  — $29.95/mo · $299.95/yr.
 *
 * Plan IDs are the Freemius PLAN ids (from the Plans table). Pricing IDs are
 * the per-cycle pricing ids used to gate access. Both fall back to the known
 * catalog values but can be overridden via env for staging/other stores.
 */
const FREEMIUS_PRO_PLAN_ID = process.env.NEXT_PUBLIC_FREEMIUS_PRO_PLAN_ID ?? "64049";
const FREEMIUS_ULTIMATE_PLAN_ID =
  process.env.NEXT_PUBLIC_FREEMIUS_ULTIMATE_PLAN_ID ?? "67357";

const PLANS: PricingPlan[] = [
  {
    key: "free",
    name: "Free",
    tagline: "Free demo — practice with virtual funds.",
    monthly: null,
    annual: null,
    features: [
      "Virtual portfolio",
      "Sample analytics",
      "Delayed 15m signals",
      "Community access",
    ],
    cta: "Try Demo",
  },
  {
    key: "pro",
    name: "Pro",
    tagline: "Real-time signals, trend analytics & market scores.",
    monthly: 14.95,
    annual: 149.95,
    featured: true,
    features: [
      "Real-time 5m long/short signals",
      "Trend analytics & signal access",
      "Market regime detection",
      "Momentum & volatility alerts",
      "Priority support",
    ],
    cta: "Get Pro",
    planId: FREEMIUS_PRO_PLAN_ID,
    pricingIdMonthly: PRO_PRICING_ID,
    pricingIdAnnual:
      process.env.NEXT_PUBLIC_FREEMIUS_PRO_PRICING_ID_ANNUAL ?? PRO_PRICING_ID,
  },
  {
    key: "ultimate",
    name: "Ultimate",
    tagline: "Advanced filters, expanded analytics & fastest cadence.",
    monthly: 29.95,
    annual: 299.95,
    features: [
      "Fastest 1m signal cadence",
      "Everything in Pro",
      "Advanced filters & expanded analytics",
      "Full TP ladder on every signal",
      "USD-denominated TP/SL",
    ],
    cta: "Get Ultimate",
    planId: FREEMIUS_ULTIMATE_PLAN_ID,
    pricingIdMonthly: ULTIMATE_PRICING_ID,
    pricingIdAnnual:
      process.env.NEXT_PUBLIC_FREEMIUS_ULTIMATE_PRICING_ID_ANNUAL ??
      ULTIMATE_PRICING_ID,
  },
];

export async function Pricing() {
  // Build an anonymous Freemius checkout for public visitors. If the Freemius
  // secrets aren't configured (e.g. local dev / preview), degrade gracefully:
  // render the same pricing UI with CTAs that route to /register.
  let serialized: CheckoutSerialized | null = null;

  try {
    const checkout = await getFreemius().checkout.create({
      isSandbox: IS_FREEMIUS_SANDBOX,
    });
    serialized = checkout.serialize();
  } catch {
    serialized = null;
  }

  if (!serialized) {
    return <PricingSection plans={PLANS} checkoutEnabled={false} />;
  }

  return (
    <AppCheckoutProvider checkout={serialized}>
      <PricingSection plans={PLANS} checkoutEnabled />
    </AppCheckoutProvider>
  );
}
