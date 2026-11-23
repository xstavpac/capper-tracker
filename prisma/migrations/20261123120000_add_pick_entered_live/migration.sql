-- A pick imported while its game was already in progress (bulk-import-core resolveGameAndOdds). Additive, constant
-- default: every existing row reads false (no backfill - forward only).
ALTER TABLE "picks" ADD COLUMN IF NOT EXISTS "enteredLive" BOOLEAN NOT NULL DEFAULT false;

-- Telegram ingest: a pick matched to a game far after the message (lib/far-future-game.ts) waits for review.
ALTER TYPE "IngestQuestionType" ADD VALUE IF NOT EXISTS 'FAR_FUTURE_GAME';
