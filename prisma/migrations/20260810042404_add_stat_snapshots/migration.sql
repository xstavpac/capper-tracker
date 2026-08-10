-- CreateTable
CREATE TABLE "team_stat_snapshots" (
    "id" TEXT NOT NULL,
    "sportKey" TEXT NOT NULL,
    "teamName" TEXT NOT NULL,
    "snapshotDate" TEXT NOT NULL,
    "wins" INTEGER NOT NULL,
    "losses" INTEGER NOT NULL,
    "winPct" DOUBLE PRECISION NOT NULL,
    "runDifferential" INTEGER NOT NULL,
    "battingAvg" DOUBLE PRECISION NOT NULL,
    "obp" DOUBLE PRECISION NOT NULL,
    "slg" DOUBLE PRECISION NOT NULL,
    "ops" DOUBLE PRECISION NOT NULL,
    "era" DOUBLE PRECISION NOT NULL,
    "whip" DOUBLE PRECISION NOT NULL,
    "homeWins" INTEGER NOT NULL,
    "homeLosses" INTEGER NOT NULL,
    "awayWins" INTEGER NOT NULL,
    "awayLosses" INTEGER NOT NULL,
    "last10Wins" INTEGER NOT NULL,
    "last10Losses" INTEGER NOT NULL,
    "streakType" TEXT,
    "streakCount" INTEGER NOT NULL,
    "sourceId" TEXT NOT NULL DEFAULT 'mlb_stats_api',
    "scope" "DataScope" NOT NULL DEFAULT 'GLOBAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_stat_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pitcher_stat_snapshots" (
    "id" TEXT NOT NULL,
    "sportKey" TEXT NOT NULL,
    "pitcherId" INTEGER NOT NULL,
    "pitcherName" TEXT NOT NULL,
    "snapshotDate" TEXT NOT NULL,
    "era" DOUBLE PRECISION NOT NULL,
    "whip" DOUBLE PRECISION NOT NULL,
    "wins" INTEGER NOT NULL,
    "losses" INTEGER NOT NULL,
    "strikeouts" INTEGER NOT NULL,
    "walks" INTEGER NOT NULL,
    "inningsPitched" DOUBLE PRECISION NOT NULL,
    "homeEra" DOUBLE PRECISION,
    "roadEra" DOUBLE PRECISION,
    "daysRest" INTEGER,
    "sourceId" TEXT NOT NULL DEFAULT 'mlb_stats_api',
    "scope" "DataScope" NOT NULL DEFAULT 'GLOBAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pitcher_stat_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "team_stat_snapshots_sportKey_teamName_snapshotDate_key" ON "team_stat_snapshots"("sportKey", "teamName", "snapshotDate");

-- CreateIndex
CREATE UNIQUE INDEX "pitcher_stat_snapshots_sportKey_pitcherId_snapshotDate_key" ON "pitcher_stat_snapshots"("sportKey", "pitcherId", "snapshotDate");
