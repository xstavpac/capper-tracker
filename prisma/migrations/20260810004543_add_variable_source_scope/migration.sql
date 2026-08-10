-- CreateEnum
CREATE TYPE "DataScope" AS ENUM ('GLOBAL', 'PER_USER');

-- AlterTable
ALTER TABLE "team_tendencies" ADD COLUMN     "scope" "DataScope" NOT NULL DEFAULT 'GLOBAL',
ADD COLUMN     "sourceId" TEXT NOT NULL DEFAULT 'internal_tendencies';
