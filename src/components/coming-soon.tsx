import ChartBackground from "@/components/ChartBackground";
import WaitlistForm from "@/components/WaitlistForm";
import { BrandLogo } from "@/components/brand-logo";

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
    <>
      <div className="bg-grid" aria-hidden="true" />
      <div className="bg-glow bg-glow--one" aria-hidden="true" />
      <div className="bg-glow bg-glow--two" aria-hidden="true" />
      <ChartBackground />

      <main className="wrap">
        <header className="nav">
          <BrandLogo href="/" height={112} priority />
          <span className="badge">Coming Soon</span>
        </header>

        <section className="hero">
          <p className="eyebrow">AI-Powered Crypto Intelligence</p>
          <h1 className="title">
            <span className="title__line">Know when to</span>
            <span className="title__line">
              go <span className="grad grad--long">Long</span> or{" "}
              <span className="grad grad--short">Short</span>
            </span>
          </h1>
          <p className="subtitle">
            TrendScore reads the market with a multi-agent AI engine — scanning
            momentum, detecting regime shifts, and scoring long/short setups
            across the crypto market, so you act with conviction instead of
            guessing.
          </p>

          <WaitlistForm />

          <ul className="features">
            {FEATURES.map((f) => (
              <li key={f.title}>
                <span className="features__icon">{f.icon}</span>
                <div>
                  <h3>{f.title}</h3>
                  <p>{f.desc}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <footer className="foot">
          <p className="foot__contact">
            Questions or Comments? Reach us at{" "}
            <a href="mailto:info@trendscore.io">info@trendscore.io</a>
          </p>
          <p>© {new Date().getFullYear()} TrendScore.io — All rights reserved.</p>
          <p className="foot__disclaimer">
            Not financial advice. Crypto trading involves substantial risk.
          </p>
        </footer>
      </main>
    </>
  );
}
