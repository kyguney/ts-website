"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

const FAQS = [
  {
    q: "What is TrendScore?",
    a: "A platform for crypto trend analytics, market scores, and long/short trading signals powered by a multi-agent AI engine that reads momentum, regime shifts, and volatility across the market.",
  },
  {
    q: "Can I practice without real money?",
    a: "Yes. The Demo tier gives you a virtual portfolio with $1,000 in virtual funds so you can test strategies and track performance risk-free before committing real capital.",
  },
  {
    q: "Do signals guarantee results?",
    a: "No. Signals are probabilistic analytics, not guarantees. Crypto trading involves substantial risk and past results never guarantee future performance. Always trade responsibly.",
  },
  {
    q: "Where can I manage my subscription?",
    a: "Once signed in, head to your account billing page. You can upgrade, downgrade, switch between monthly and annual billing, or cancel at any time through the customer portal.",
  },
];

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="ts-card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
        aria-expanded={open}
      >
        <span className="text-sm font-medium">{q}</span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-[var(--ts-text-muted)] transition-transform duration-300",
            open && "rotate-180 text-[var(--ts-emerald)]",
          )}
        />
      </button>
      <div className="ts-accordion-panel" data-open={open}>
        <div>
          <p className="px-5 pb-4 text-sm text-[var(--ts-text-muted)]">{a}</p>
        </div>
      </div>
    </div>
  );
}

export function FaqSection() {
  return (
    <section id="faq" className="mx-auto w-full max-w-3xl px-4 py-20">
      <h2 className="mb-8 text-3xl font-bold tracking-tight sm:text-4xl">
        Frequently Asked Questions
      </h2>
      <div className="flex flex-col gap-3">
        {FAQS.map((f) => (
          <FaqItem key={f.q} q={f.q} a={f.a} />
        ))}
      </div>
    </section>
  );
}
