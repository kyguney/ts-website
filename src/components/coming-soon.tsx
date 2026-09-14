import Image from "next/image";
import WaitlistForm from "@/components/WaitlistForm";
import { BrandLogo } from "@/components/brand-logo";
import { FacetsBackground } from "@/components/landing/facets-background";

const FEATURES = [
  {
    icon: "📡",
    title: "Market Scanner",
    desc: "Continuous multi-symbol scanning for high-probability setups.",
  },
  {
    icon: "🧭",
    title: "Regime Detection",
    desc: "Identifies trending vs. ranging conditions before you enter.",
  },
  {
    icon: "⚡",
    title: "Momentum & Volatility",
    desc: "Spots spikes and shifts the moment they start building.",
  },
  {
    icon: "🎯",
    title: "Long / Short Scoring",
    desc: "A single directional score you can act on with clarity.",
  },
];

export default function ComingSoon() {
  return (
    <div className="ts-landing relative flex min-h-screen flex-col overflow-hidden">
      {/* Decorative crystalline facet shards behind content. */}
      <FacetsBackground />

      {/* Crystalline bull accent, bottom-right. */}
      <Image
        src="/footer-bg-transparent.webp"
        alt=""
        aria-hidden
        width={2400}
        height={1601}
        unoptimized
        className="pointer-events-none absolute bottom-0 right-0 z-0 h-auto w-[80%] max-w-[760px] select-none object-contain object-right-bottom opacity-20 sm:w-[56%] sm:opacity-25 lg:w-[46%]"
      />

      {/* Nav */}
      <header className="relative z-10 mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-5">
        <BrandLogo href="/" height={96} priority />
        <span className="rounded-full border border-[var(--ts-stroke)] bg-white/[0.04] px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ts-cyan-2)] backdrop-blur">
          Coming Soon
        </span>
      </header>

      {/* Hero */}
      <main className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col items-center justify-center px-4 py-16 text-center">
        <p className="mb-4 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ts-cyan-2)]">
          Crypto Market Intelligence
        </p>
        <h1 className="text-balance text-4xl font-bold leading-[1.05] tracking-tight sm:text-6xl">
          Trade Smarter.
          <br />
          <span className="ts-grad-text">Score Higher.</span>
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-pretty text-base text-[var(--ts-text-muted)] sm:text-lg">
          TrendScore reads the market with a multi-agent AI engine — scanning
          momentum, detecting regime shifts, and scoring long/short setups across
          the crypto market, so you act with conviction instead of guessing.
        </p>

        <div className="mt-8 flex w-full justify-center">
          <WaitlistForm variant="modern" />
        </div>

        <ul className="mt-14 grid w-full max-w-4xl gap-4 text-left sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f) => (
            <li key={f.title} className="ts-card flex flex-col gap-2 p-5">
              <span className="text-2xl" aria-hidden>
                {f.icon}
              </span>
              <h3 className="text-sm font-semibold">{f.title}</h3>
              <p className="text-xs text-[var(--ts-text-muted)]">{f.desc}</p>
            </li>
          ))}
        </ul>
      </main>

      {/* Footer */}
      <footer className="relative z-10 mx-auto w-full max-w-6xl px-4 py-8 text-center text-xs text-[var(--ts-text-muted)]">
        <p>
          Questions or Comments? Reach us at{" "}
          <a
            href="mailto:info@trendscore.io"
            className="text-[var(--ts-emerald)] hover:underline"
          >
            info@trendscore.io
          </a>
        </p>
        <p className="mt-2">
          © {new Date().getFullYear()} TrendScore.io — All rights reserved.
        </p>
        <p className="mt-1 opacity-80">
          Not financial advice. Crypto trading involves substantial risk.
        </p>
      </footer>
    </div>
  );
}
