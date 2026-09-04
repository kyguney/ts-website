import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BrandLogo } from "@/components/brand-logo";
import { SignalDemo } from "./signal-demo";
import { Pricing } from "./pricing";

const FEATURES = [
  {
    title: "Market Scanner",
    desc: "Continuously scans the market for high-probability long and short setups.",
  },
  {
    title: "Regime Detection",
    desc: "Knows whether the market is trending or ranging before you commit.",
  },
  {
    title: "Momentum & Volatility",
    desc: "Flags momentum and volatility spikes the moment they start building.",
  },
  {
    title: "Long / Short Scoring",
    desc: "A single directional conviction score you can act on with clarity.",
  },
];

export function LandingPage({ isAuthed }: { isAuthed: boolean }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Nav */}
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5">
        <BrandLogo height={112} priority />

        <nav className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href="#pricing">Pricing</Link>
          </Button>
          {isAuthed ? (
            <Button asChild size="sm">
              <Link href="/dashboard">Dashboard</Link>
            </Button>
          ) : (
            <>
              <Button asChild variant="ghost" size="sm">
                <Link href="/login">Sign in</Link>
              </Button>
              <Button asChild size="sm">
                <Link href="/register">Get started</Link>
              </Button>
            </>
          )}
        </nav>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-4xl px-4 pb-14 pt-10 text-center sm:pt-16">
        <p className="mb-4 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          AI-Powered Crypto Intelligence
        </p>
        <h1 className="text-balance text-4xl font-bold leading-tight tracking-tight sm:text-6xl">
          Know when to go{" "}
          <span className="bg-gradient-to-r from-emerald-400 to-emerald-600 bg-clip-text text-transparent">
            Long
          </span>{" "}
          or{" "}
          <span className="bg-gradient-to-r from-rose-400 to-rose-600 bg-clip-text text-transparent">
            Short
          </span>
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-pretty text-base text-muted-foreground sm:text-lg">
          TrendScore reads the market with a multi-agent AI engine — scanning
          momentum, detecting regime shifts, and scoring long/short setups across
          the crypto market, so you act with conviction instead of guessing.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <Button asChild size="lg">
            <Link href="/register">Start free</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="#pricing">See pricing</Link>
          </Button>
        </div>
      </section>

      {/* Live demo */}
      <section className="mx-auto max-w-6xl px-4 pb-16">
        <SignalDemo />
      </section>

      {/* Features */}
      <section className="mx-auto max-w-5xl px-4 py-12">
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="rounded-xl border border-white/10 bg-white/[0.03] p-5"
            >
              <h3 className="font-semibold">{f.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <Pricing />

      {/* Footer */}
      <footer className="border-t border-white/10 px-4 py-10 text-center text-sm text-muted-foreground">
        <p>
          Questions or Comments? Reach us at{" "}
          <a
            href="mailto:info@trendscore.io"
            className="text-primary hover:underline"
          >
            info@trendscore.io
          </a>
        </p>
        <p className="mt-2">
          © {new Date().getFullYear()} TrendScore.io — All rights reserved.
        </p>
        <p className="mt-1 text-xs opacity-70">
          Not financial advice. Crypto trading involves substantial risk.
        </p>
      </footer>
    </div>
  );
}
