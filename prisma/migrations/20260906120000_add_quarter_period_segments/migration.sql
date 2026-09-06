-- Add quarter / hockey-period / second-half values to the Period enum, and a
-- sport-generic per-segment linescore column on game_results.
-- Enum values are added with IF NOT EXISTS and are not referenced anywhere in
-- this migration file, so there is no "new enum value used in same
-- transaction" hazard.

ALTER TYPE "Period" ADD VALUE IF NOT EXISTS 'SECOND_HALF';
ALTER TYPE "Period" ADD VALUE IF NOT EXISTS 'FIRST_QUARTER';
ALTER TYPE "Period" ADD VALUE IF NOT EXISTS 'SECOND_QUARTER';
ALTER TYPE "Period" ADD VALUE IF NOT EXISTS 'THIRD_QUARTER';
ALTER TYPE "Period" ADD VALUE IF NOT EXISTS 'FOURTH_QUARTER';
ALTER TYPE "Period" ADD VALUE IF NOT EXISTS 'FIRST_PERIOD';
ALTER TYPE "Period" ADD VALUE IF NOT EXISTS 'SECOND_PERIOD';
ALTER TYPE "Period" ADD VALUE IF NOT EXISTS 'THIRD_PERIOD';

-- AlterTable
ALTER TABLE "game_results" ADD COLUMN "linescoreJson" JSONB;
