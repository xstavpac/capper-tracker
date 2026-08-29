-- CreateTable
CREATE TABLE "nfl_team_stat_snapshots" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "week" INTEGER NOT NULL,
    "gameType" TEXT NOT NULL,
    "gameDate" TEXT NOT NULL,
    "team" TEXT NOT NULL,
    "opponent" TEXT NOT NULL,
    "homeAway" TEXT NOT NULL,
    "completed" BOOLEAN NOT NULL,
    "points" INTEGER,
    "pointsAllowed" INTEGER,
    "totalYards" INTEGER NOT NULL,
    "totalYardsAllowed" INTEGER NOT NULL,
    "passingYards" INTEGER NOT NULL,
    "passingYardsAllowed" INTEGER NOT NULL,
    "rushingYards" INTEGER NOT NULL,
    "rushingYardsAllowed" INTEGER NOT NULL,
    "offensivePlays" INTEGER NOT NULL,
    "yardsPerPlay" DOUBLE PRECISION,
    "firstDowns" INTEGER NOT NULL,
    "thirdDownPct" DOUBLE PRECISION,
    "thirdDownPctAllowed" DOUBLE PRECISION,
    "timeOfPossessionSeconds" INTEGER,
    "turnovers" INTEGER NOT NULL,
    "takeaways" INTEGER NOT NULL,
    "turnoverMargin" INTEGER NOT NULL,
    "sacks" INTEGER NOT NULL,
    "sacksAllowed" INTEGER NOT NULL,
    "sackYardsLost" INTEGER NOT NULL,
    "penalties" INTEGER NOT NULL,
    "penaltyYards" INTEGER NOT NULL,
    "passingEpa" DOUBLE PRECISION NOT NULL,
    "rushingEpa" DOUBLE PRECISION NOT NULL,
    "receivingEpa" DOUBLE PRECISION NOT NULL,
    "offensiveEpa" DOUBLE PRECISION NOT NULL,
    "sourceId" TEXT NOT NULL DEFAULT 'nflverse',
    "scope" "DataScope" NOT NULL DEFAULT 'GLOBAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nfl_team_stat_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "nfl_team_stat_snapshots_team_gameDate_idx" ON "nfl_team_stat_snapshots"("team", "gameDate");

-- CreateIndex
CREATE UNIQUE INDEX "nfl_team_stat_snapshots_team_gameId_key" ON "nfl_team_stat_snapshots"("team", "gameId");
