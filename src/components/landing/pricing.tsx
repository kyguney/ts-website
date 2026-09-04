import Link from "next/link";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const PLANS = [
  {
    name: "Free",
    price: "$0",
    cadence: "forever",
    description: "Get started with core signals.",
    features: [
      "Delayed long/short signals",
      "Top 5 majors coverage",
      "Daily market regime summary",
      "Community access",
    ],
    cta: "Start free",
    href: "/register",
    highlighted: false,
  },
  {
    name: "Pro",
    price: "$29",
    cadence: "per month",
    description: "Real-time edge across the full market.",
    features: [
      "Real-time long/short signals",
      "Full market scanner (all symbols)",
      "Momentum & volatility spike alerts",
      "Advanced regime detection",
      "Priority support",
    ],
    cta: "Get Pro",
    href: "/register",
    highlighted: true,
  },
];

export function Pricing() {
  return (
    <section id="pricing" className="mx-auto w-full max-w-4xl px-4 py-20">
      <div className="mb-10 text-center">
        <h2 className="text-3xl font-bold tracking-tight">Simple pricing</h2>
        <p className="mt-2 text-muted-foreground">
          Start free. Upgrade to Pro when you want the real-time edge.
        </p>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        {PLANS.map((plan) => (
          <div
            key={plan.name}
            className={cn(
              "relative flex flex-col rounded-2xl border p-6",
              plan.highlighted
                ? "border-primary/50 bg-primary/5 shadow-lg shadow-primary/10"
                : "border-white/10 bg-white/[0.03]"
            )}
          >
            {plan.highlighted && (
              <span className="absolute -top-3 left-6 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground">
                Most popular
              </span>
            )}
            <h3 className="text-lg font-semibold">{plan.name}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{plan.description}</p>
            <div className="mt-4 flex items-baseline gap-1">
              <span className="text-4xl font-bold">{plan.price}</span>
              <span className="text-sm text-muted-foreground">/ {plan.cadence}</span>
            </div>
            <ul className="mt-6 flex flex-col gap-3 text-sm">
              {plan.features.map((f) => (
                <li key={f} className="flex items-start gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
            <div className="mt-8">
              <Button
                asChild
                className="w-full"
                variant={plan.highlighted ? "default" : "outline"}
              >
                <Link href={plan.href}>{plan.cta}</Link>
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
