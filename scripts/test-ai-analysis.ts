// ---------------------------------------------------------------------------
// Phase 3 verification script — Tiered AI Trade Analysis Engine.
//
// Drives the AI orchestration layer against SIMULATED market data (no live
// Binance, no WebSocket). Demonstrates both tiers end-to-end:
//
//   1. FREE broadcast  — elects the cycle leader, generates the shared 15m
//      broadcast from the top 1-2 market-wide candidates, and reads it back.
//   2. PRO multi-timeframe — runs per-symbol/interval analysis across 5m / 15m
//      / 1h, showing the score>=80 gate (a low-score candidate is skipped).
//
// Redis and the LLM are optional: with neither configured the script still
// runs, exercising the in-process cycle-leader guard and the deterministic
// rule-based fallback. If REDIS_URL is set, results are cached/read back; if
// AI_API_KEY is set, real Gemini output is used. Postgres is never required
// (persistence is skipped).
//
// Usage:
//   npm run test:ai
//   AI_API_KEY="..." REDIS_URL="redis://127.0.0.1:6379" npm run test:ai
// ---------------------------------------------------------------------------

import "dotenv/config";

import type {
  AnalysisCandidate,
  IndicatorSnapshot,
  Interval,
  MarketRegime,
  PatternType,
} from "@/lib/market/types";
import { isAiConfigured, getAiModels } from "@/lib/ai/analyzer";
import {
  claimFreeCycleLeader,
  generateFreeBroadcast,
  generateProAnalysis,
  PRO_SCORE_THRESHOLD,
} from "@/lib/ai/orchestrator";
import { readFreeBroadcast, readProAnalysis } from "@/lib/ai/store";
import { isRedisReady, redis } from "@/lib/redis";
import type { StoredAnalysis } from "@/lib/ai/store";

// --- Minimal ANSI helpers (avoid chalk ESM dep, matching test-engine.ts) ----
const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

// --- Simulated data ----------------------------------------------------------

const MOCK_REGIME: MarketRegime = {
  btcTrend15m: "BULLISH",
  btcTrend1h: "BULLISH",
  ethTrend15m: "BULLISH",
  ethTrend1h: "NEUTRAL",
  overallRegime: "BULLISH",
  isDominanceSurging: false,
  totalMarketVolume24hUsdt: 85_000_000_000,
};

/** Builds a plausible candidate with sensible defaults, overridable per test. */
function mockCandidate(
  over: Partial<AnalysisCandidate> & {
    symbol: string;
    interval: Interval;
    price: number;
    score: number;
  },
): AnalysisCandidate {
  const price = over.price;
  return {
    symbol: over.symbol,
    interval: over.interval,
    direction: over.direction ?? "LONG",
    patternType: over.patternType ?? ("🚀 GOLDEN COILING" as PatternType),
    price,
    change24hPct: over.change24hPct ?? 6.4,
    volume24hUsdt: over.volume24hUsdt ?? 240_000_000,
    high24h: over.high24h ?? price * 1.03,
    ma7: over.ma7 ?? price * 0.995,
    ma25: over.ma25 ?? price * 0.98,
    ma99: over.ma99 ?? price * 0.95,
    rsi14: over.rsi14 ?? 61,
    atrRatioPct: over.atrRatioPct ?? 1.8,
    volumeSpurtRatio: over.volumeSpurtRatio ?? 2.6,
    coilingSqueezePct: over.coilingSqueezePct ?? 1.4,
    wickRatioPct: over.wickRatioPct ?? 22,
    hasHighWickRisk: over.hasHighWickRisk ?? false,
    isVolumeFading: over.isVolumeFading ?? false,
    isExhausted: over.isExhausted ?? false,
    isEarlyPumpBonus: over.isEarlyPumpBonus ?? false,
    isPreBreakoutSqueeze: over.isPreBreakoutSqueeze ?? true,
    distTo24hHighPct: over.distTo24hHighPct ?? 1.2,
    distToMa25Pct: over.distToMa25Pct ?? 2.0,
    score: over.score,
    statusLabel: over.statusLabel ?? "🟢 COILING",
  };
}

const MOCK_INDICATORS: IndicatorSnapshot = {
  price: 0,
  ma7: 0,
  ma25: 0,
  ma99: 0,
  ema7: 0,
  rsi14: 61,
  atr: 0,
  atrRatioPct: 1.8,
  volumeSpurtRatio: 2.6,
  coilingSqueezePct: 1.4,
  upperWickRatio: 0.2,
  lowerWickRatio: 0.1,
  hasHighWickRisk: false,
  isRedCandle: false,
};

// --- Rendering ---------------------------------------------------------------

function printAnalysis(a: StoredAnalysis): void {
  const dir = a.direction === "LONG" ? c.green(a.direction) : c.red(a.direction);
  const badge =
    a.source === "llm" ? c.green("[LLM]") : c.yellow("[rule-based]");
  console.log(
    `  ${c.bold(a.symbol)} ${c.cyan(a.interval)} ${dir} ${badge} ${c.dim(a.model)}`,
  );
  console.log(
    `    ${c.dim("sentiment:")} ${a.ai.sentiment}   ${c.dim("risk:")} ${a.ai.riskLevel}   ${c.dim("R:R:")} ${a.riskRewardRatio}   ${c.dim("score:")} ${a.score.toFixed(0)}`,
  );
  console.log(
    `    ${c.dim("entry:")} [${a.ai.entryRange[0]}, ${a.ai.entryRange[1]}]  ${c.dim("SL:")} ${a.ai.stopLoss}  ${c.dim("TP:")} ${a.ai.takeProfitLevels.join(" / ")}`,
  );
  console.log(`    ${c.dim("summary:")} ${a.ai.summary}`);
  console.log(`    ${c.dim("factors:")} ${a.ai.keyFactors.join(" · ")}`);
}

