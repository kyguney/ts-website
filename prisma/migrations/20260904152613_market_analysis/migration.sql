-- CreateEnum
CREATE TYPE "trade_direction" AS ENUM ('LONG', 'SHORT');

-- CreateTable
CREATE TABLE "market_analysis" (
    "id" TEXT NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "interval" VARCHAR(8) NOT NULL,
    "direction" "trade_direction" NOT NULL,
    "pattern" VARCHAR(64) NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "change24hPct" DOUBLE PRECISION NOT NULL,
    "volume24hUsdt" DOUBLE PRECISION NOT NULL,
    "rsi14" DOUBLE PRECISION NOT NULL,
    "atrRatioPct" DOUBLE PRECISION NOT NULL,
    "volumeSpurtRatio" DOUBLE PRECISION NOT NULL,
    "coilingSqueezePct" DOUBLE PRECISION NOT NULL,
    "isExhausted" BOOLEAN NOT NULL DEFAULT false,
    "isEarlyPumpBonus" BOOLEAN NOT NULL DEFAULT false,
    "statusLabel" VARCHAR(64) NOT NULL,
    "indicators" JSONB NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_analysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "market_analysis_symbol_interval_idx" ON "market_analysis"("symbol", "interval");

-- CreateIndex
CREATE INDEX "market_analysis_detectedAt_idx" ON "market_analysis"("detectedAt");

-- CreateIndex
CREATE INDEX "market_analysis_score_idx" ON "market_analysis"("score");
