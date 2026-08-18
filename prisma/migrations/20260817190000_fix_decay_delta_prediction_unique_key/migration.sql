-- DropIndex
DROP INDEX "decay_delta_predictions_modelId_sportKey_homeTeam_awayTeam__key";

-- CreateIndex
CREATE UNIQUE INDEX "decay_delta_predictions_modelId_gameResultId_key" ON "decay_delta_predictions"("modelId", "gameResultId");
