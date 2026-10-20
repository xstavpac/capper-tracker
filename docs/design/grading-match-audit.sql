-- Grading-match audit (MLB postponed-game phantom finals).
-- READ-ONLY: SELECTs only. Run each block (A-E) on its own in the Supabase SQL editor.
-- Timestamps are timestamp(3) without time zone, in UTC, the way Prisma stores them.

-- A. Phantom 0-0 "finals". MLB StatsAPI (abstractGameState=Final) and ESPN
--    (state=post) both report a postponed/cancelled game as final, and
--    persistFinalScores wrote it as 0-0. A real 0-0 final can't happen in MLB or NHL.
SELECT "sportKey", "externalId", "awayTeam" || ' @ ' || "homeTeam" AS game,
       "gameDate", "createdAt", "homeScore", "awayScore"
FROM game_results
WHERE "homeScore" = 0 AND "awayScore" = 0
ORDER BY "gameDate" DESC;

-- B. GameResult rows for the 33 postponed/cancelled MLB gamePks. A makeup
--    played under the same gamePk updated the score but not gameDate (written
--    on create only), so these rows carry the ORIGINAL start time.
SELECT "externalId", "awayTeam" || ' @ ' || "homeTeam" AS game, "gameDate", "createdAt",
       "awayScore" || '-' || "homeScore" AS "away-home"
FROM game_results
WHERE "sportKey" = 'baseball_mlb'
  AND "externalId" IN ('831608','831612','831455','824621','824134','824460','823637','823471','824850','823062','824362','824766','824518','823543','824840','824514','823539','824589','824424','824911','824664','823613','823042','823357','824414','823523','823519','824735','824490','823598','824785','823490','849817')
ORDER BY "gameDate";

