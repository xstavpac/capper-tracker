-- AlterTable
ALTER TABLE "game_results" ADD COLUMN "quartersJson" JSONB;
ALTER TABLE "game_results" ADD COLUMN "scoringPlaysJson" JSONB;
ALTER TABLE "game_results" ADD COLUMN "homeTurnovers" INTEGER;
ALTER TABLE "game_results" ADD COLUMN "awayTurnovers" INTEGER;
