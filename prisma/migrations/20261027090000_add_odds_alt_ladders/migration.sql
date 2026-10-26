-- CreateTable
CREATE TABLE "odds_alt_ladders" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "marketKey" TEXT NOT NULL,
    "commenceTime" TIMESTAMP(3) NOT NULL,
    "outcomes" JSONB,
    "fetchedAt" TIMESTAMP(3),
    "marketLastUpdate" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "odds_alt_ladders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "odds_alt_ladders_commenceTime_idx" ON "odds_alt_ladders"("commenceTime");

-- CreateIndex
CREATE UNIQUE INDEX "odds_alt_ladders_eventId_marketKey_key" ON "odds_alt_ladders"("eventId", "marketKey");


-- Same as every other table (see 20260915120000_enable_rls_on_all_tables and
-- 20261026140000_add_bug_reports): no policies, so only the server's own
-- connection reads or writes it.
ALTER TABLE "odds_alt_ladders" ENABLE ROW LEVEL SECURITY;
