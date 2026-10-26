-- One-time cleanup of pick_grade_failures, to run BY HAND (Supabase SQL editor)
-- after the retry-backoff PR has deployed. Not part of the migration.
--
-- Before the backoff, a failure row was never deleted when its pick graded, and
-- picks for games days away were written up as "no final game matched" on
-- every 15-minute run. Prod, 2026-10-26: 1,386 rows, 1,381 of them for picks
-- that are no longer PENDING. The code now drops a pick's row when it grades
-- (or is graded by hand), so this only clears what built up before.
--
-- Deletes by pickId only. It removes the rows of
--   - picks that are no longer PENDING (nothing left to explain), and
--   - PENDING picks whose game has not started (their attempt counts were
--     inflated by retries that could never have succeeded; left in place they
--     would reach the 30-attempt cap before the game is played).
-- It keeps rows for PENDING picks whose game has started: those are the real
-- stuck picks the Grading tab lists.

-- 1. Preview: what would go.
SELECT p.status, (p."gameTime" > now()) AS game_not_started, count(*) AS rows
FROM pick_grade_failures f
JOIN picks p ON p.id = f."pickId"
WHERE p.status <> 'PENDING' OR p."gameTime" > now()
GROUP BY 1, 2
ORDER BY 3 DESC;

-- 2. Delete (re-run the preview afterwards: it should return no rows).
DELETE FROM pick_grade_failures
WHERE "pickId" IN (
  SELECT f."pickId"
  FROM pick_grade_failures f
  JOIN picks p ON p.id = f."pickId"
  WHERE p.status <> 'PENDING' OR p."gameTime" > now()
);
