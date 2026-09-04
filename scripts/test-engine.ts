// ---------------------------------------------------------------------------
// CLI verification script for the ported market analysis engine.
//
// Runs a SINGLE synchronous pass over the TRACKED_SYMBOLS watchlist against
// live Binance Futures REST data (no WebSocket, no Redis, no DB writes),
// computes indicators + pattern scores, and prints a candidate table that
// mirrors the source engine's terminal report (index.ts renderDualHunterTable).
//
// Usage:
//   npm run test:engine
//   TRACKED_SYMBOLS="BTCUSDT,SOLUSDT" npm run test:engine
// ---------------------------------------------------------------------------

import "dotenv/config";
import Table from "cli-table3";
import { getTrackedSymbols } from "@/lib/market/config";
import { fetch24hTicker, fetchKlines } from "@/lib/market/binance";
import { analyzeSymbolInterval, computeRegime } from "@/lib/market/engine";
import { sortCandidates } from "@/lib/patterns";
import type {
  AnalysisCandidate,
  Kline,
  MarketRegime,
  Ticker24h,
  TrendState,
} from "@/lib/market/types";

// --- Minimal ANSI color helpers (avoids the chalk ESM dependency) ----------
const c = {
  reset: "\x1b[0m",
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  white: (s: string) => `\x1b[37m${s}\x1b[0m`,
};

function formatTrend(t: TrendState): string {
  if (t === "BULLISH") return c.green("🚀 BULLISH");
  if (t === "BEARISH") return c.red("📉 BEARISH");
  return c.yellow("⏸️ NEUTRAL");
}

function fmtPrice(p: number): string {
  return p < 1 ? p.toFixed(6) : p.toFixed(3);
}

async function main(): Promise<void> {
  const symbols = getTrackedSymbols();
  const t0 = Date.now();

  console.log(
    c.cyan(
      "===================================================================================",
    ),
  );
  console.log(
    c.cyan(
      c.bold(
        "⚡ TRENDSCORE MARKET ENGINE — SINGLE-PASS VERIFICATION (Live Binance Futures)",
      ),
    ),
  );
  console.log(
    c.cyan(
      "===================================================================================",
    ),
  );
  console.log(`${c.dim("Timestamp:")} ${new Date().toLocaleString()}`);
  console.log(`${c.dim("Tracked symbols:")} ${symbols.join(", ")}`);

  // --- Regime from BTC/ETH ---------------------------------------------------
  let regime: MarketRegime | undefined;
  try {
    const [btc15m, btc1h, eth15m, eth1h] = await Promise.all([
      fetchKlines("BTCUSDT", "15m", 200),
      fetchKlines("BTCUSDT", "1h", 200),
      fetchKlines("ETHUSDT", "15m", 200),
      fetchKlines("ETHUSDT", "1h", 200),
    ]);
    regime = computeRegime({ btc15m, btc1h, eth15m, eth1h });
    console.log(
      `${c.dim("BTC Trend (15m / 1h):")} ${formatTrend(regime.btcTrend15m)} / ${formatTrend(regime.btcTrend1h)}`,
    );
    console.log(
      `${c.dim("ETH Trend (15m / 1h):")} ${formatTrend(regime.ethTrend15m)} / ${formatTrend(regime.ethTrend1h)}`,
    );
    console.log(`${c.dim("Market Regime:")} ${formatTrend(regime.overallRegime)}`);
  } catch (e) {
    console.warn(c.yellow(`Regime computation failed: ${errMsg(e)}`));
  }

  // --- Per-symbol analysis (15m primary, 1h backbone, 5m early-entry) --------
  const candidates: AnalysisCandidate[] = [];
  let scanned = 0;

  for (const symbol of symbols) {
    try {
      const [ticker, k15m, k1h, k5m] = await Promise.all([
        fetch24hTicker(symbol) as Promise<Ticker24h>,
        fetchKlines(symbol, "15m", 200),
        fetchKlines(symbol, "1h", 200),
        fetchKlines(symbol, "5m", 60),
      ]);
      scanned++;

      const { candidate } = analyzeSymbolInterval({
        symbol,
        interval: "15m",
        klines: k15m,
        klines1h: k1h,
        klines5m: k5m,
        ticker,
        regime,
      });

      if (candidate) candidates.push(candidate);
    } catch (e) {
      console.warn(c.yellow(`  ${symbol}: ${errMsg(e)}`));
    }
    await sleep(20);
  }

  const sorted = sortCandidates(candidates);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

  console.log(
    `${c.dim("Scanned:")} ${c.yellow(String(scanned))} | ${c.dim("Pattern Matches:")} ${c.green(c.bold(String(sorted.length)))} | ${c.dim("Elapsed:")} ${c.green(elapsed + "s")}`,
  );
  console.log(
    c.cyan(
      "-----------------------------------------------------------------------------------",
    ),
  );

  renderTable(sorted);
}

