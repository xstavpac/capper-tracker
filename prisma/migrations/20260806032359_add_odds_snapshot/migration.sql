-- CreateTable
CREATE TABLE "odds_snapshots" (
    "id" TEXT NOT NULL,
    "sportKey" TEXT NOT NULL,
    "fetchDate" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "odds_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "odds_snapshots_sportKey_fetchDate_key" ON "odds_snapshots"("sportKey", "fetchDate");
