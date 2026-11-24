-- Feed health (ops console): last success / last error per (feed, league), one
-- row each, upserted once per sync cron run. Additive only.

-- CreateTable
CREATE TABLE "feed_syncs" (
    "feed" TEXT NOT NULL,
    "sportKey" TEXT NOT NULL,
    "lastSuccessAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feed_syncs_pkey" PRIMARY KEY ("feed","sportKey")
);
