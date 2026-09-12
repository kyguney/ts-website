// ---------------------------------------------------------------------------
// AI Analysis service (Phase 3).
//
// Turns a scored candidate + market-regime context into a structured trade
// analysis via a configurable LLM endpoint (Gemini by default). The module is
// intentionally self-contained and side-effect free: callers (the worker's
// orchestration layer, the test script) pass in the data and receive a typed
// `AIAnalysisResult`. Redis/DB persistence lives elsewhere.
//
// Resilience is a hard requirement: the worker must never crash because the
// LLM is down or rate-limited. Every failure path falls back to a
// deterministic, rule-based summary derived from the pattern score.
// ---------------------------------------------------------------------------

import type {
  AnalysisCandidate,
  Interval,
  MarketRegime,
} from "@/lib/market/types";
import { computeUsdLevels, DEFAULT_RR_REWARD } from "@/lib/ai/risk";

// --- Public output contract -------------------------------------------------

/** Strict structured output the LLM must produce (and the fallback mimics). */
export interface AIAnalysisOutput {
  sentiment: "BULLISH" | "BEARISH" | "NEUTRAL";
  /** Max 2-3 sentences, concise technical evaluation. */
  summary: string;
  /** [low, high] suggested entry zone. */
  entryRange: [number, number];
  stopLoss: number;
  /** Ordered take-profit levels (at least one). */
  takeProfitLevels: number[];
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  keyFactors: string[];
}

/** Wraps the structured output with provenance + derived fields. */
export interface AIAnalysisResult {
  output: AIAnalysisOutput;
  /**
   * Where the analysis came from:
   *   • "llm"      — a live LLM response.
   *   • "fallback" — the deterministic rule-based analysis (LLM unavailable).
   *   • "degraded" — a previous cached rationale reused because the LLM did
   *     not finish inside the per-tick budget; only the numeric price levels
   *     were refreshed from the current price (see `generateWithBudget`).
   */
  source: "llm" | "fallback" | "degraded";
  /** The model id used (or "rule-based" for the fallback). */
  model: string;
  /** Human-readable risk:reward, e.g. "1:2.5" (computed from levels). */
  riskRewardRatio: string;
  /** Wall-clock ms the AI call took (0 for fallback). */
  latencyMs: number;
  /** Present when the LLM path failed and we fell back. */
  error?: string;
}

// --- Configuration ----------------------------------------------------------

const GEMINI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";
// Keep the worker responsive: abandon slow LLM calls and fall back.
const AI_TIMEOUT_MS = 15_000;

/**
 * Ordered list of Google AI Studio models to try, cheapest / most
 * price-performant FIRST. The analyzer walks this list and uses the first
 * model that returns a valid structured response, only advancing to the next
 * (pricier) model when the current one errors or rate-limits. This mirrors the
 * "most price-performance model" intent: pay for the big model only when the
 * cheap one is unavailable.
 *
 * Override with AI_MODELS (comma-separated) or a single AI_MODEL / GEMINI_MODEL.
 */
const DEFAULT_MODEL_CHAIN = [
  "gemini-2.0-flash-lite",
  "gemini-2.0-flash",
  "gemini-2.5-flash",
];

/**
 * Resolves the LLM API key. Prefers the Phase 3 `AI_API_KEY`, falling back to
 * the legacy `GEMINI_API_KEY` so existing deployments keep working.
 */
function getApiKey(): string | undefined {
  return process.env.AI_API_KEY ?? process.env.GEMINI_API_KEY;
}

/**
 * Resolves the ordered model fallback chain.
 *   1. `AI_MODELS` — comma-separated priority list (e.g. "gemini-2.0-flash-lite,gemini-2.5-flash").
 *   2. `AI_MODEL` / `GEMINI_MODEL` — a single pinned model.
 *   3. Built-in price-performance default chain.
 * De-duplicated, order preserved.
 */
export function getAiModels(): string[] {
  const list = process.env.AI_MODELS;
  if (list && list.trim()) {
    const parsed = list
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    if (parsed.length) return Array.from(new Set(parsed));
  }
  const single = process.env.AI_MODEL ?? process.env.GEMINI_MODEL;
  if (single && single.trim()) return [single.trim()];
  return [...DEFAULT_MODEL_CHAIN];
}

/** Back-compat: the primary (first-choice) model id. */
export function getAiModel(): string {
  return getAiModels()[0];
}

