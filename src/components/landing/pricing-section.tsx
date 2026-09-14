"use client";

import * as React from "react";
import Link from "next/link";
import { Check, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useCheckout } from "@/react-starter/hooks/checkout";

type BillingCycle = "monthly" | "annual";

export interface PricingPlan {
  key: "free" | "pro" | "ultimate";
  name: string;
  tagline: string;
  /** Monthly price in dollars (null = free). */
  monthly: number | null;
  /** Annual (per-year) price in dollars (null = free / not offered). */
  annual: number | null;
  features: string[];
  cta: string;
  featured?: boolean;
  /** Freemius plan + pricing IDs (absent for the free tier). */
  planId?: string;
  pricingIdMonthly?: string;
  pricingIdAnnual?: string;
}

/** Formats a price that may carry cents (e.g. 14.95 → "$14.95", 15 → "$15"). */
function fmt(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/** Big headline price for the current billing cycle. */
function priceLabel(plan: PricingPlan, cycle: BillingCycle): string {
  if (plan.monthly === null) return "Free";
  if (cycle === "annual" && plan.annual !== null) {
    // Show the effective monthly cost when billed annually.
    return fmt(Math.round((plan.annual / 12) * 100) / 100);
  }
  return fmt(plan.monthly);
}

/** Percent saved by paying annually vs 12× monthly (0 if not applicable). */
function annualSavingsPct(plan: PricingPlan): number {
  if (plan.monthly === null || plan.annual === null || plan.monthly === 0) {
    return 0;
  }
  const yearlyIfMonthly = plan.monthly * 12;
  return Math.round((1 - plan.annual / yearlyIfMonthly) * 100);
}

/** Max annual savings across paid plans — drives the toggle badge. */
function maxAnnualSavings(plans: PricingPlan[]): number {
  return plans.reduce((max, p) => Math.max(max, annualSavingsPct(p)), 0);
}

/** The interactive checkout button — only rendered when Freemius is available. */
function CheckoutButton({
  plan,
  cycle,
  className,
}: {
  plan: PricingPlan;
  cycle: BillingCycle;
  className?: string;
}) {
  const checkout = useCheckout();
  const pricingId =
    cycle === "annual" ? plan.pricingIdAnnual : plan.pricingIdMonthly;

  return (
    <Button
      type="button"
      className={className}
      variant={plan.featured ? "default" : "outline"}
      onClick={() =>
        checkout.open({
          plan_id: plan.planId,
          pricing_id: pricingId,
          billing_cycle: cycle === "annual" ? "annual" : "monthly",
        })
      }
    >
      {plan.cta}
    </Button>
  );
}

export function PricingSection({
  plans,
  checkoutEnabled,
}: {
  plans: PricingPlan[];
  /** When false (Freemius not configured), CTAs link to /register instead. */
  checkoutEnabled: boolean;
}) {
  const [cycle, setCycle] = React.useState<BillingCycle>("monthly");
  const savings = maxAnnualSavings(plans);

  return (
    <section id="pricing" className="mx-auto w-full max-w-6xl px-4 py-20">
      <div className="mb-8 text-center">
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Choose your plan
        </h2>
        <p className="mt-2 text-[var(--ts-text-muted)]">
          Explore the platform. Upgrade when you need more.
        </p>
      </div>

      {/* Billing frequency switcher */}
      <div className="mb-10 flex justify-center">
        <div className="inline-flex items-center rounded-full border border-[var(--ts-stroke)] bg-white/[0.03] p-1 text-sm">
          <button
            type="button"
            onClick={() => setCycle("monthly")}
            className={cn(
              "rounded-full px-4 py-1.5 font-medium transition-colors",
              cycle === "monthly"
                ? "bg-white/10 text-[var(--ts-text)]"
                : "text-[var(--ts-text-muted)] hover:text-[var(--ts-text)]",
            )}
            aria-pressed={cycle === "monthly"}
          >
            Monthly
          </button>
          <button
            type="button"
            onClick={() => setCycle("annual")}
            className={cn(
              "flex items-center gap-2 rounded-full px-4 py-1.5 font-medium transition-colors",
              cycle === "annual"
                ? "bg-white/10 text-[var(--ts-text)]"
                : "text-[var(--ts-text-muted)] hover:text-[var(--ts-text)]",
            )}
            aria-pressed={cycle === "annual"}
          >
            Annual
            {savings > 0 && (
              <span className="rounded-full bg-[var(--ts-emerald)]/20 px-2 py-0.5 text-[10px] font-bold text-[var(--ts-emerald)]">
                Save {savings}%
              </span>
            )}
          </button>
        </div>
      </div>

      <div className="grid items-stretch gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {plans.map((plan) => (
          <div
            key={plan.key}
            className={cn(
              "relative flex flex-col rounded-2xl p-6",
              plan.featured ? "ts-card ts-card--featured" : "ts-card",
            )}
          >
            {plan.featured && (
              <span className="absolute -top-3 left-1/2 -translate-x-1/2 inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-[var(--ts-emerald)] to-[var(--ts-cyan)] px-3 py-1 text-xs font-bold text-[#052015]">
                <Sparkles className="size-3" />
                Recommended
              </span>
            )}

            <h3 className="text-lg font-semibold">{plan.name}</h3>
            <p className="mt-1 text-sm text-[var(--ts-text-muted)]">{plan.tagline}</p>

            <div className="mt-4 flex items-baseline gap-1">
              <span className="text-4xl font-bold tabular-nums">
                {priceLabel(plan, cycle)}
              </span>
              {plan.monthly !== null && (
                <span className="text-sm text-[var(--ts-text-muted)]">/ mo</span>
              )}
            </div>
            {plan.monthly !== null && cycle === "annual" && plan.annual !== null && (
              <p className="mt-1 text-xs text-[var(--ts-emerald)]">
                {fmt(plan.annual)} billed annually
                {annualSavingsPct(plan) > 0 && ` · save ${annualSavingsPct(plan)}%`}
              </p>
            )}

            <ul className="mt-6 flex flex-col gap-3 text-sm">
              {plan.features.map((f) => (
                <li key={f} className="flex items-start gap-2">
                  <span
                    className={cn(
                      "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full",
                      plan.featured
                        ? "bg-[var(--ts-emerald)]/20 text-[var(--ts-emerald)]"
                        : "bg-white/10 text-[var(--ts-cyan-2)]",
                    )}
                  >
                    <Check className="size-3" strokeWidth={3} />
                  </span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>

            <div className="mt-8">
              {/* Free/demo tier or Freemius unavailable → link to register. */}
              {!checkoutEnabled || !plan.planId ? (
                <Button
                  asChild
                  className={cn("w-full", plan.featured && "ts-cta")}
                  variant={plan.featured ? "default" : "outline"}
                >
                  <Link href="/register">{plan.cta}</Link>
                </Button>
              ) : (
                <CheckoutButton
                  plan={plan}
                  cycle={cycle}
                  className={cn("w-full", plan.featured && "ts-cta")}
                />
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
