-- CreateTable
CREATE TABLE "odds_alt_line_fetches" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "marketKey" TEXT NOT NULL,
    "fetchDate" TEXT NOT NULL,
    "sportKey" TEXT NOT NULL,
    "bookmakers" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "odds_alt_line_fetches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "odds_alt_line_fetches_eventId_marketKey_fetchDate_key" ON "odds_alt_line_fetches"("eventId", "marketKey", "fetchDate");

-- Same as every other table (see 20260915120000_enable_rls_on_all_tables): no
-- policies, so only the server's own connection reads or writes it.
ALTER TABLE "odds_alt_line_fetches" ENABLE ROW LEVEL SECURITY;
