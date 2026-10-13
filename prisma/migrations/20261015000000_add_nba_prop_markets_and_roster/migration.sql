-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.
ALTER TYPE "PropMarket" ADD VALUE 'REBOUNDS';
ALTER TYPE "PropMarket" ADD VALUE 'THREES_MADE';
ALTER TYPE "PropMarket" ADD VALUE 'STEALS';
ALTER TYPE "PropMarket" ADD VALUE 'BLOCKS';
ALTER TYPE "PropMarket" ADD VALUE 'POINTS_REBOUNDS_ASSISTS';
ALTER TYPE "PropMarket" ADD VALUE 'POINTS_REBOUNDS';
ALTER TYPE "PropMarket" ADD VALUE 'POINTS_ASSISTS';
ALTER TYPE "PropMarket" ADD VALUE 'REBOUNDS_ASSISTS';
ALTER TYPE "PropMarket" ADD VALUE 'DOUBLE_DOUBLE';
-- CreateTable
CREATE TABLE "nba_roster_players" (
    "id" TEXT NOT NULL,
    "espnPlayerId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "team" TEXT NOT NULL,
    "position" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "nba_roster_players_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "nba_roster_players_espnPlayerId_key" ON "nba_roster_players"("espnPlayerId");
-- CreateIndex
CREATE INDEX "nba_roster_players_team_idx" ON "nba_roster_players"("team");
-- CreateIndex
CREATE INDEX "nba_roster_players_lastName_idx" ON "nba_roster_players"("lastName");

-- Same as every other table (see 20260915120000_enable_rls_on_all_tables): no
-- policies, so only the server's own connection reads or writes it.
ALTER TABLE "nba_roster_players" ENABLE ROW LEVEL SECURITY;
