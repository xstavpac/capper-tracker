-- CreateTable
CREATE TABLE "game_starters" (
    "id" TEXT NOT NULL,
    "sportKey" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "homeTeam" TEXT NOT NULL,
    "awayTeam" TEXT NOT NULL,
    "gameDate" TIMESTAMP(3) NOT NULL,
    "homeProbablePitcherId" INTEGER,
    "homeProbablePitcherName" TEXT,
    "awayProbablePitcherId" INTEGER,
    "awayProbablePitcherName" TEXT,
    "homeStartingPitcherId" INTEGER,
    "homeStartingPitcherName" TEXT,
    "awayStartingPitcherId" INTEGER,
    "awayStartingPitcherName" TEXT,
    "startersConfirmedAt" TIMESTAMP(3),
    "sourceId" TEXT NOT NULL DEFAULT 'mlb_stats_api',
    "scope" "DataScope" NOT NULL DEFAULT 'GLOBAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_starters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "game_starters_sportKey_gameDate_idx" ON "game_starters"("sportKey", "gameDate");

-- CreateIndex
CREATE UNIQUE INDEX "game_starters_sportKey_externalId_key" ON "game_starters"("sportKey", "externalId");