// --- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(
    c.cyan(
      "===================================================================================",
    ),
  );
  console.log(
    c.cyan(c.bold("⚡ PHASE 3 — TIERED AI ANALYSIS ENGINE VERIFICATION (simulated data)")),
  );
  console.log(
    c.cyan(
      "===================================================================================",
    ),
  );
  console.log(`${c.dim("AI configured:")} ${isAiConfigured() ? c.green("yes") : c.yellow("no → rule-based fallback")}`);
  console.log(`${c.dim("Model chain (price-performance order):")} ${c.cyan(getAiModels().join(" → "))}`);
  console.log(`${c.dim("Redis:")} ${isRedisReady() || redis ? c.green("configured") : c.yellow("not configured (in-memory guards)")}`);
  console.log(`${c.dim("Pro score threshold:")} ${PRO_SCORE_THRESHOLD}`);
  console.log(`${c.dim("Market regime:")} ${MOCK_REGIME.overallRegime}`);
  console.log("");

  // --- Simulated market snapshot (mixed intervals & scores) ------------------
  const snapshot: AnalysisCandidate[] = [
    mockCandidate({ symbol: "SOLUSDT", interval: "15m", price: 178.42, score: 264, volumeSpurtRatio: 3.4, statusLabel: "🔥 BREAKOUT" }),
    mockCandidate({ symbol: "ENAUSDT", interval: "15m", price: 0.6231, score: 191, volumeSpurtRatio: 2.9 }),
    mockCandidate({ symbol: "AVAXUSDT", interval: "15m", price: 42.18, score: 88, volumeSpurtRatio: 1.7 }),
    mockCandidate({ symbol: "LINKUSDT", interval: "15m", price: 23.71, score: 54, isExhausted: true, statusLabel: "⚠️ EXHAUSTED" }),
    // Pro-only intervals present in the snapshot but ignored by the Free tier.
    mockCandidate({ symbol: "SOLUSDT", interval: "5m", price: 178.55, score: 132, direction: "LONG", patternType: "⚡ EARLY_LONG_ENTRY" as PatternType }),
    mockCandidate({ symbol: "BNBUSDT", interval: "1h", price: 612.3, score: 210, direction: "SHORT", patternType: "🔻 SHORT A (Direnç Reddi / Retest)" as PatternType, rsi14: 71 }),
    mockCandidate({ symbol: "AEROUSDT", interval: "5m", price: 1.284, score: 61 }), // below threshold
  ];

  // === 1. FREE broadcast =====================================================
  console.log(c.magenta(c.bold("── 1. FREE TIER: Global 15m Broadcast ─────────────────────────────")));
  const isLeader = await claimFreeCycleLeader();
  console.log(`${c.dim("Cycle-leader election:")} ${isLeader ? c.green("WON — generating broadcast") : c.yellow("already generated this 15m window")}`);

  const broadcast = await generateFreeBroadcast({
    candidates: snapshot,
    regime: MOCK_REGIME,
  });

  if (broadcast) {
    console.log(
      `${c.dim("Broadcast generated:")} ${c.green(String(broadcast.analyses.length))} pick(s) (top ${broadcast.analyses.length} of ${snapshot.filter((s) => s.interval === "15m" && !s.isExhausted).length} eligible 15m candidates)`,
    );
    for (const a of broadcast.analyses) printAnalysis(a);
  } else {
    console.log(c.yellow("No eligible 15m candidates — no broadcast."));
  }

  // Read it back from Redis (proves the shared cache path when configured).
  const cached = await readFreeBroadcast();
  console.log(
    `${c.dim("Read-back from Redis (analysis:broadcast:free:15m):")} ${cached ? c.green(`${cached.analyses.length} pick(s), tier=${cached.tier}`) : c.yellow("null (Redis not configured or not leader)")}`,
  );
  console.log("");

  // === 2. PRO multi-timeframe ================================================
  console.log(c.magenta(c.bold("── 2. PRO TIER: Multi-Timeframe (5m / 15m / 1h), score ≥ 80 ───────")));
  const proInputs = snapshot.filter((s) =>
    ["SOLUSDT", "BNBUSDT", "AEROUSDT"].includes(s.symbol),
  );

  for (const candidate of proInputs) {
    const res = await generateProAnalysis({
      candidate,
      indicators: { ...MOCK_INDICATORS, price: candidate.price },
      regime: MOCK_REGIME,
      ignoreCooldown: true, // deterministic in tests
      skipPersist: true, // no Postgres needed for this verification
    });

    if (res.generated && res.analysis) {
      console.log(c.green(`✔ Generated (${candidate.symbol} ${candidate.interval}, score ${candidate.score}):`));
      printAnalysis(res.analysis);
      // Prove per-symbol/interval cache key when Redis is configured.
      const back = await readProAnalysis(candidate.symbol, candidate.interval);
      console.log(
        `    ${c.dim("cache read (analysis:latest:" + candidate.symbol + ":" + candidate.interval + "):")} ${back ? c.green("hit") : c.yellow("miss (no Redis)")}`,
      );
    } else {
      console.log(
        c.yellow(`✗ Skipped ${candidate.symbol} ${candidate.interval} (score ${candidate.score}): ${res.reason}`),
      );
    }
  }

  console.log("");
  console.log(c.green(c.bold("✅ Phase 3 verification complete.")));

  // Close Redis so the process exits cleanly.
  if (redis) await redis.quit().catch(() => {});
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
