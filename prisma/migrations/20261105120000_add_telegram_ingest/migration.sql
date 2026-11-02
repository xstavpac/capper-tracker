-- Telegram pick ingest (PR 1b): the raw-batch table, the review queue, and two skip stages.
--
-- Two new skip stages for the ingest path. ADD VALUE is catalog-only; nothing uses the new values inside this
-- migration, so it is safe in the migration's transaction.
ALTER TYPE "ImportSkipStage" ADD VALUE 'LEAGUE_NOT_ALLOWED';
ALTER TYPE "ImportSkipStage" ADD VALUE 'COMBINED_BET';

CREATE TYPE "IngestBatchStatus" AS ENUM ('RECEIVED', 'IMPORTED', 'PARTIAL', 'FAILED');
CREATE TYPE "IngestQuestionType" AS ENUM ('AMBIGUOUS_TEAM', 'PLAYER_AMBIGUITY', 'MISSING_TOTAL_LINE', 'CAPPER_FUZZY');
CREATE TYPE "IngestReviewStatus" AS ENUM ('PENDING', 'RESOLVED', 'DISMISSED');

CREATE TABLE "ingest_batches" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" INTEGER NOT NULL,
    "day" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" "IngestBatchStatus" NOT NULL DEFAULT 'RECEIVED',
    "importedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "pendingReviewCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ingest_batches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ingest_review_items" (
    "id" TEXT NOT NULL,
    "ingestBatchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "capperName" TEXT NOT NULL,
    "lineText" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "questionType" "IngestQuestionType" NOT NULL,
    "options" JSONB NOT NULL,
    "status" "IngestReviewStatus" NOT NULL DEFAULT 'PENDING',
    "resolvedPickId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ingest_review_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ingest_batches_channelId_messageId_key" ON "ingest_batches"("channelId", "messageId");
CREATE INDEX "ingest_batches_createdAt_idx" ON "ingest_batches"("createdAt");
CREATE INDEX "ingest_review_items_userId_status_idx" ON "ingest_review_items"("userId", "status");
CREATE INDEX "ingest_review_items_ingestBatchId_idx" ON "ingest_review_items"("ingestBatchId");

ALTER TABLE "ingest_review_items" ADD CONSTRAINT "ingest_review_items_ingestBatchId_fkey" FOREIGN KEY ("ingestBatchId") REFERENCES "ingest_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ingest_review_items" ADD CONSTRAINT "ingest_review_items_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Server-only tables (reached through Prisma on the service connection): RLS on, no policies.
ALTER TABLE "ingest_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ingest_review_items" ENABLE ROW LEVEL SECURITY;
