-- CreateTable
CREATE TABLE "heavy_consensus_markets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "worldKey" TEXT NOT NULL,
    "sport" TEXT NOT NULL,
    "gameDate" TEXT NOT NULL,
    "gameTime" TIMESTAMP(3) NOT NULL,
    "market" TEXT NOT NULL,
    "heavySide" TEXT NOT NULL,
    "cappers" INTEGER NOT NULL,
    "heavyCappers" INTEGER NOT NULL,
    "sharePct" INTEGER NOT NULL,
    "band" TEXT NOT NULL,
    "outcome" TEXT,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "heavy_consensus_markets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "heavy_consensus_markets_gameDate_idx" ON "heavy_consensus_markets"("gameDate");

-- CreateIndex
CREATE UNIQUE INDEX "heavy_consensus_markets_userId_worldKey_key" ON "heavy_consensus_markets"("userId", "worldKey");

-- AddForeignKey
ALTER TABLE "heavy_consensus_markets" ADD CONSTRAINT "heavy_consensus_markets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same as every other table (see 20260915120000_enable_rls_on_all_tables and
-- 20261027090000_add_odds_alt_ladders): no policies, so only the server's own
-- connection reads or writes it.
ALTER TABLE "heavy_consensus_markets" ENABLE ROW LEVEL SECURITY;
