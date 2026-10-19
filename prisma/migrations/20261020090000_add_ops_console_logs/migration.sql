-- CreateEnum
CREATE TYPE "CronRunStatus" AS ENUM ('RUNNING', 'OK', 'WARNING', 'ERROR');

-- AlterTable
ALTER TABLE "odds_api_usage_log" ADD COLUMN     "caller" TEXT,
ADD COLUMN     "httpStatus" INTEGER;

-- CreateTable
CREATE TABLE "cron_runs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "status" "CronRunStatus" NOT NULL DEFAULT 'RUNNING',
    "httpStatus" INTEGER,
    "rowsTouched" INTEGER,
    "summary" JSONB,
    "error" TEXT,

    CONSTRAINT "cron_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pick_grade_failures" (
    "pickId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "gameResultId" TEXT,
    "finalSeenAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pick_grade_failures_pkey" PRIMARY KEY ("pickId")
);

-- CreateTable
CREATE TABLE "import_runs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "itemsSubmitted" INTEGER NOT NULL,
    "picksInserted" INTEGER NOT NULL,
    "skipped" INTEGER NOT NULL,
    "fallbackUnmatched" INTEGER NOT NULL,
    "fallbackPicks" JSONB,
    "ambiguousAuto" INTEGER NOT NULL DEFAULT 0,
    "ambiguousAsked" INTEGER NOT NULL DEFAULT 0,
    "ambiguity" JSONB,

    CONSTRAINT "import_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cron_runs_name_startedAt_idx" ON "cron_runs"("name", "startedAt");

-- CreateIndex
CREATE INDEX "pick_grade_failures_finalSeenAt_idx" ON "pick_grade_failures"("finalSeenAt");

-- CreateIndex
CREATE INDEX "import_runs_createdAt_idx" ON "import_runs"("createdAt");

-- AddForeignKey
ALTER TABLE "pick_grade_failures" ADD CONSTRAINT "pick_grade_failures_pickId_fkey" FOREIGN KEY ("pickId") REFERENCES "picks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

