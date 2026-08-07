-- AlterTable
ALTER TABLE "picks" ADD COLUMN     "gradedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "picks_userId_gradedAt_idx" ON "picks"("userId", "gradedAt");

-- Backfill: for picks graded before this column existed, updatedAt is the
-- closest approximation of when they were graded (nothing else touched a
-- Pick row post-creation prior to this migration).
UPDATE "picks" SET "gradedAt" = "updatedAt" WHERE status IN ('WIN', 'LOSS', 'PUSH') AND "gradedAt" IS NULL;
