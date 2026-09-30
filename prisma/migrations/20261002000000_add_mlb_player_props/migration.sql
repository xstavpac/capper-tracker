-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.
ALTER TYPE "PropMarket" ADD VALUE 'STRIKEOUTS';
ALTER TYPE "PropMarket" ADD VALUE 'OUTS_RECORDED';
ALTER TYPE "PropMarket" ADD VALUE 'TOTAL_BASES';
ALTER TYPE "PropMarket" ADD VALUE 'HITS';
ALTER TYPE "PropMarket" ADD VALUE 'WALKS';
ALTER TYPE "PropMarket" ADD VALUE 'RUNS';
ALTER TYPE "PropMarket" ADD VALUE 'RBIS';
ALTER TYPE "PropMarket" ADD VALUE 'HOME_RUNS';
-- CreateTable
CREATE TABLE "mlb_roster_players" (
    "id" TEXT NOT NULL,
    "mlbPlayerId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "team" TEXT NOT NULL,
    "position" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "mlb_roster_players_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "mlb_roster_players_mlbPlayerId_key" ON "mlb_roster_players"("mlbPlayerId");
-- CreateIndex
CREATE INDEX "mlb_roster_players_team_idx" ON "mlb_roster_players"("team");
-- CreateIndex
CREATE INDEX "mlb_roster_players_lastName_idx" ON "mlb_roster_players"("lastName");
