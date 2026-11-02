-- Posted-odds capture (PR 1): four nullable columns on picks, and the append-only fresh-fetch table.
--
-- picks: ADD COLUMN with no default and no NOT NULL is a catalog-only change in Postgres (no table rewrite, no
-- scan), so it is instant whatever the row count. Existing rows stay NULL; nothing is backfilled.
ALTER TABLE "picks" ADD COLUMN "postedLine" DOUBLE PRECISION;
ALTER TABLE "picks" ADD COLUMN "oddsCapturedAt" TIMESTAMP(3);
ALTER TABLE "picks" ADD COLUMN "oddsBook" TEXT;
ALTER TABLE "picks" ADD COLUMN "oddsNullReason" TEXT;

-- odds_fresh_fetches: a new table, so RLS is enabled with no policies (the app reaches it through Prisma on the
-- service connection only).
CREATE TABLE "odds_fresh_fetches" (
    "id" TEXT NOT NULL,
    "sportKey" TEXT NOT NULL,
    "bucket" INTEGER NOT NULL,
    "fetchedAt" TIMESTAMP(3),
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "odds_fresh_fetches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "odds_fresh_fetches_sportKey_bucket_key" ON "odds_fresh_fetches"("sportKey", "bucket");
CREATE INDEX "odds_fresh_fetches_sportKey_fetchedAt_idx" ON "odds_fresh_fetches"("sportKey", "fetchedAt");

ALTER TABLE "odds_fresh_fetches" ENABLE ROW LEVEL SECURITY;
