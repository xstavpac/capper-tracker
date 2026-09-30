-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.
ALTER TYPE "PropMarket" ADD VALUE 'ANYTIME_GOAL';
ALTER TYPE "PropMarket" ADD VALUE 'FIRST_GOAL';
ALTER TYPE "PropMarket" ADD VALUE 'SHOTS_ON_GOAL';
ALTER TYPE "PropMarket" ADD VALUE 'POINTS';
ALTER TYPE "PropMarket" ADD VALUE 'ASSISTS';
ALTER TYPE "PropMarket" ADD VALUE 'SAVES';
-- CreateTable
CREATE TABLE "nhl_roster_players" (
    "id" TEXT NOT NULL,
    "espnPlayerId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "team" TEXT NOT NULL,
    "position" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "nhl_roster_players_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "nhl_roster_players_espnPlayerId_key" ON "nhl_roster_players"("espnPlayerId");
-- CreateIndex
CREATE INDEX "nhl_roster_players_team_idx" ON "nhl_roster_players"("team");
-- CreateIndex
CREATE INDEX "nhl_roster_players_lastName_idx" ON "nhl_roster_players"("lastName");
