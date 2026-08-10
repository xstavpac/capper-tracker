-- CreateTable
CREATE TABLE "game_starters" (
    "id" TEXT NOT NULL,
    "sportKey" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "homeTeam" TEXT NOT NULL,
    "awayTeam" TEXT NOT NULL,
    "homePitcherId" INTEGER,
    "awayPitcherId" INTEGER,
    "gameDate" TIMESTAMP(3) NOT NULL,
    "sourceId" TEXT NOT NULL DEFAULT 'mlb_stats_api',
    "scope" "DataScope" NOT NULL DEFAULT 'GLOBAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_starters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "game_starters_sportKey_externalId_key" ON "game_starters"("sportKey", "externalId");
