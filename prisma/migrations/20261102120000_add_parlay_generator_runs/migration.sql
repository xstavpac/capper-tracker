-- CreateEnum
CREATE TYPE "ParlayRunMode" AS ENUM ('STANDARD', 'YOUR_PICKS', 'HYBRID');

-- CreateEnum
CREATE TYPE "ParlayRunTrigger" AS ENUM ('GENERATE', 'REGENERATE', 'FETCH');

-- CreateTable
CREATE TABLE "parlay_generator_runs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mode" "ParlayRunMode" NOT NULL,
    "trigger" "ParlayRunTrigger" NOT NULL,
    "origin" TEXT NOT NULL,
    "scoringVersion" TEXT NOT NULL,
    "settings" JSONB NOT NULL,
    "stages" JSONB NOT NULL,
    "reasons" JSONB NOT NULL,
    "errors" JSONB,
    "extras" JSONB,
    "detail" JSONB,
    "detailTruncated" BOOLEAN NOT NULL DEFAULT false,
    "traceFailed" BOOLEAN NOT NULL DEFAULT false,
    "durationMs" INTEGER,

    CONSTRAINT "parlay_generator_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "parlay_generator_runs_createdAt_idx" ON "parlay_generator_runs"("createdAt");

-- CreateIndex
CREATE INDEX "parlay_generator_runs_userId_createdAt_idx" ON "parlay_generator_runs"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "parlay_generator_runs" ADD CONSTRAINT "parlay_generator_runs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Same as every other table (see 20260915120000_enable_rls_on_all_tables): no
-- policies, so only the server's own connection reads or writes it.
ALTER TABLE "parlay_generator_runs" ENABLE ROW LEVEL SECURITY;