/** True when an LLM key is configured (otherwise we go straight to fallback). */
export function isAiConfigured(): boolean {
  return !!getApiKey();
}

// --- Prompt inputs ----------------------------------------------------------

export interface AnalysisContext {
  candidate: AnalysisCandidate;
  regime?: MarketRegime;
  /** Optional override of the candidate's interval label in the prompt. */
  interval?: Interval;
}

// --- Prompt construction ----------------------------------------------------

const SYSTEM_INSTRUCTION = [
  "You are a professional crypto futures trading analyst.",
  "Given a technical setup and market regime, respond with a concise, risk-aware evaluation.",
  "You MUST reply with a single JSON object and nothing else (no markdown fences, no prose).",
  "The JSON must match this TypeScript type exactly:",
  "{",
  '  "sentiment": "BULLISH" | "BEARISH" | "NEUTRAL",',
  '  "summary": string,            // max 2-3 sentences',
  '  "entryRange": [number, number],',
  '  "stopLoss": number,',
  '  "takeProfitLevels": number[], // 1-3 levels, ordered nearest-first',
  '  "riskLevel": "LOW" | "MEDIUM" | "HIGH",',
  '  "keyFactors": string[]        // 2-5 short bullet phrases',
  "}",
  "Prices must be realistic relative to the current price. Do not invent fields.",
].join("\n");

function trendLine(regime?: MarketRegime): string {
  if (!regime) return "Market regime: UNKNOWN";
  return [
    `Market regime: ${regime.overallRegime}`,
    `BTC trend 15m/1h: ${regime.btcTrend15m}/${regime.btcTrend1h}`,
    `ETH trend 15m/1h: ${regime.ethTrend15m}/${regime.ethTrend1h}`,
    `BTC.D dominance surging: ${regime.isDominanceSurging ? "yes" : "no"}`,
  ].join("\n");
}

/** Builds the user-content portion of the prompt from a candidate. */
export function buildAnalysisPrompt(ctx: AnalysisContext): string {
  const { candidate: c } = ctx;
  const interval = ctx.interval ?? c.interval;

  return [
    trendLine(ctx.regime),
    "",
    "Candidate setup:",
    `- Symbol: ${c.symbol}`,
    `- Interval: ${interval}`,
    `- Direction: ${c.direction}`,
    `- Pattern: ${c.patternType}`,
    `- Current price: ${c.price}`,
    `- 24h change: ${c.change24hPct.toFixed(2)}%`,
    `- 24h volume (USDT): ${Math.round(c.volume24hUsdt)}`,
    `- RSI(14): ${c.rsi14.toFixed(1)}`,
    `- ATR%: ${c.atrRatioPct.toFixed(2)}%`,
    `- Volume spurt (15m vs 24h avg): ${c.volumeSpurtRatio.toFixed(2)}x`,
    `- Coiling squeeze / MA spread: ${c.coilingSqueezePct.toFixed(2)}%`,
    `- Distance to 24h high: ${c.distTo24hHighPct.toFixed(2)}%`,
    `- Pattern score: ${c.score.toFixed(1)}`,
    `- Engine status: ${c.statusLabel}`,
    `- Flags: ${flagSummary(c)}`,
    "",
    "Produce the JSON analysis now.",
  ].join("\n");
}

function flagSummary(c: AnalysisCandidate): string {
  const flags: string[] = [];
  if (c.isExhausted) flags.push("exhausted");
  if (c.isEarlyPumpBonus) flags.push("early-pump");
  if (c.isPreBreakoutSqueeze) flags.push("pre-breakout-squeeze");
  if (c.hasHighWickRisk) flags.push("high-wick-risk");
  if (c.isVolumeFading) flags.push("volume-fading");
  return flags.length ? flags.join(", ") : "none";
}

// --- LLM invocation ---------------------------------------------------------

interface GeminiCandidatePart {
  text?: string;
}
interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiCandidatePart[] };
    finishReason?: string;
  }>;
  error?: { message?: string; status?: string };
}

/**
 * Calls the Gemini generateContent REST endpoint and returns the raw text.
 * Throws on network error, non-2xx, timeout, or empty response so the caller
 * can fall back deterministically.
 */
