-- READ-ONLY. Neutral-site wrong-team grading scan (follow-up to #521 / the grading fix PR).
--
-- Every graded team-side pick (MONEYLINE / SPREAD / TEAM_TOTAL, any period, any sport, all time) with a stored
-- pickedSide whose score row lists its teams the other way round - the rows matchGameResult's fuzzy fallback hands
-- to resolveOutcome when no same-orientation row exists. For each: the grade the OLD code gave (pickedSide by
-- position on the score row) and the grade by TEAM NAME (pickedSide is the pick row's own team, found on the
-- reversed row), plus the stored status.
--
-- BROAD on purpose: orientation by team nickname (last word), reversed one way and not the other - a superset of
-- the fix's strict (full-name) reversal. Run 2026-11-23 it returned the 24 genuine rows (all exact full-name
-- reversals; see neutral-site-regrade-apply.sql) plus 10 rows whose "reversed" row is a DIFFERENT game whose
-- mascots collide (LSU Tigers / Louisiana Tech Bulldogs -> Mississippi State Bulldogs / Jackson State Tigers;
-- San José State Spartans / Fresno State Bulldogs -> Gardner-Webb Runnin' Bulldogs / UNC Greensboro Spartans).
-- Those are a matcher problem, not an orientation one: their by_team column is meaningless and they are NOT regraded.
WITH sk(name, key) AS (
  VALUES ('NFL', 'americanfootball_nfl'), ('NBA', 'basketball_nba'), ('MLB', 'baseball_mlb'), ('NHL', 'icehockey_nhl'),
         ('WNBA', 'basketball_wnba'), ('NCAAF', 'americanfootball_ncaaf'), ('NCAAB', 'basketball_ncaab'), ('CFL', 'americanfootball_cfl')
),
p AS (
  SELECT p.id, p."userId", p."isRecipientCopy", p."sourcePickId", s.name AS sport, sk.key, p."betType"::text AS bt, p.period::text AS per,
         p."homeTeam" AS ph, p."awayTeam" AS pa, p."pickedSide"::text AS side, p.line, p."betDetail" AS detail, p.status::text AS status,
         p."gameTime", p."gameNumber"
  FROM picks p
  JOIN sports s ON s.id = p."sportId"
  JOIN sk ON sk.name = s.name
  WHERE p.status IN ('WIN', 'LOSS', 'PUSH')
    AND p."betType" IN ('MONEYLINE', 'SPREAD', 'TEAM_TOTAL')
    AND p."pickedSide" IN ('HOME', 'AWAY')
),
nick AS (
  SELECT g.*, lower(regexp_replace(g."homeTeam", '^.*\s', '')) AS hn, lower(regexp_replace(g."awayTeam", '^.*\s', '')) AS an
  FROM game_results g
),
cand AS (
  SELECT p.*, g.id AS gid, g."homeTeam" AS gh, g."awayTeam" AS ga, g."homeScore" AS hs, g."awayScore" AS aws,
         g."firstFiveHomeScore" AS fh, g."firstFiveAwayScore" AS fa, g."linescoreJson" AS ls,
         (strpos(lower(p.ph), g.an) > 0 AND strpos(lower(p.pa), g.hn) > 0) AS rev,
         (strpos(lower(p.ph), g.hn) > 0 AND strpos(lower(p.pa), g.an) > 0) AS same,
         abs(extract(epoch FROM g."gameDate" - p."gameTime")) AS drift
  FROM p
  JOIN nick g ON g."sportKey" = p.key
             AND abs(extract(epoch FROM g."gameDate" - p."gameTime")) <= 6 * 3600
             AND (p."gameNumber" IS NULL OR g."gameNumber" = p."gameNumber")
),
-- The row grading used: no exact same-orientation row (the exact branch would win) and no same-orientation
-- nickname candidate (the fuzzy branch prefers it); then the nearest reversed one.
chosen AS (
  SELECT DISTINCT ON (c.id) c.*
  FROM cand c
  WHERE c.rev AND NOT c.same
    AND NOT EXISTS (SELECT 1 FROM cand x WHERE x.id = c.id AND (x.same AND NOT x.rev))
    AND NOT EXISTS (
      SELECT 1 FROM game_results e
      WHERE e."sportKey" = c.key AND e."homeTeam" = c.ph AND e."awayTeam" = c.pa
        AND abs(extract(epoch FROM e."gameDate" - c."gameTime")) <= 6 * 3600
    )
  ORDER BY c.id, c.drift
),
seg AS (
  SELECT c.*,
    CASE
      WHEN c.key = 'basketball_ncaab' AND c.per NOT IN ('FULL_GAME', 'FIRST_HALF', 'SECOND_HALF') THEN NULL
      WHEN c.per = 'FULL_GAME' THEN c.hs
      WHEN c.per = 'FIRST_HALF' THEN c.fh
      WHEN c.per = 'SECOND_HALF' THEN c.hs - c.fh
      WHEN c.per IN ('FIRST_QUARTER', 'FIRST_PERIOD') THEN (c.ls -> 0 ->> 'home')::int
      WHEN c.per IN ('SECOND_QUARTER', 'SECOND_PERIOD') THEN (c.ls -> 1 ->> 'home')::int
      WHEN c.per IN ('THIRD_QUARTER', 'THIRD_PERIOD') THEN (c.ls -> 2 ->> 'home')::int
      WHEN c.per = 'FOURTH_QUARTER' THEN (c.ls -> 3 ->> 'home')::int
      WHEN c.per = 'REGULATION' THEN (c.ls -> 0 ->> 'home')::int + (c.ls -> 1 ->> 'home')::int + (c.ls -> 2 ->> 'home')::int
    END AS sh,
    CASE
      WHEN c.key = 'basketball_ncaab' AND c.per NOT IN ('FULL_GAME', 'FIRST_HALF', 'SECOND_HALF') THEN NULL
      WHEN c.per = 'FULL_GAME' THEN c.aws
      WHEN c.per = 'FIRST_HALF' THEN c.fa
      WHEN c.per = 'SECOND_HALF' THEN c.aws - c.fa
      WHEN c.per IN ('FIRST_QUARTER', 'FIRST_PERIOD') THEN (c.ls -> 0 ->> 'away')::int
      WHEN c.per IN ('SECOND_QUARTER', 'SECOND_PERIOD') THEN (c.ls -> 1 ->> 'away')::int
      WHEN c.per IN ('THIRD_QUARTER', 'THIRD_PERIOD') THEN (c.ls -> 2 ->> 'away')::int
      WHEN c.per = 'FOURTH_QUARTER' THEN (c.ls -> 3 ->> 'away')::int
      WHEN c.per = 'REGULATION' THEN (c.ls -> 0 ->> 'away')::int + (c.ls -> 1 ->> 'away')::int + (c.ls -> 2 ->> 'away')::int
    END AS sa,
    -- the line: the stored one, else the text's (the code's extractLine fallback; flagged in line_from_text)
    COALESCE(c.line, CASE WHEN c.bt = 'SPREAD' THEN substring(c.detail FROM '([+-]\d+(?:\.\d+)?)')::float
                          ELSE substring(c.detail FROM '(\d+(?:\.\d+)?)')::float END) AS ln,
    c.line IS NULL AS line_from_text,
    CASE WHEN c.detail ~* '\m(over|o)\s*\d|\mover\M' THEN 'OVER' WHEN c.detail ~* '\m(under|u)\s*\d|\munder\M' THEN 'UNDER' END AS ou
  FROM chosen c
),
graded AS (
  SELECT s.*,
    -- team score / opponent score: by position (old) and by team (pick HOME = the row's AWAY on a reversed row)
    CASE WHEN s.side = 'HOME' THEN s.sh ELSE s.sa END AS pos_ts, CASE WHEN s.side = 'HOME' THEN s.sa ELSE s.sh END AS pos_os,
    CASE WHEN s.side = 'HOME' THEN s.sa ELSE s.sh END AS team_ts, CASE WHEN s.side = 'HOME' THEN s.sh ELSE s.sa END AS team_os
  FROM seg s
),
result AS (
  SELECT g.*,
    CASE
      WHEN g.sh IS NULL OR g.sa IS NULL THEN NULL
      WHEN g.bt = 'MONEYLINE' THEN CASE WHEN g.pos_ts > g.pos_os THEN 'WIN' WHEN g.pos_ts < g.pos_os THEN 'LOSS' WHEN g.per = 'REGULATION' THEN 'LOSS' ELSE 'PUSH' END
      WHEN g.bt = 'SPREAD' AND g.ln IS NOT NULL THEN CASE WHEN g.pos_ts + g.ln > g.pos_os THEN 'WIN' WHEN g.pos_ts + g.ln < g.pos_os THEN 'LOSS' ELSE 'PUSH' END
      WHEN g.bt = 'TEAM_TOTAL' AND g.ln IS NOT NULL AND g.ou = 'OVER' THEN CASE WHEN g.pos_ts > g.ln THEN 'WIN' WHEN g.pos_ts < g.ln THEN 'LOSS' ELSE 'PUSH' END
      WHEN g.bt = 'TEAM_TOTAL' AND g.ln IS NOT NULL AND g.ou = 'UNDER' THEN CASE WHEN g.pos_ts < g.ln THEN 'WIN' WHEN g.pos_ts > g.ln THEN 'LOSS' ELSE 'PUSH' END
    END AS by_position,
    CASE
      WHEN g.sh IS NULL OR g.sa IS NULL THEN NULL
      WHEN g.bt = 'MONEYLINE' THEN CASE WHEN g.team_ts > g.team_os THEN 'WIN' WHEN g.team_ts < g.team_os THEN 'LOSS' WHEN g.per = 'REGULATION' THEN 'LOSS' ELSE 'PUSH' END
      WHEN g.bt = 'SPREAD' AND g.ln IS NOT NULL THEN CASE WHEN g.team_ts + g.ln > g.team_os THEN 'WIN' WHEN g.team_ts + g.ln < g.team_os THEN 'LOSS' ELSE 'PUSH' END
      WHEN g.bt = 'TEAM_TOTAL' AND g.ln IS NOT NULL AND g.ou = 'OVER' THEN CASE WHEN g.team_ts > g.ln THEN 'WIN' WHEN g.team_ts < g.ln THEN 'LOSS' ELSE 'PUSH' END
      WHEN g.bt = 'TEAM_TOTAL' AND g.ln IS NOT NULL AND g.ou = 'UNDER' THEN CASE WHEN g.team_ts < g.ln THEN 'WIN' WHEN g.team_ts > g.ln THEN 'LOSS' ELSE 'PUSH' END
    END AS by_team
  FROM graded g
)
SELECT r.id, r."userId", r."isRecipientCopy", r."sourcePickId", r.sport, r.bt, r.per, r.ph AS pick_home, r.pa AS pick_away, r.side,
       r.detail, r.ln AS line, r.line_from_text, r.gh AS score_home, r.ga AS score_away, r.sh AS seg_home, r.sa AS seg_away,
       r.status AS stored, r.by_position, r.by_team, r."gameTime"
FROM result r
ORDER BY r.sport, r.bt, r."gameTime", r.ph, r.id;
