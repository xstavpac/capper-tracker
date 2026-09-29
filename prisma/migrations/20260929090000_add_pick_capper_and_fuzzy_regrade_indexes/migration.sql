-- 1. FK support index. The picks -> cappers foreign key is ON DELETE CASCADE, so
--    deleting a capper (deleteCapper, and the duplicate side of mergeCappers)
--    makes Postgres find that capper's picks by "capperId" alone. Every existing
--    picks index leads with "userId" or "sportId", so that lookup was a seq scan.
--    Name matches what Prisma generates for @@index([capperId]).
CREATE INDEX "picks_capperId_idx" ON "picks"("capperId");

-- 2. Partial index for regradeAllFuzzyMatchedPicks (grading.ts):
--      WHERE "sportId" = ? AND status IN ('WIN','LOSS','PUSH')
--        AND "gradedViaFuzzyMatch" = true AND "gameTime" >= ?
--      ORDER BY "gameTime" DESC LIMIT ?
--    Only fuzzy-graded rows are indexed (a small, shrinking minority: each row
--    leaves the index the moment it is upgraded or manually graded).
--    RAW SQL: Prisma 5's schema language cannot express a partial index, so this
--    index is not in schema.prisma and `prisma migrate dev`/`migrate diff` will
--    want to drop it - see docs/partial-indexes.md.
CREATE INDEX "picks_fuzzy_regrade_idx" ON "picks"("sportId", "gameTime") WHERE "gradedViaFuzzyMatch" = true;
