-- AlterTable
ALTER TABLE "user_preferences" ADD COLUMN     "default_leverage" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "default_rr_ratio" TEXT NOT NULL DEFAULT '1:2';
