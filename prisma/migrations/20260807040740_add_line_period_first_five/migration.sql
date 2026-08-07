-- CreateEnum
CREATE TYPE "Period" AS ENUM ('FULL_GAME', 'FIRST_HALF');

-- AlterTable
ALTER TABLE "game_results" ADD COLUMN     "firstFiveAwayScore" INTEGER,
ADD COLUMN     "firstFiveHomeScore" INTEGER;

-- AlterTable
ALTER TABLE "picks" ADD COLUMN     "line" DOUBLE PRECISION,
ADD COLUMN     "period" "Period" NOT NULL DEFAULT 'FULL_GAME';
