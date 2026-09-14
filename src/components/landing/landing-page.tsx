import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BrandLogo } from "@/components/brand-logo";
import { FacetsBackground } from "./facets-background";
import { HeroChart } from "./hero-chart";
import { TickerBar } from "./ticker-bar";
import { SignalsList } from "./signals-list";
import { DemoPortfolioCard } from "./demo-portfolio-card";
import { Pricing } from "./pricing";
import { FaqSection } from "./faq-section";
import { SiteFooter } from "./site-footer";

const DEMO_BULLETS = [
  "Start with $1,000 in virtual funds",
  "Follow live signals and track your demo performance",
  "No real money required — risk-free practice",
];

export function LandingPage({ isAuthed }: { isAuthed: boolean }) {
  return (
    <div className="ts-landing min-h-screen">
      {/* Decorative crystalline facet shards behind all content. */}
      <FacetsBackground />

      {/* Nav */}
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5">
        <BrandLogo height={102} priority />

        <nav className="flex items-center gap-1 sm:gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href="#markets">Markets</Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href="#signals">Signals</Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href="#pricing">Pricing</Link>
          </Button>
          {isAuthed ? (
            <Button asChild size="sm" className="ts-cta">
              <Link href="/dashboard">Dashboard</Link>
            </Button>
          ) : (
            <>
              <Button asChild variant="ghost" size="sm">
                <Link href="/login">Log In</Link>
              </Button>
              <Button asChild size="sm" className="ts-cta">
                <Link href="/register">Start Free Demo</Link>
              </Button>
            </>
          )}
        </nav>
      </header>

      {/* Hero: copy (left) + live chart preview (right) */}
      <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 pb-8 pt-8 lg:grid-cols-2 lg:pt-14">
        <div>
          <p className="mb-4 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ts-cyan-2)]">
            Crypto Market Intelligence
          </p>
          <h1 className="text-balance text-4xl font-bold leading-[1.05] tracking-tight sm:text-6xl">
            Trade Smarter.
            <br />
            <span className="ts-grad-text">Score Higher.</span>
          </h1>
          <p className="mt-5 max-w-md text-pretty text-base text-[var(--ts-text-muted)] sm:text-lg">
            Crypto market trends, scores, and LONG / SHORT signals in one clear
            view. Read momentum, detect regime shifts, and act with conviction.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button asChild size="lg" className="ts-cta">
              <Link href="/register">
                Start Free Demo <ArrowRight className="ml-1 size-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="#markets">Membership Options</Link>
            </Button>
          </div>
          <p className="mt-3 text-xs text-[var(--ts-text-muted)]">
            Practice with virtual funds.
          </p>
        </div>

        <div className="w-full">
          <HeroChart />
        </div>
      </section>

      {/* Ticker bar */}
      <section id="markets" className="mx-auto max-w-6xl px-4 pb-16 pt-4">
        <TickerBar />
      </section>

      {/*
        NOTE: The large "Market Overview" data table section has been removed
        intentionally — this space is reserved for future modules (Leaderboard /
        Testimonials). Section spacing is preserved by the flow below.
      */}

      {/* Latest Signals */}
      <section id="signals" className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-8 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
              Latest Signals
            </h2>
            <p className="mt-2 text-[var(--ts-text-muted)]">
              Direction, context and timing in one view.
            </p>
          </div>
          <Button asChild variant="ghost" size="sm">
            <Link href="/register">
              View All Signals <ArrowRight className="ml-1 size-4" />
            </Link>
          </Button>
        </div>
        <SignalsList />
      </section>

      {/* Demo showcase */}
      <section id="demo" className="mx-auto max-w-6xl px-4 py-16">
        <div className="grid items-center gap-10 lg:grid-cols-2">
          <div>
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
              Test your strategy.
              <br />
              Use virtual funds.
            </h2>
            <ul className="mt-6 flex flex-col gap-3 text-sm">
              {DEMO_BULLETS.map((b) => (
                <li key={b} className="flex items-start gap-2">
                  <span className="mt-1 size-1.5 shrink-0 rounded-full bg-[var(--ts-emerald)]" />
                  <span className="text-[var(--ts-text-muted)]">{b}</span>
                </li>
              ))}
            </ul>
            <div className="mt-8">
              <Button asChild size="lg" className="ts-cta">
                <Link href="/register">
                  Start Free Demo <ArrowRight className="ml-1 size-4" />
                </Link>
              </Button>
            </div>
          </div>
          <DemoPortfolioCard />
        </div>
      </section>

      {/* Pricing */}
      <Pricing />

      {/* FAQ */}
      <FaqSection />

      {/* Footer */}
      <SiteFooter />
    </div>
  );
}
