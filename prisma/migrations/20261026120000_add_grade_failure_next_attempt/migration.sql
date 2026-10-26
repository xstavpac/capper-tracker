-- AlterTable
ALTER TABLE "pick_grade_failures" ADD COLUMN     "nextAttemptAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "pick_grade_failures_nextAttemptAt_idx" ON "pick_grade_failures"("nextAttemptAt");
