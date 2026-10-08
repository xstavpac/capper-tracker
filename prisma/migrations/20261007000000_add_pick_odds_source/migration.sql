-- CreateEnum
CREATE TYPE "OddsSource" AS ENUM ('STATED', 'MARKET', 'DEFAULTED');

-- AlterTable
ALTER TABLE "picks" ADD COLUMN "oddsSource" "OddsSource";
