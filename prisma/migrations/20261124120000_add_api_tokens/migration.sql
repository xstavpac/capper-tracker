-- Bot API tokens, PR 1 of the bot-tokens plan: schema only, no app behavior changes.
--   api_tokens            - a user's tokens for POST /api/v1/picks (SHA-256 hex only, never the raw token)
--   api_pick_submissions  - one row per (token, client_id): idempotent resends
--   screenshot_read_usage - Catalog Import screenshot reads per user per Eastern-time day
--   ingest_batches        - now also holds API_TOKEN batches (sourceType / tokenId / sourceKey); channelId and
--                           messageId become nullable. Existing rows backfill to TELEGRAM through the column default.

-- CreateEnum
CREATE TYPE "IngestSourceType" AS ENUM ('TELEGRAM', 'API_TOKEN');

-- CreateEnum
CREATE TYPE "ApiPickSubmissionStatus" AS ENUM ('ACCEPTED', 'NEEDS_REVIEW', 'REJECTED', 'DISMISSED');

-- AlterTable
ALTER TABLE "ingest_batches" ADD COLUMN     "sourceKey" TEXT,
ADD COLUMN     "sourceType" "IngestSourceType" NOT NULL DEFAULT 'TELEGRAM',
ADD COLUMN     "tokenId" TEXT,
ALTER COLUMN "channelId" DROP NOT NULL,
ALTER COLUMN "messageId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "api_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "prefix" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "windowCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_pick_submissions" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "status" "ApiPickSubmissionStatus" NOT NULL,
    "pickId" TEXT,
    "reviewItemId" TEXT,
    "reason" TEXT,
    "batchId" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_pick_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "screenshot_read_usage" (
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "screenshot_read_usage_pkey" PRIMARY KEY ("userId","day")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_tokens_tokenHash_key" ON "api_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "api_tokens_userId_idx" ON "api_tokens"("userId");

-- CreateIndex
CREATE INDEX "api_pick_submissions_tokenId_createdAt_idx" ON "api_pick_submissions"("tokenId", "createdAt");

-- CreateIndex
CREATE INDEX "api_pick_submissions_batchId_idx" ON "api_pick_submissions"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "api_pick_submissions_tokenId_clientId_key" ON "api_pick_submissions"("tokenId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "ingest_batches_sourceKey_key" ON "ingest_batches"("sourceKey");

-- AddForeignKey
ALTER TABLE "ingest_batches" ADD CONSTRAINT "ingest_batches_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "api_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_pick_submissions" ADD CONSTRAINT "api_pick_submissions_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "api_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_pick_submissions" ADD CONSTRAINT "api_pick_submissions_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ingest_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "screenshot_read_usage" ADD CONSTRAINT "screenshot_read_usage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Each source carries its own keys. Every existing row is TELEGRAM (the default) with channelId and messageId set
-- (both were NOT NULL until this migration), so it passes.
-- API_TOKEN needs sourceKey, not tokenId: tokenId is ON DELETE SET NULL, and a CHECK requiring it would make deleting
-- the token (and so the user, which cascades to api_tokens) fail. The app sets tokenId on every API_TOKEN insert.
ALTER TABLE "ingest_batches" ADD CONSTRAINT "ingest_batches_source_check" CHECK (
  ("sourceType" = 'TELEGRAM' AND "channelId" IS NOT NULL AND "messageId" IS NOT NULL)
  OR ("sourceType" = 'API_TOKEN' AND "sourceKey" IS NOT NULL)
);

-- Server-only tables (reached through Prisma on the service connection): RLS on, no policies.
ALTER TABLE "api_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "api_pick_submissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "screenshot_read_usage" ENABLE ROW LEVEL SECURITY;
