-- WRITES picks. Wrong-game fuzzy-match regrade: the 19 rows (4 picks x copies) graded off a DIFFERENT game whose
-- nicknames collide, found by the read-only scan on 2026-11-23 (see the PR). None of the four real finals is in
-- game_results (NCAAB stores a final only while a pick on it is pending), so each grade is from ESPN's final:
--   LSU Tigers 90 - 50 Louisiana Tech Bulldogs            ESPN 401921810  (was graded off Mississippi St 98 - 57 Jackson St)
--   San José State Spartans 92 - 86 Fresno State Bulldogs ESPN 401911473  (was graded off Gardner-Webb 72 - 78 UNC Greensboro)
--   Michigan State Spartans 91 - 70 Detroit Mercy Titans  ESPN 401925756  (was graded off UNC Greensboro 85 - 66 USC Upstate)
--   South Carolina Upstate Spartans 64 - 74 Samford       ESPN 401922283  (was graded off Gardner-Webb 72 - 78 UNC Greensboro)
-- Every row: status = the real final's grade (computed with the app's resolveOutcome), gradedViaFuzzyMatch = NULL
-- (an ESPN-verified correction, which regradeFuzzyMatchedPicks never re-checks). Guarded by the old status AND
-- gradedViaFuzzyMatch = true. 6 statuses change (3 WIN->LOSS, 3 LOSS->WIN); 13 keep theirs.
-- One statement: raises (and so rolls back) unless exactly 19 rows are updated and all 19 then read as expected.
DO $$
DECLARE
  updated int;
  ok int;
BEGIN
  CREATE TEMP TABLE wrong_game_fix(id text PRIMARY KEY, old_status text, new_status text) ON COMMIT DROP;
  INSERT INTO wrong_game_fix VALUES
    -- LSU -29.5 / -30.5 (LSU by 40): WIN stays WIN
    ('cmw9p0aey000bmg91hl8vsi4o','WIN','WIN'), ('cmw9p0ab90004mg91wnknbl66','WIN','WIN'),
    ('cmw9p177z003jmg91dazlig77','WIN','WIN'), ('cmw9p17bz003omg91cs18iio5','WIN','WIN'),
    -- Samford / USC Upstate over 148.5 (real total 138): WIN -> LOSS
    ('cmwmp9juc00b0sd9lyauoq4x5','WIN','LOSS'), ('cmwmp9k4j00basd9l00xa8zut','WIN','LOSS'), ('cmwmp9k0c00b5sd9ldz49estf','WIN','LOSS'),
    -- Fresno State +6.5 (lost by 6): WIN stays WIN
    ('cmwmg130102b827akt0xaux8s','WIN','WIN'), ('cmwmg132l02be27akuc3nxau7','WIN','WIN'), ('cmwmg12wq02b227akk7l9k3be','WIN','WIN'),
    -- Fresno State over 153.5 (real total 178): LOSS -> WIN
    ('cmwmw157m0009incx8udbmrl9','LOSS','WIN'), ('cmwmw150j0007incxt90zajyj','LOSS','WIN'), ('cmwmw15bq000bincx6qg2yaks','LOSS','WIN'),
    -- San José State -6.5 (won by 6): LOSS stays LOSS
    ('cmwmi98fd0019s35vmqyq7qr4','LOSS','LOSS'), ('cmwmi987y000vs35v0socponf','LOSS','LOSS'), ('cmwmi98by0012s35v0kvk5933','LOSS','LOSS'),
    -- Detroit Mercy +40.5 (lost by 21): WIN stays WIN
    ('cmwqkeafg00xlyfo1mo8ipr7q','WIN','WIN'), ('cmwqkealr00xxyfo13qbrw7mo','WIN','WIN'), ('cmwqkeaj600xryfo1gg25fd9n','WIN','WIN');

  UPDATE picks p
  SET status = f.new_status::"PickStatus", "gradedViaFuzzyMatch" = NULL, "updatedAt" = now()
  FROM wrong_game_fix f
  WHERE p.id = f.id AND p.status = f.old_status::"PickStatus" AND p."gradedViaFuzzyMatch" = true;
  GET DIAGNOSTICS updated = ROW_COUNT;

  SELECT count(*) INTO ok FROM picks p JOIN wrong_game_fix f ON f.id = p.id
  WHERE p.status = f.new_status::"PickStatus" AND p."gradedViaFuzzyMatch" IS NULL;

  RAISE NOTICE 'updated=% verified=% (expected 19/19; status changes: 3 WIN->LOSS, 3 LOSS->WIN)', updated, ok;
  IF updated <> 19 OR ok <> 19 THEN
    RAISE EXCEPTION 'count check failed: updated=% verified=% (expected 19/19) - rolled back', updated, ok;
  END IF;
END $$;
