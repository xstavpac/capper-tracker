-- Soft delete for the four roster cache tables. The daily roster refresh
-- (/api/cron/refresh-rosters) marks a player no longer on any roster
-- active = false + removedAt instead of deleting the row, and reactivates him
-- if he reappears. Import name matching reads active rows only; grading reads
-- every row, so a pending prop on a released or traded player still grades.
-- Additive: existing rows become active = true, removedAt = NULL.
ALTER TABLE "nfl_roster_players" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true, ADD COLUMN "removedAt" TIMESTAMP(3);
ALTER TABLE "nhl_roster_players" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true, ADD COLUMN "removedAt" TIMESTAMP(3);
ALTER TABLE "nba_roster_players" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true, ADD COLUMN "removedAt" TIMESTAMP(3);
ALTER TABLE "mlb_roster_players" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true, ADD COLUMN "removedAt" TIMESTAMP(3);
