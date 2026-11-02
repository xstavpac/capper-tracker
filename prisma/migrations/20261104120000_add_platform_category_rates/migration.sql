-- Platform win and break-even totals per league + bet type + key: the rollup the Parlay Generator's scoring
-- module falls back on (lib/parlay/scoring.ts, server/data/platform-category-rates.ts). `key` is a pick's
-- category, or its PropMarketKey for a prop with one. Aggregates only: no user, capper or pick identity.
--
-- A new, empty table: no scan and no lock on picks. Filled by the nightly refresh-scores cron. Nothing reads it
-- yet.
CREATE TABLE "platform_category_rates" (
    "id" TEXT NOT NULL,
    "league" TEXT NOT NULL,
    "betType" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "wins" INTEGER NOT NULL,
    "losses" INTEGER NOT NULL,
    "impliedSum" DOUBLE PRECISION NOT NULL,
    "priced" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_category_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_category_rates_league_betType_key_key" ON "platform_category_rates"("league", "betType", "key");

-- Same as every other table (see 20260915120000_enable_rls_on_all_tables): no
-- policies, so only the server's own connection reads or writes it.
ALTER TABLE "platform_category_rates" ENABLE ROW LEVEL SECURITY;
