-- CreateTable
CREATE TABLE "nfl_rushing_rows" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "team" TEXT NOT NULL,
    "espnPlayerId" TEXT,
    "playerName" TEXT NOT NULL,
    "carries" INTEGER NOT NULL,
    "rushingYards" INTEGER NOT NULL,
    "yardsPerCarry" DOUBLE PRECISION NOT NULL,
    "touchdowns" INTEGER NOT NULL,
    "long" INTEGER NOT NULL,
    "sourceId" TEXT NOT NULL DEFAULT 'espn_nfl_summary',
    "scope" "DataScope" NOT NULL DEFAULT 'GLOBAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nfl_rushing_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nfl_receiving_rows" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "team" TEXT NOT NULL,
    "espnPlayerId" TEXT,
    "playerName" TEXT NOT NULL,
    "receptions" INTEGER NOT NULL,
    "receivingYards" INTEGER NOT NULL,
    "yardsPerReception" DOUBLE PRECISION NOT NULL,
    "touchdowns" INTEGER NOT NULL,
    "long" INTEGER NOT NULL,
    "targets" INTEGER NOT NULL,
    "sourceId" TEXT NOT NULL DEFAULT 'espn_nfl_summary',
    "scope" "DataScope" NOT NULL DEFAULT 'GLOBAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nfl_receiving_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "nfl_rushing_rows_externalId_idx" ON "nfl_rushing_rows"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "nfl_rushing_rows_externalId_team_playerName_key" ON "nfl_rushing_rows"("externalId", "team", "playerName");

-- CreateIndex
CREATE INDEX "nfl_receiving_rows_externalId_idx" ON "nfl_receiving_rows"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "nfl_receiving_rows_externalId_team_playerName_key" ON "nfl_receiving_rows"("externalId", "team", "playerName");
