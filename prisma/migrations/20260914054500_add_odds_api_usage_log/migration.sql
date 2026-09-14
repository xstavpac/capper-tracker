-- CreateTable
CREATE TABLE "odds_api_usage_log" (
    "id" TEXT NOT NULL,
    "sportKey" TEXT NOT NULL,
    "pollTimestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creditsUsed" INTEGER,
    "creditsRemaining" INTEGER,
    "requestsToday" INTEGER NOT NULL,
    "requestsMonth" INTEGER NOT NULL,
    "marketsRequested" TEXT NOT NULL,
    "eventsRequested" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "odds_api_usage_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "odds_api_usage_log_pollTimestamp_idx" ON "odds_api_usage_log"("pollTimestamp");

-- CreateIndex
CREATE INDEX "odds_api_usage_log_sportKey_pollTimestamp_idx" ON "odds_api_usage_log"("sportKey", "pollTimestamp");
