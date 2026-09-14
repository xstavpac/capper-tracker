-- CreateEnum
CREATE TYPE "PropMarket" AS ENUM ('PASS_YDS', 'RUSH_YDS', 'REC_YDS', 'RECEPTIONS', 'TD');

-- AlterTable
ALTER TABLE "picks" ADD COLUMN     "playerName" TEXT,
ADD COLUMN     "propMarket" "PropMarket";
