-- READ-ONLY report: how NBA player props are being priced since nba-prop-odds.ts went live, and what it cost.
-- Paste into the Supabase SQL editor. Set `since` to the deploy time first. Every query aggregates in Postgres
-- and returns a handful of rows; recipient copies are excluded.
--
--   matched        = oddsSource MARKET (priced at the pick's exact line)
--   no_exact_line  = the player is in the book's market, but no book hangs the pick's number
--   exact_match_rate = matched / (matched + no_exact_line)
--   no_market      = player not listed / ambiguous name / market not posted / fetch skipped (gate, timeout, error)
--   unsupported_prop = a market with no Odds API key (double-double, defensive rebounds), or a caller that never buys

-- 1. Match rate, overall and per market.
WITH params AS (SELECT timestamp '2026-11-12 00:00:00' AS since),
nba AS (
  SELECT coalesce(p."propMarket"::text, '(none)') AS market, p."oddsSource"::text AS src, p."oddsNullReason" AS reason
  FROM picks p JOIN sports s ON s.id = p."sportId"
  WHERE s.name = 'NBA' AND p."betType" = 'PLAYER_PROP' AND NOT p."isRecipientCopy"
    AND p."datePosted" >= (SELECT since FROM params)
)
SELECT coalesce(market, 'ALL') AS market,
  count(*) AS picks,
  count(*) FILTER (WHERE src = 'STATED') AS stated,
  count(*) FILTER (WHERE src = 'MARKET') AS matched,
  count(*) FILTER (WHERE reason = 'no_exact_line') AS no_exact_line,
  count(*) FILTER (WHERE reason = 'no_market') AS no_market,
  count(*) FILTER (WHERE reason = 'game_started') AS game_started,
  count(*) FILTER (WHERE reason = 'unsupported_prop') AS unsupported_prop,
  round(100.0 * count(*) FILTER (WHERE src = 'MARKET')
    / nullif(count(*) FILTER (WHERE src = 'MARKET' OR reason = 'no_exact_line'), 0), 1) AS exact_match_rate_pct
FROM nba
GROUP BY ROLLUP (market)
ORDER BY (market IS NULL) DESC, picks DESC;

-- 2. Which books the matched picks were priced from.
SELECT p."oddsBook" AS book, count(*) AS picks
FROM picks p JOIN sports s ON s.id = p."sportId"
WHERE s.name = 'NBA' AND p."betType" = 'PLAYER_PROP' AND NOT p."isRecipientCopy"
  AND p."oddsSource" = 'MARKET' AND p."datePosted" >= timestamp '2026-11-12 00:00:00'
GROUP BY 1 ORDER BY 2 DESC;

-- 3. Credit use. Each fetch asks for one market for one event; it costs 1 credit when the market comes back
-- (linesStored > 0) and nothing when it doesn't. stuck_claims = claim rows whose response never landed.
SELECT (f."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date AS et_day,
  count(*) AS fetches,
  count(*) FILTER (WHERE f."linesStored" > 0) AS credits_spent,
  count(*) FILTER (WHERE f."fetchedAt" IS NULL) AS stuck_claims,
  count(DISTINCT f."eventId") AS events
FROM odds_prop_fetches f
WHERE f."createdAt" >= timestamp '2026-11-12 00:00:00'
GROUP BY ROLLUP (1) ORDER BY 1 NULLS LAST;

-- 3b. Cross-check: usage-log rows for the caller (one per response, failed or not).
SELECT count(*) AS calls, count(*) FILTER (WHERE "httpStatus" = 200) AS ok_calls
FROM odds_api_usage_log
WHERE caller = 'nba-prop-odds' AND "pollTimestamp" >= timestamp '2026-11-12 00:00:00';
