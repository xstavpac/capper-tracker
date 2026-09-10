-- CreateTable
CREATE TABLE "team_record_snapshots" (
    "id" TEXT NOT NULL,
    "sportKey" TEXT NOT NULL,
    "teamName" TEXT NOT NULL,
    "snapshotDate" TEXT NOT NULL,
    "wins" INTEGER NOT NULL,
    "losses" INTEGER NOT NULL,
    "ties" INTEGER NOT NULL,
    "winPct" DOUBLE PRECISION NOT NULL,
    "homeWins" INTEGER NOT NULL,
    "homeLosses" INTEGER NOT NULL,
    "awayWins" INTEGER NOT NULL,
    "awayLosses" INTEGER NOT NULL,
    "last10Wins" INTEGER NOT NULL,
    "last10Losses" INTEGER NOT NULL,
    "streakType" TEXT,
    "streakCount" INTEGER NOT NULL,
    "gamesInRecord" INTEGER NOT NULL,
    "sourceId" TEXT NOT NULL DEFAULT 'internal_record',
    "scope" "DataScope" NOT NULL DEFAULT 'GLOBAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_record_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "situational_rate_snapshots" (
    "id" TEXT NOT NULL,
    "sportKey" TEXT NOT NULL,
    "teamName" TEXT NOT NULL,
    "questionKey" TEXT NOT NULL,
    "snapshotDate" TEXT NOT NULL,
    "wins" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "sourceId" TEXT NOT NULL DEFAULT 'internal_situational',
    "scope" "DataScope" NOT NULL DEFAULT 'GLOBAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "situational_rate_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "team_record_snapshots_sportKey_teamName_snapshotDate_key" ON "team_record_snapshots"("sportKey", "teamName", "snapshotDate");

-- CreateIndex
CREATE UNIQUE INDEX "situational_rate_snapshots_sportKey_teamName_questionKey_sn_key" ON "situational_rate_snapshots"("sportKey", "teamName", "questionKey", "snapshotDate");