function renderTable(candidates: AnalysisCandidate[]): void {
  if (candidates.length === 0) {
    console.log(
      c.yellow(
        "\n⚠️ No symbol currently meets the volume-anomaly / breakout criteria.\n",
      ),
    );
    return;
  }

  console.log(
    c.magenta(c.bold(`\n 💥 PATTERN MATCHES (${candidates.length} FOUND) 💥 `)),
  );

  const table = new Table({
    head: [
      "#",
      "Symbol",
      "Dir",
      "Pattern Type",
      "Price ($)",
      "24h Change",
      "24h Vol ($M)",
      "Squeeze / Retest",
      "Vol Spurt (15m vs 24h)",
      "RSI | ATR | Wick%",
      "Score",
      "Status",
    ].map((h) => c.bold(c.white(h))),
    colAligns: [
      "center",
      "left",
      "center",
      "left",
      "right",
      "right",
      "right",
      "right",
      "right",
      "center",
      "right",
      "left",
    ],
  });

  candidates.forEach((cand, idx) => {
    const changeStr =
      (cand.change24hPct >= 0 ? "+" : "") + cand.change24hPct.toFixed(2) + "%";
    const change = cand.change24hPct >= 0 ? c.green(changeStr) : c.red(changeStr);
    const dir =
      cand.direction === "SHORT" ? c.red("🔴 SHORT") : c.green("🟢 LONG");

    const distText =
      cand.patternType === "PATERN B (MANTRA Retest)"
        ? `${cand.distTo24hHighPct.toFixed(2)}% (to High)`
        : `${cand.coilingSqueezePct.toFixed(2)}% (MA Spread)`;

    const wickPct = cand.wickRatioPct.toFixed(0);
    const rsiAtrWick = `${cand.rsi14.toFixed(0)} | ${cand.atrRatioPct.toFixed(1)}% | ${cand.hasHighWickRisk ? c.red(wickPct + "%") : wickPct + "%"}`;

    const spurt = `${cand.volumeSpurtRatio.toFixed(2)}x`;
    const spurtColored =
      cand.volumeSpurtRatio >= 3.0
        ? c.green(c.bold(spurt))
        : cand.volumeSpurtRatio >= 1.8
          ? c.green(spurt)
          : c.yellow(spurt);

    table.push([
      String(idx + 1),
      c.bold(cand.symbol),
      dir,
      cand.patternType,
      fmtPrice(cand.price),
      change,
      `$${(cand.volume24hUsdt / 1_000_000).toFixed(2)}M`,
      distText,
      spurtColored,
      rsiAtrWick,
      c.magenta(c.bold(cand.score.toFixed(1))),
      cand.statusLabel,
    ]);
  });

  console.log(table.toString());
  console.log(
    c.cyan(
      "-----------------------------------------------------------------------------------\n",
    ),
  );
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error(`Fatal: ${errMsg(e)}`);
  process.exit(1);
});
