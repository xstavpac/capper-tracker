-- READ-ONLY. Wrong-game fuzzy-match scan: every graded pick that was graded via the fuzzy match (an exact match
-- needs identical team strings, so it can't be a wrong game; manual grades carry gradedViaFuzzyMatch = null), all
-- sports, all bet types, all time. For each, the row the OLD fuzzy branch picks today (both row nicknames in the
-- pick's text, within 6 h, same orientation by nickname preferred, then nearest), returned as distinct
-- (pick teams, row teams) pairs. The pairs are then checked in app code with teamOrientation (sport-scoped
-- teamNamesMatch, either orientation): a pair that is neither "same" nor "reversed" is a different game.
-- Run 2026-11-23: 17 pairs, 4 of them a different game (19 rows) - see wrong-game-regrade-apply.sql.
-- Parlay legs: 0 fuzzy-graded legs at that time.
WITH sk(name, key) AS (VALUES ('NFL','americanfootball_nfl'),('NBA','basketball_nba'),('MLB','baseball_mlb'),('NHL','icehockey_nhl'),('WNBA','basketball_wnba'),('NCAAF','americanfootball_ncaaf'),('NCAAB','basketball_ncaab'),('CFL','americanfootball_cfl')),
p AS (SELECT p.id, sk.key, p."homeTeam" AS ph, p."awayTeam" AS pa, lower(coalesce(p."betDetail",'') || ' ' || p."homeTeam" || ' ' || p."awayTeam") AS txt, p."gameTime", p."gameNumber"
  FROM picks p JOIN sports s ON s.id = p."sportId" JOIN sk ON sk.name = s.name
  WHERE p.status IN ('WIN','LOSS','PUSH') AND p."gradedViaFuzzyMatch" = true),
g AS (SELECT g."sportKey", g."homeTeam", g."awayTeam", g."homeScore", g."awayScore", g."gameDate", g."gameNumber",
        lower(regexp_replace(g."homeTeam", '^.*\s', '')) AS hn, lower(regexp_replace(g."awayTeam", '^.*\s', '')) AS an FROM game_results g),
cand AS (SELECT p.*, g."homeTeam" AS gh, g."awayTeam" AS ga,
   (strpos(lower(p.ph), g.hn) > 0 AND strpos(lower(p.pa), g.an) > 0) AS same_nick,
   abs(extract(epoch FROM g."gameDate" - p."gameTime")) AS drift
  FROM p JOIN g ON g."sportKey" = p.key AND abs(extract(epoch FROM g."gameDate" - p."gameTime")) <= 6*3600
    AND (p."gameNumber" IS NULL OR g."gameNumber" = p."gameNumber")
    AND NOT (p.key IN ('baseball_mlb','icehockey_nhl') AND g."homeScore" = 0 AND g."awayScore" = 0)
    AND strpos(p.txt, g.hn) > 0 AND strpos(p.txt, g.an) > 0),
chosen AS (SELECT DISTINCT ON (id) * FROM cand ORDER BY id, same_nick DESC, drift)
SELECT key, ph, pa, gh, ga, count(*) AS picks FROM chosen GROUP BY 1,2,3,4,5 ORDER BY 1,2;