-- C. Every graded single pick, replayed through today's exact-match rule.
--    Flags:
--      phantom_0_0            matched row is 0-0 right now (postponed/cancelled, never replayed)
--      slot_graded_maybe_0_0  gameTime within 6h of a postponed slot's original start
--                             (849817's is 2026-10-17 00:00 UTC) and graded before that
--                             row's 0-0 could have been overwritten by the makeup score
--      slot_graded_off_makeup same slot, graded after the makeup: real score, but from the makeup game
--      no_exact               no same-orientation row within 6h (graded via fuzzy or an older matcher)
--      reversed_close         a reversed-orientation row also sits within 6h
--      multi_exact            2+ same-orientation rows within 6h (doubleheader)
--      drift_gt_1h            nearest exact row is more than 1h from the pick's gameTime
--    Just the 849817 slot: add  AND slot_pk = '849817'  to the final WHERE.
WITH sk AS (
  SELECT id, name, CASE name WHEN 'MLB' THEN 'baseball_mlb' WHEN 'NFL' THEN 'americanfootball_nfl'
    WHEN 'NBA' THEN 'basketball_nba' WHEN 'NHL' THEN 'icehockey_nhl' WHEN 'NCAAF' THEN 'americanfootball_ncaaf'
    WHEN 'WNBA' THEN 'basketball_wnba' WHEN 'NCAAB' THEN 'basketball_ncaab' END AS key
  FROM sports
),
-- MLB gamePks that StatsAPI lists as abstractGameState=Final with codedGameState
-- D (postponed) or C (cancelled), 2026-03-01..2026-10-20, fetched live 2026-10-20.
-- orig = the postponed slot's start; makeup_end = when the same-gamePk makeup
-- ended (last play's endTime; NULL = cancelled, never replayed). Until about
-- makeup_end, the GameResult row for that gamePk was a 0-0 "final" at orig.
slots(pk, away, home, orig, makeup_end) AS (VALUES
    ('831608', 'New York Yankees', 'Baltimore Orioles', timestamp '2026-03-15T22:05:00', NULL::timestamp),
    ('831612', 'Boston Red Sox', 'Baltimore Orioles', timestamp '2026-03-16T22:05:00', NULL::timestamp),
    ('831455', 'Miami Marlins', 'Washington Nationals', timestamp '2026-03-18T22:05:00', NULL::timestamp),
    ('824621', 'Toronto Blue Jays', 'Chicago White Sox', timestamp '2026-04-02T20:10:00', timestamp '2026-04-03T21:07:25'),
    ('824134', 'Milwaukee Brewers', 'Kansas City Royals', timestamp '2026-04-03T23:45:00', timestamp '2026-04-05T01:56:28'),
    ('824460', 'Chicago Cubs', 'Cleveland Guardians', timestamp '2026-04-04T23:15:00', timestamp '2026-04-05T23:32:59'),
    ('823637', 'Colorado Rockies', 'New York Mets', timestamp '2026-04-25T20:10:00', timestamp '2026-04-26T23:27:02'),
    ('823471', 'San Francisco Giants', 'Philadelphia Phillies', timestamp '2026-04-29T22:10:00', timestamp '2026-05-01T01:15:02'),
    ('824850', 'Houston Astros', 'Baltimore Orioles', timestamp '2026-04-29T22:35:00', timestamp '2026-04-30T22:38:10'),
    ('823062', 'Milwaukee Brewers', 'St. Louis Cardinals', timestamp '2026-05-05T23:45:00', timestamp '2026-07-07T20:53:55'),
    ('824362', 'New York Mets', 'Colorado Rockies', timestamp '2026-05-06T00:40:00', timestamp '2026-05-07T22:00:32'),
    ('824766', 'Tampa Bay Rays', 'Boston Red Sox', timestamp '2026-05-09T20:10:00', timestamp '2026-07-17T19:54:38'),
    ('824518', 'St. Louis Cardinals', 'Cincinnati Reds', timestamp '2026-05-22T22:40:00', timestamp '2026-05-23T19:50:26'),
    ('823543', 'Tampa Bay Rays', 'New York Yankees', timestamp '2026-05-23T17:35:00', timestamp '2026-09-22T19:10:18'),
    ('824840', 'Detroit Tigers', 'Baltimore Orioles', timestamp '2026-05-23T20:05:00', timestamp '2026-05-25T00:33:28'),
    ('824514', 'St. Louis Cardinals', 'Cincinnati Reds', timestamp '2026-05-24T17:40:00', timestamp '2026-08-17T20:23:14'),
    ('823539', 'Boston Red Sox', 'New York Yankees', timestamp '2026-06-06T23:35:00', timestamp '2026-08-29T20:01:54'),
    ('824589', 'Atlanta Braves', 'Chicago White Sox', timestamp '2026-06-11T23:40:00', timestamp '2026-08-20T20:33:46'),
    ('824424', 'Detroit Tigers', 'Cleveland Guardians', timestamp '2026-06-14T17:40:00', timestamp '2026-09-04T21:56:44'),
    ('824911', 'San Francisco Giants', 'Atlanta Braves', timestamp '2026-06-18T23:15:00', timestamp '2026-09-01T00:30:40'),
    ('824664', 'Toronto Blue Jays', 'Chicago Cubs', timestamp '2026-06-21T18:20:00', timestamp '2026-08-06T21:41:01'),
    ('823613', 'Chicago Cubs', 'New York Mets', timestamp '2026-06-22T23:10:00', timestamp '2026-06-24T19:52:45'),
    ('823042', 'Arizona Diamondbacks', 'St. Louis Cardinals', timestamp '2026-06-25T23:45:00', timestamp '2026-07-24T00:09:36'),
    ('823357', 'Milwaukee Brewers', 'Pittsburgh Pirates', timestamp '2026-07-10T22:40:00', timestamp '2026-07-11T18:56:31'),
    ('824414', 'Pittsburgh Pirates', 'Cleveland Guardians', timestamp '2026-07-17T23:10:00', timestamp '2026-07-18T19:33:00'),
    ('823523', 'Los Angeles Dodgers', 'New York Yankees', timestamp '2026-07-19T00:08:00', timestamp '2026-07-19T19:40:11'),
    ('823519', 'Pittsburgh Pirates', 'New York Yankees', timestamp '2026-07-21T23:05:00', timestamp '2026-07-23T01:31:58'),
    ('824735', 'Baltimore Orioles', 'Boston Red Sox', timestamp '2026-07-21T23:10:00', timestamp '2026-07-22T19:54:16'),
    ('824490', 'Cleveland Guardians', 'Cincinnati Reds', timestamp '2026-07-27T23:10:00', timestamp '2026-07-28T20:36:45'),
    ('823598', 'Atlanta Braves', 'New York Mets', timestamp '2026-07-28T23:10:00', timestamp '2026-07-30T01:39:31'),
    ('824785', 'Toronto Blue Jays', 'Baltimore Orioles', timestamp '2026-09-22T22:35:00', timestamp '2026-09-23T20:14:26'),
    ('823490', 'Baltimore Orioles', 'New York Yankees', timestamp '2026-09-27T17:05:00', NULL::timestamp),
    ('849817', 'Tampa Bay Rays', 'Cleveland Guardians', timestamp '2026-10-17T00:00:00', timestamp '2026-10-18T23:58:15')
),
src AS (
  SELECT p.id, p."sportId", p.status::text AS status, p."betType"::text AS bet, p."betDetail",
         p."awayTeam", p."homeTeam", p."gameTime", p."gameNumber", p."gradedAt", p."gradedViaFuzzyMatch", p."createdAt"
  FROM picks p
  WHERE p.status IN ('WIN', 'LOSS', 'PUSH')
),
g AS (
  SELECT src.*, sk.name AS sport,
    (SELECT count(*) FROM game_results r WHERE r."sportKey" = sk.key AND r."homeTeam" = src."homeTeam" AND r."awayTeam" = src."awayTeam"
       AND abs(extract(epoch FROM r."gameDate" - src."gameTime")) <= 21600) AS exact_6h,
    (SELECT round((min(abs(extract(epoch FROM r."gameDate" - src."gameTime"))) / 3600)::numeric, 2) FROM game_results r WHERE r."sportKey" = sk.key
       AND r."homeTeam" = src."homeTeam" AND r."awayTeam" = src."awayTeam"
       AND abs(extract(epoch FROM r."gameDate" - src."gameTime")) <= 21600) AS exact_drift_h,
    (SELECT bool_or(r."homeScore" = 0 AND r."awayScore" = 0) FROM game_results r WHERE r."sportKey" = sk.key
       AND r."homeTeam" = src."homeTeam" AND r."awayTeam" = src."awayTeam"
       AND abs(extract(epoch FROM r."gameDate" - src."gameTime")) <= 21600) AS exact_is_0_0,
    (SELECT count(*) FROM game_results r WHERE r."sportKey" = sk.key AND r."homeTeam" = src."awayTeam" AND r."awayTeam" = src."homeTeam"
       AND abs(extract(epoch FROM r."gameDate" - src."gameTime")) <= 21600) AS reversed_6h,
    (SELECT count(*) FROM game_results r WHERE r."sportKey" = sk.key
       AND ((r."homeTeam" = src."homeTeam" AND r."awayTeam" = src."awayTeam") OR (r."homeTeam" = src."awayTeam" AND r."awayTeam" = src."homeTeam"))
       AND abs(extract(epoch FROM r."gameDate" - src."gameTime")) <= 172800) AS same_teams_2d,
    sl.pk AS slot_pk, sl.orig AS slot_orig, sl.makeup_end AS slot_makeup_end
  FROM src
  JOIN sk ON sk.id = src."sportId"
  LEFT JOIN LATERAL (
    SELECT * FROM slots s
    WHERE sk.name = 'MLB'
      AND ((s.home = src."homeTeam" AND s.away = src."awayTeam") OR (s.home = src."awayTeam" AND s.away = src."homeTeam"))
      AND abs(extract(epoch FROM src."gameTime" - s.orig)) <= 21600
    LIMIT 1
  ) sl ON true
  WHERE sk.key IS NOT NULL
)
SELECT 'pick' AS kind, *,
  (exact_is_0_0 IS TRUE) AS phantom_0_0,
  -- in a postponed slot and graded before the makeup's score could have
  -- replaced the 0-0 (2h buffer for the cron to pick the final up)
  (slot_pk IS NOT NULL AND (slot_makeup_end IS NULL OR "gradedAt" < slot_makeup_end + interval '2 hours')) AS slot_graded_maybe_0_0,
  -- in a postponed slot but graded after the makeup: real score, from the makeup game
  (slot_pk IS NOT NULL AND slot_makeup_end IS NOT NULL AND "gradedAt" >= slot_makeup_end + interval '2 hours') AS slot_graded_off_makeup,
  (exact_6h = 0) AS no_exact,
  (reversed_6h > 0) AS reversed_close,
  (exact_6h > 1) AS multi_exact,
  (exact_drift_h > 1) AS drift_gt_1h
FROM g
WHERE exact_is_0_0 IS TRUE OR slot_pk IS NOT NULL OR exact_6h = 0 OR reversed_6h > 0 OR exact_6h > 1 OR exact_drift_h > 1
ORDER BY "gameTime" DESC;

-- D. The 7 stuck picks: when each was created, compared with the games.
--    Settles whether "Guardians vs. Rays +0.5" (stored CLE @ TB 10/20 00:08)
--    was posted for Game 5 (the makeup, 10/18 21:08) or for Game 6.
SELECT id, "betType"::text, "betDetail", "awayTeam" || ' @ ' || "homeTeam" AS pick_game, "gameTime",
       "gameNumber", "datePosted", "createdAt", "pickedSide"::text, line
FROM picks
WHERE status = 'PENDING' AND "gameTime" BETWEEN '2026-10-18' AND '2026-10-21'
  AND ("homeTeam" IN ('Cleveland Guardians', 'Tampa Bay Rays') OR "awayTeam" IN ('Cleveland Guardians', 'Tampa Bay Rays'));

-- E. Parlay legs: same replay and flags as C. Legs carry no gameNumber, so
--    multi_exact on an MLB leg is a doubleheader the leg can't tell apart.
WITH sk AS (
  SELECT id, name, CASE name WHEN 'MLB' THEN 'baseball_mlb' WHEN 'NFL' THEN 'americanfootball_nfl'
    WHEN 'NBA' THEN 'basketball_nba' WHEN 'NHL' THEN 'icehockey_nhl' WHEN 'NCAAF' THEN 'americanfootball_ncaaf'
    WHEN 'WNBA' THEN 'basketball_wnba' WHEN 'NCAAB' THEN 'basketball_ncaab' END AS key
  FROM sports
),
-- MLB gamePks that StatsAPI lists as abstractGameState=Final with codedGameState
-- D (postponed) or C (cancelled), 2026-03-01..2026-10-20, fetched live 2026-10-20.
-- orig = the postponed slot's start; makeup_end = when the same-gamePk makeup
-- ended (last play's endTime; NULL = cancelled, never replayed). Until about
-- makeup_end, the GameResult row for that gamePk was a 0-0 "final" at orig.
slots(pk, away, home, orig, makeup_end) AS (VALUES
    ('831608', 'New York Yankees', 'Baltimore Orioles', timestamp '2026-03-15T22:05:00', NULL::timestamp),
    ('831612', 'Boston Red Sox', 'Baltimore Orioles', timestamp '2026-03-16T22:05:00', NULL::timestamp),
    ('831455', 'Miami Marlins', 'Washington Nationals', timestamp '2026-03-18T22:05:00', NULL::timestamp),
    ('824621', 'Toronto Blue Jays', 'Chicago White Sox', timestamp '2026-04-02T20:10:00', timestamp '2026-04-03T21:07:25'),
    ('824134', 'Milwaukee Brewers', 'Kansas City Royals', timestamp '2026-04-03T23:45:00', timestamp '2026-04-05T01:56:28'),
    ('824460', 'Chicago Cubs', 'Cleveland Guardians', timestamp '2026-04-04T23:15:00', timestamp '2026-04-05T23:32:59'),
    ('823637', 'Colorado Rockies', 'New York Mets', timestamp '2026-04-25T20:10:00', timestamp '2026-04-26T23:27:02'),
    ('823471', 'San Francisco Giants', 'Philadelphia Phillies', timestamp '2026-04-29T22:10:00', timestamp '2026-05-01T01:15:02'),
    ('824850', 'Houston Astros', 'Baltimore Orioles', timestamp '2026-04-29T22:35:00', timestamp '2026-04-30T22:38:10'),
    ('823062', 'Milwaukee Brewers', 'St. Louis Cardinals', timestamp '2026-05-05T23:45:00', timestamp '2026-07-07T20:53:55'),
    ('824362', 'New York Mets', 'Colorado Rockies', timestamp '2026-05-06T00:40:00', timestamp '2026-05-07T22:00:32'),
    ('824766', 'Tampa Bay Rays', 'Boston Red Sox', timestamp '2026-05-09T20:10:00', timestamp '2026-07-17T19:54:38'),
    ('824518', 'St. Louis Cardinals', 'Cincinnati Reds', timestamp '2026-05-22T22:40:00', timestamp '2026-05-23T19:50:26'),
    ('823543', 'Tampa Bay Rays', 'New York Yankees', timestamp '2026-05-23T17:35:00', timestamp '2026-09-22T19:10:18'),
    ('824840', 'Detroit Tigers', 'Baltimore Orioles', timestamp '2026-05-23T20:05:00', timestamp '2026-05-25T00:33:28'),
    ('824514', 'St. Louis Cardinals', 'Cincinnati Reds', timestamp '2026-05-24T17:40:00', timestamp '2026-08-17T20:23:14'),
    ('823539', 'Boston Red Sox', 'New York Yankees', timestamp '2026-06-06T23:35:00', timestamp '2026-08-29T20:01:54'),
    ('824589', 'Atlanta Braves', 'Chicago White Sox', timestamp '2026-06-11T23:40:00', timestamp '2026-08-20T20:33:46'),
    ('824424', 'Detroit Tigers', 'Cleveland Guardians', timestamp '2026-06-14T17:40:00', timestamp '2026-09-04T21:56:44'),
    ('824911', 'San Francisco Giants', 'Atlanta Braves', timestamp '2026-06-18T23:15:00', timestamp '2026-09-01T00:30:40'),
    ('824664', 'Toronto Blue Jays', 'Chicago Cubs', timestamp '2026-06-21T18:20:00', timestamp '2026-08-06T21:41:01'),
    ('823613', 'Chicago Cubs', 'New York Mets', timestamp '2026-06-22T23:10:00', timestamp '2026-06-24T19:52:45'),
    ('823042', 'Arizona Diamondbacks', 'St. Louis Cardinals', timestamp '2026-06-25T23:45:00', timestamp '2026-07-24T00:09:36'),
    ('823357', 'Milwaukee Brewers', 'Pittsburgh Pirates', timestamp '2026-07-10T22:40:00', timestamp '2026-07-11T18:56:31'),
    ('824414', 'Pittsburgh Pirates', 'Cleveland Guardians', timestamp '2026-07-17T23:10:00', timestamp '2026-07-18T19:33:00'),
    ('823523', 'Los Angeles Dodgers', 'New York Yankees', timestamp '2026-07-19T00:08:00', timestamp '2026-07-19T19:40:11'),
    ('823519', 'Pittsburgh Pirates', 'New York Yankees', timestamp '2026-07-21T23:05:00', timestamp '2026-07-23T01:31:58'),
    ('824735', 'Baltimore Orioles', 'Boston Red Sox', timestamp '2026-07-21T23:10:00', timestamp '2026-07-22T19:54:16'),
    ('824490', 'Cleveland Guardians', 'Cincinnati Reds', timestamp '2026-07-27T23:10:00', timestamp '2026-07-28T20:36:45'),
    ('823598', 'Atlanta Braves', 'New York Mets', timestamp '2026-07-28T23:10:00', timestamp '2026-07-30T01:39:31'),
    ('824785', 'Toronto Blue Jays', 'Baltimore Orioles', timestamp '2026-09-22T22:35:00', timestamp '2026-09-23T20:14:26'),
    ('823490', 'Baltimore Orioles', 'New York Yankees', timestamp '2026-09-27T17:05:00', NULL::timestamp),
    ('849817', 'Tampa Bay Rays', 'Cleveland Guardians', timestamp '2026-10-17T00:00:00', timestamp '2026-10-18T23:58:15')
),
src AS (
  SELECT l.id, l."sportId", l.status::text AS status, l."betType"::text AS bet, l."betDetail",
         l."awayTeam", l."homeTeam", l."gameTime", NULL::int AS "gameNumber", l."gradedAt", l."gradedViaFuzzyMatch", l."createdAt",
         l."parlayBetId", l."legIndex"
  FROM legs l
  WHERE l.status IN ('WIN', 'LOSS', 'PUSH')
),
g AS (
  SELECT src.*, sk.name AS sport,
    (SELECT count(*) FROM game_results r WHERE r."sportKey" = sk.key AND r."homeTeam" = src."homeTeam" AND r."awayTeam" = src."awayTeam"
       AND abs(extract(epoch FROM r."gameDate" - src."gameTime")) <= 21600) AS exact_6h,
    (SELECT round((min(abs(extract(epoch FROM r."gameDate" - src."gameTime"))) / 3600)::numeric, 2) FROM game_results r WHERE r."sportKey" = sk.key
       AND r."homeTeam" = src."homeTeam" AND r."awayTeam" = src."awayTeam"
       AND abs(extract(epoch FROM r."gameDate" - src."gameTime")) <= 21600) AS exact_drift_h,
    (SELECT bool_or(r."homeScore" = 0 AND r."awayScore" = 0) FROM game_results r WHERE r."sportKey" = sk.key
       AND r."homeTeam" = src."homeTeam" AND r."awayTeam" = src."awayTeam"
       AND abs(extract(epoch FROM r."gameDate" - src."gameTime")) <= 21600) AS exact_is_0_0,
    (SELECT count(*) FROM game_results r WHERE r."sportKey" = sk.key AND r."homeTeam" = src."awayTeam" AND r."awayTeam" = src."homeTeam"
       AND abs(extract(epoch FROM r."gameDate" - src."gameTime")) <= 21600) AS reversed_6h,
    (SELECT count(*) FROM game_results r WHERE r."sportKey" = sk.key
       AND ((r."homeTeam" = src."homeTeam" AND r."awayTeam" = src."awayTeam") OR (r."homeTeam" = src."awayTeam" AND r."awayTeam" = src."homeTeam"))
       AND abs(extract(epoch FROM r."gameDate" - src."gameTime")) <= 172800) AS same_teams_2d,
    sl.pk AS slot_pk, sl.orig AS slot_orig, sl.makeup_end AS slot_makeup_end
  FROM src
  JOIN sk ON sk.id = src."sportId"
  LEFT JOIN LATERAL (
    SELECT * FROM slots s
    WHERE sk.name = 'MLB'
      AND ((s.home = src."homeTeam" AND s.away = src."awayTeam") OR (s.home = src."awayTeam" AND s.away = src."homeTeam"))
      AND abs(extract(epoch FROM src."gameTime" - s.orig)) <= 21600
    LIMIT 1
  ) sl ON true
  WHERE sk.key IS NOT NULL
)
SELECT 'leg' AS kind, *,
  (exact_is_0_0 IS TRUE) AS phantom_0_0,
  -- in a postponed slot and graded before the makeup's score could have
  -- replaced the 0-0 (2h buffer for the cron to pick the final up)
  (slot_pk IS NOT NULL AND (slot_makeup_end IS NULL OR "gradedAt" < slot_makeup_end + interval '2 hours')) AS slot_graded_maybe_0_0,
  -- in a postponed slot but graded after the makeup: real score, from the makeup game
  (slot_pk IS NOT NULL AND slot_makeup_end IS NOT NULL AND "gradedAt" >= slot_makeup_end + interval '2 hours') AS slot_graded_off_makeup,
  (exact_6h = 0) AS no_exact,
  (reversed_6h > 0) AS reversed_close,
  (exact_6h > 1) AS multi_exact,
  (exact_drift_h > 1) AS drift_gt_1h
FROM g
WHERE exact_is_0_0 IS TRUE OR slot_pk IS NOT NULL OR exact_6h = 0 OR reversed_6h > 0 OR exact_6h > 1 OR exact_drift_h > 1
ORDER BY "gameTime" DESC;
