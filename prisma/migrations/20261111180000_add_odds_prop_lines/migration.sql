-- NBA player-prop prices bought at import (server/data/prop-line-odds.ts). Two new tables, kept out of
-- odds_snapshots so the day's game-odds row stays the same size. Nothing existing is altered; no backfill.

-- CreateTable
CREATE TABLE "odds_prop_fetches" (
    "id" TEXT NOT NULL,
    "sportKey" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "marketKey" TEXT NOT NULL,
    "commenceTime" TIMESTAMP(3) NOT NULL,
    "bucket" INTEGER NOT NULL,
    "fetchedAt" TIMESTAMP(3),
    "linesStored" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "odds_prop_fetches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "odds_prop_lines" (
    "id" TEXT NOT NULL,
    "fetchId" TEXT NOT NULL,
    "bookOrder" INTEGER NOT NULL,
    "bookKey" TEXT NOT NULL,
    "playerName" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "point" DOUBLE PRECISION,
    "price" INTEGER NOT NULL,
    "bookLastUpdate" TIMESTAMP(3),

    CONSTRAINT "odds_prop_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "odds_prop_fetches_eventId_marketKey_createdAt_idx" ON "odds_prop_fetches"("eventId", "marketKey", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "odds_prop_fetches_eventId_marketKey_bucket_key" ON "odds_prop_fetches"("eventId", "marketKey", "bucket");

-- CreateIndex
CREATE INDEX "odds_prop_lines_fetchId_side_point_idx" ON "odds_prop_lines"("fetchId", "side", "point");

-- AddForeignKey
ALTER TABLE "odds_prop_lines" ADD CONSTRAINT "odds_prop_lines_fetchId_fkey" FOREIGN KEY ("fetchId") REFERENCES "odds_prop_fetches"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Same as every other table (see 20260915120000_enable_rls_on_all_tables): no policies, so only the server's own
-- connection reads or writes them.
ALTER TABLE "odds_prop_fetches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "odds_prop_lines" ENABLE ROW LEVEL SECURITY;
