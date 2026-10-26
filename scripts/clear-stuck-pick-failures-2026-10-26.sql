-- One-off, to run BY HAND (Supabase SQL editor) AFTER the o/u shorthand fix has
-- deployed. Clears the grading-failure rows of exactly two picks so the grader
-- looks at them again:
--
--   cmvn01op10001w84iw6s7d7v0   NHL  TOTAL       "LEAFS / OILERS O6.5"
--   cmvmpax0a001a141f5n7scnfn   NCAAF TEAM_TOTAL  "Ole Miss TT o24.5"
--
-- Both are PENDING with a matched final (the line and side are stored correctly);
-- the grader just could not read "O6.5" / "o24.5" as a side. Their rows are at
-- the retry cap (attempts 128 and 147, nextAttemptAt = 9999-12-31, read from
-- prod 2026-10-26), so without this they would not be tried again after the fix.
-- On the next grade-picks run (every 15 minutes) they should grade; if the fix
-- worked their rows are deleted by the grading pass itself.
--
-- Deletes by pickId only. It does not touch the picks.

-- 1. Preview: the two picks, their status and their failure rows (expect 2 rows,
--    both PENDING, with attempts 128 / 147).
SELECT p.id, p."betType", p."betDetail", p.status, f.attempts, f."nextAttemptAt"
FROM picks p
LEFT JOIN pick_grade_failures f ON f."pickId" = p.id
WHERE p.id IN ('cmvn01op10001w84iw6s7d7v0', 'cmvmpax0a001a141f5n7scnfn');

-- 2. Delete (expect "2 rows").
DELETE FROM pick_grade_failures
WHERE "pickId" IN ('cmvn01op10001w84iw6s7d7v0', 'cmvmpax0a001a141f5n7scnfn');

-- 3. Afterwards (a few minutes later): both should be graded, with no failure row.
-- SELECT p.id, p.status, p."gradedAt", f."pickId" AS failure_row
-- FROM picks p
-- LEFT JOIN pick_grade_failures f ON f."pickId" = p.id
-- WHERE p.id IN ('cmvn01op10001w84iw6s7d7v0', 'cmvmpax0a001a141f5n7scnfn');
