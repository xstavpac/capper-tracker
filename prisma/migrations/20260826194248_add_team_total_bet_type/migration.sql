-- Adds TEAM_TOTAL as a new BetType enum value, alongside the existing TOTAL.
-- A team total (one team's own score vs a line) is a different market than
-- a game total (both teams combined) and must grade independently - see
-- gradePick in grading.ts. Existing rows are untouched by this migration;
-- no row is retroactively changed from TOTAL to TEAM_TOTAL here (that would
-- be a data correction, handled separately, not a schema migration).
ALTER TYPE "BetType" ADD VALUE 'TEAM_TOTAL';
