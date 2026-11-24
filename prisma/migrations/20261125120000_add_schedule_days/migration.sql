-- 7-day schedule store: one row per (league, Eastern date), upserted once a day
-- by refresh-scores (schedule-store.ts). Additive only.

-- CreateTable
CREATE TABLE "schedule_days" (
    "id" TEXT NOT NULL,
    "sportKey" TEXT NOT NULL,
    "gameDate" TEXT NOT NULL,
    "games" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_days_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "schedule_days_sportKey_gameDate_key" ON "schedule_days"("sportKey", "gameDate");

-- RLS on, no policies (project convention, rls-guard-acceptance-test.ts): the app
-- connects as the owning role; PostgREST anon/authenticated get nothing.
ALTER TABLE "schedule_days" ENABLE ROW LEVEL SECURITY;
