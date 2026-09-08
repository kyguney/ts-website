// ---------------------------------------------------------------------------
// PostgreSQL sync for qualifying setups. Inserts into the `MarketAnalysis`
// table (via Prisma) for historical dashboard views.
//
// Fire-and-forget friendly: errors are logged, never thrown, so a DB hiccup
// never stalls the real-time ingestion loop.
// ---------------------------------------------------------------------------

import { prisma } from "@/lib/prisma";
import type { AnalysisCandidate, IndicatorSnapshot } from "@/lib/market/types";

/** Optional AI-derived fields attached when a candidate has been analyzed. */
export interface PersistAiFields {
  patternScore?: number;
  riskRewardRatio?: string | null;
  entryPrice?: number | null;
  stopLoss?: number | null;
  takeProfit1?: number | null;
  takeProfit2?: number | null;
  isProOnly?: boolean;
}

/**
 * Persists a qualifying candidate as a historical MarketAnalysis row.
 * Returns true on success, false if the insert failed (logged).
 *
 * `ai` is optional: when the AI layer has produced entry/stop/target levels
 * for this candidate they are stored alongside the raw engine metrics.
 */
export async function persistCandidate(
  candidate: AnalysisCandidate,
  indicators: IndicatorSnapshot,
  ai?: PersistAiFields,
): Promise<boolean> {
  try {
    await prisma.marketAnalysis.create({
      data: {
        symbol: candidate.symbol,
        interval: candidate.interval,
        direction: candidate.direction,
        pattern: candidate.patternType,
        score: candidate.score,
        price: candidate.price,
        change24hPct: candidate.change24hPct,
        volume24hUsdt: candidate.volume24hUsdt,
        rsi14: candidate.rsi14,
        atrRatioPct: candidate.atrRatioPct,
        volumeSpurtRatio: candidate.volumeSpurtRatio,
        coilingSqueezePct: candidate.coilingSqueezePct,
        isExhausted: candidate.isExhausted,
        isEarlyPumpBonus: candidate.isEarlyPumpBonus,
        statusLabel: candidate.statusLabel,
        // --- AI fields (Phase 3) — default to the engine score when no AI ---
        patternScore: ai?.patternScore ?? candidate.score,
        riskRewardRatio: ai?.riskRewardRatio ?? null,
        entryPrice: ai?.entryPrice ?? null,
        stopLoss: ai?.stopLoss ?? null,
        takeProfit1: ai?.takeProfit1 ?? null,
        takeProfit2: ai?.takeProfit2 ?? null,
        isProOnly: ai?.isProOnly ?? true,
        indicators: indicators as unknown as object,
      },
    });
    return true;
  } catch (err) {
    console.error(
      "[persistence] Failed to insert MarketAnalysis row:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
