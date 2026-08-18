-- CreateTable
CREATE TABLE "decay_delta_predictions" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL DEFAULT 'decay-delta-v1',
    "gameResultId" TEXT,
    "sportKey" TEXT NOT NULL,
    "homeTeam" TEXT NOT NULL,
    "awayTeam" TEXT NOT NULL,
    "gameDate" TIMESTAMP(3) NOT NULL,
    "favTeam" TEXT NOT NULL,
    "dogTeam" TEXT NOT NULL,
    "totalLine" DOUBLE PRECISION,
    "favRate" DOUBLE PRECISION NOT NULL,
    "dogRate" DOUBLE PRECISION NOT NULL,
    "delta" DOUBLE PRECISION NOT NULL,
    "bucket" TEXT NOT NULL,
    "overRate" DOUBLE PRECISION,
    "underRate" DOUBLE PRECISION,
    "totalDelta" DOUBLE PRECISION,
    "totalBucket" TEXT,
    "favWon" BOOLEAN,
    "wentOver" BOOLEAN,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "gradedAt" TIMESTAMP(3),

    CONSTRAINT "decay_delta_predictions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "decay_delta_predictions_modelId_sportKey_homeTeam_awayTeam__key" ON "decay_delta_predictions"("modelId", "sportKey", "homeTeam", "awayTeam", "gameDate");
