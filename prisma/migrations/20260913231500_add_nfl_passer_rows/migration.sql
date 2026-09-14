-- CreateTable
CREATE TABLE "nfl_passer_rows" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "team" TEXT NOT NULL,
    "espnPlayerId" TEXT,
    "playerName" TEXT NOT NULL,
    "completions" INTEGER NOT NULL,
    "attempts" INTEGER NOT NULL,
    "passingYards" INTEGER NOT NULL,
    "yardsPerAttempt" DOUBLE PRECISION NOT NULL,
    "touchdowns" INTEGER NOT NULL,
    "interceptions" INTEGER NOT NULL,
    "sacks" INTEGER NOT NULL,
    "sackYardsLost" INTEGER NOT NULL,
    "qbr" DOUBLE PRECISION,
    "rating" DOUBLE PRECISION NOT NULL,
    "sourceId" TEXT NOT NULL DEFAULT 'espn_nfl_summary',
    "scope" "DataScope" NOT NULL DEFAULT 'GLOBAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nfl_passer_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "nfl_passer_rows_externalId_idx" ON "nfl_passer_rows"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "nfl_passer_rows_externalId_team_playerName_key" ON "nfl_passer_rows"("externalId", "team", "playerName");
