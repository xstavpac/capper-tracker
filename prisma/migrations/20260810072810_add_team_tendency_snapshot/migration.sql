-- CreateTable
CREATE TABLE "team_tendency_snapshots" (
    "id" TEXT NOT NULL,
    "sportKey" TEXT NOT NULL,
    "teamName" TEXT NOT NULL,
    "snapshotDate" TEXT NOT NULL,
    "favWins" INTEGER NOT NULL,
    "favLosses" INTEGER NOT NULL,
    "favPushes" INTEGER NOT NULL,
    "dogWins" INTEGER NOT NULL,
    "dogLosses" INTEGER NOT NULL,
    "dogPushes" INTEGER NOT NULL,
    "overCount" INTEGER NOT NULL,
    "underCount" INTEGER NOT NULL,
    "totalPushCount" INTEGER NOT NULL,
    "sourceId" TEXT NOT NULL DEFAULT 'internal_tendencies',
    "scope" "DataScope" NOT NULL DEFAULT 'GLOBAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_tendency_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "team_tendency_snapshots_sportKey_teamName_snapshotDate_key" ON "team_tendency_snapshots"("sportKey", "teamName", "snapshotDate");
