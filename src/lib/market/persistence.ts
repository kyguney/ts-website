// ---------------------------------------------------------------------------
// PostgreSQL sync for qualifying setups. Inserts into the `MarketAnalysis`
// table (via Prisma) for historical dashboard views.
//
// Fire-and-forget friendly: errors are logged, never thrown, so a DB hiccup
// never stalls the real-time ingestion loop.
// ---------------------------------------------------------------------------

import { prisma } from "@/lib/prisma";
import type { AnalysisCandidate, IndicatorSnapshot } from "@/lib/market/types";

/**
 * Persists a qualifying candidate as a historical MarketAnalysis row.
 * Returns true on success, false if the insert failed (logged).
 */
export async function persistCandidate(
  candidate: AnalysisCandidate,
  indicators: IndicatorSnapshot,
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
