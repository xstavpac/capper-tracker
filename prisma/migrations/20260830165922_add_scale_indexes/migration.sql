-- DropIndex
DROP INDEX "legs_sportId_status_idx";

-- DropIndex
DROP INDEX "picks_sportId_status_idx";

-- CreateIndex
CREATE INDEX "game_results_sportKey_gameDate_idx" ON "game_results"("sportKey", "gameDate");

-- CreateIndex
CREATE INDEX "legs_sportId_status_gameTime_idx" ON "legs"("sportId", "status", "gameTime");

-- CreateIndex
CREATE INDEX "picks_sportId_status_gameTime_idx" ON "picks"("sportId", "status", "gameTime");

-- CreateIndex
CREATE INDEX "subscriptions_stripeCustomerId_idx" ON "subscriptions"("stripeCustomerId");
