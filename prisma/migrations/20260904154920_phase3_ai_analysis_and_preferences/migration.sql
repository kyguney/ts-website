-- AlterTable
ALTER TABLE "market_analysis" ADD COLUMN     "entryPrice" DOUBLE PRECISION,
ADD COLUMN     "isProOnly" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "patternScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "riskRewardRatio" VARCHAR(16),
ADD COLUMN     "stopLoss" DOUBLE PRECISION,
ADD COLUMN     "takeProfit1" DOUBLE PRECISION,
ADD COLUMN     "takeProfit2" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "user_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "intervals" TEXT[] DEFAULT ARRAY['15m']::TEXT[],
    "favoritePairs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_preferences_userId_key" ON "user_preferences"("userId");

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
