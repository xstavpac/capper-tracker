-- AlterEnum
ALTER TYPE "BetType" ADD VALUE 'NRFI';

-- AlterTable
ALTER TABLE "game_results" ADD COLUMN     "firstInningAwayScore" INTEGER,
ADD COLUMN     "firstInningHomeScore" INTEGER;