async function callGemini(prompt: string, model: string): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("No AI API key configured");

  const url = `${GEMINI_BASE_URL}/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.4,
      // Ask Gemini to emit raw JSON so we don't have to strip markdown fences.
      responseMimeType: "application/json",
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const json = (await res.json()) as GeminiResponse;
    if (json.error) {
      throw new Error(`LLM error: ${json.error.status ?? ""} ${json.error.message ?? ""}`.trim());
    }
    const text = json.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("")
      .trim();
    if (!text) throw new Error("LLM returned an empty response");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// --- Parsing + validation ---------------------------------------------------

/** Strips markdown code fences if the model wrapped the JSON despite asking. */
function stripFences(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    return trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
  }
  return trimmed;
}

function asNumber(v: unknown): number | null {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Parses + validates the LLM text into a strict AIAnalysisOutput. Throws when
 * required fields are missing or malformed so the caller falls back.
 */
export function parseAiOutput(text: string): AIAnalysisOutput {
  const raw = stripFences(text);
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("LLM output was not valid JSON");
  }

  const sentiment = String(obj.sentiment ?? "").toUpperCase();
  if (!["BULLISH", "BEARISH", "NEUTRAL"].includes(sentiment)) {
    throw new Error(`Invalid sentiment: ${obj.sentiment}`);
  }

  const riskLevel = String(obj.riskLevel ?? "").toUpperCase();
  if (!["LOW", "MEDIUM", "HIGH"].includes(riskLevel)) {
    throw new Error(`Invalid riskLevel: ${obj.riskLevel}`);
  }

  const entryRaw = Array.isArray(obj.entryRange) ? obj.entryRange : [];
  const entryLow = asNumber(entryRaw[0]);
  const entryHigh = asNumber(entryRaw[1]);
  if (entryLow === null || entryHigh === null) {
    throw new Error("Invalid entryRange");
  }

  const stopLoss = asNumber(obj.stopLoss);
  if (stopLoss === null) throw new Error("Invalid stopLoss");

  const tpRaw = Array.isArray(obj.takeProfitLevels) ? obj.takeProfitLevels : [];
  const takeProfitLevels = tpRaw
    .map(asNumber)
    .filter((n): n is number => n !== null);
  if (takeProfitLevels.length === 0) {
    throw new Error("Invalid takeProfitLevels");
  }

  const keyFactors = Array.isArray(obj.keyFactors)
    ? obj.keyFactors.map((f) => String(f)).filter(Boolean)
    : [];

  const summary = String(obj.summary ?? "").trim();
  if (!summary) throw new Error("Missing summary");

  return {
    sentiment: sentiment as AIAnalysisOutput["sentiment"],
    summary,
    entryRange: [Math.min(entryLow, entryHigh), Math.max(entryLow, entryHigh)],
    stopLoss,
    takeProfitLevels,
    riskLevel: riskLevel as AIAnalysisOutput["riskLevel"],
    keyFactors,
  };
}

// --- Deterministic fallback -------------------------------------------------

/**
 * Builds a rule-based analysis purely from the candidate — no network. Used
 * when the LLM is unavailable/misconfigured/failing. Deterministic so the same
 * candidate always yields the same guidance.
 *
 * The price ladder (entry zone / stop / take-profits) is delegated to
 * {@link computeUsdLevels} so there is a single source of truth for the
 * geometry. The ladder *shape* no longer lives here as hard-coded
 * `1.5 / 0.5 / 2 / 3` multipliers — it comes from the risk module's tunables
 * (`STOP_ATR_K`, `ATR_FLOOR_PCT`) and the reward multiple.
 *
 * IMPORTANT (Req 3.3): this output stays USD-agnostic. We call the risk math
 * with a neutral *default profile* (leverage 1, a nominal balance) purely to
 * derive the balance-independent PRICE levels; the USD amounts it also returns
 * are intentionally discarded here. Per-user USD TP/SL are computed at read
 * time in the feed from the user's leverage / R:R and their tier balance.
 */
export function ruleBasedAnalysis(ctx: AnalysisContext): AIAnalysisOutput {
  const c = ctx.candidate;
  const isLong = c.direction === "LONG";

  // Delegate the ladder geometry to the deterministic risk math using a
  // default profile. Prices are independent of leverage/balance, so those
  // inputs are placeholders (leverage 1, nominal balance) and the returned USD
  // figures are ignored — only the price levels are used here.
  const levels = computeUsdLevels({
    entryPrice: c.price,
    direction: c.direction,
    atrRatioPct: c.atrRatioPct,
    leverage: 1,
    rrReward: DEFAULT_RR_REWARD,
    balanceUsd: 1,
  });

  const entryRange = levels.entryZone;
  const stopLoss = levels.stopLossPrice;
  const tp1 = levels.tp1Price;
  const tp2 = levels.tp2Price;

  // Sentiment follows direction; downgraded to NEUTRAL if flags warn.
  let sentiment: AIAnalysisOutput["sentiment"] = isLong ? "BULLISH" : "BEARISH";
  if (c.isExhausted || c.isVolumeFading) sentiment = "NEUTRAL";

  // Risk level from score + wick risk.
  let riskLevel: AIAnalysisOutput["riskLevel"] = "MEDIUM";
  if (c.score >= 200 && !c.hasHighWickRisk) riskLevel = "LOW";
  else if (c.score < 100 || c.hasHighWickRisk || c.isExhausted) riskLevel = "HIGH";

  const keyFactors: string[] = [
    `${c.patternType} pattern`,
    `Score ${c.score.toFixed(0)}`,
    `RSI ${c.rsi14.toFixed(0)}`,
    `Vol spurt ${c.volumeSpurtRatio.toFixed(1)}x`,
  ];
  if (c.hasHighWickRisk) keyFactors.push("High wick risk");
  if (c.isExhausted) keyFactors.push("Exhaustion warning");

  const dirWord = isLong ? "long" : "short";
  const summary =
    `Rule-based ${dirWord} setup on ${c.symbol} (${ctx.interval ?? c.interval}) via ${c.patternType}, ` +
    `score ${c.score.toFixed(0)} with a ${c.volumeSpurtRatio.toFixed(1)}x volume spurt and RSI ${c.rsi14.toFixed(0)}. ` +
    `Targets a ~1:2 reward:risk using a ${c.atrRatioPct.toFixed(1)}% ATR stop.`;

  return {
    sentiment,
    summary,
    entryRange,
    stopLoss,
    takeProfitLevels: [tp1, tp2],
    riskLevel,
    keyFactors,
  };
}

// --- Risk:reward derivation --------------------------------------------------

/**
 * Computes a "1:X" reward:risk string from the entry midpoint, stop, and first
 * take-profit. Returns "n/a" when geometry is degenerate.
 */
export function computeRiskReward(output: AIAnalysisOutput): string {
  const entryMid = (output.entryRange[0] + output.entryRange[1]) / 2;
  const risk = Math.abs(entryMid - output.stopLoss);
  const firstTp = output.takeProfitLevels[0];
  if (!risk || firstTp === undefined) return "n/a";
  const reward = Math.abs(firstTp - entryMid);
  if (!reward) return "n/a";
  const ratio = reward / risk;
  return `1:${ratio.toFixed(1)}`;
}

// --- Top-level entry point ---------------------------------------------------

/**
 * Generates a structured AI analysis for a candidate. Tries the LLM first;
 * on ANY failure (no key, network, bad JSON, timeout) it returns a
 * deterministic rule-based analysis and never throws.
 */
export async function generateAnalysis(
  ctx: AnalysisContext,
): Promise<AIAnalysisResult> {
  if (!isAiConfigured()) {
    const output = ruleBasedAnalysis(ctx);
    return {
      output,
      source: "fallback",
      model: "rule-based",
      riskRewardRatio: computeRiskReward(output),
      latencyMs: 0,
      error: "AI not configured (no AI_API_KEY/GEMINI_API_KEY)",
    };
  }

  const models = getAiModels();
  const prompt = buildAnalysisPrompt(ctx);
  const startedAt = Date.now();

  // Try each model in price-performance order; use the first that succeeds.
  const errors: string[] = [];
  for (const model of models) {
    try {
      const text = await callGemini(prompt, model);
      const output = parseAiOutput(text);
      return {
        output,
        source: "llm",
        model,
        riskRewardRatio: computeRiskReward(output),
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      errors.push(`${model}: ${err instanceof Error ? err.message : String(err)}`);
      // Advance to the next (pricier) model.
    }
  }

  // Every model failed — deterministic fallback so the worker never crashes.
  const output = ruleBasedAnalysis(ctx);
  return {
    output,
    source: "fallback",
    model: "rule-based",
    riskRewardRatio: computeRiskReward(output),
    latencyMs: Date.now() - startedAt,
    error: `All models failed → ${errors.join(" | ")}`,
  };
}
