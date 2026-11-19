-- Parlay Generator backtest: OLD (scoring.ts edge model, the gate before this PR) vs NEW (record-score.ts
-- combined win %, other-leagues middle level: each pick counted once), for K = 10 / 15 / 20 x F = 0.10 / 0.20.
-- One read-only statement that returns aggregates
-- only (a few dozen rows), for the Supabase SQL editor or a read-only MCP session.
--
-- The generator, simulated per Eastern game day with today's settings: gate 55, Include ALL, max 1 leg per
-- game, Best available, no slip, no targets. A day's candidates are that user's picks on that day's games
-- that existed before their game started (createdAt < gameTime). Each model gates them, keeps the best
-- pick per game (score desc, then the larger N_cat / decided, then id), ranks the games by that pick,
-- and takes the top 3 / 5 / 10 as that day's 3-, 5- and 10-leg parlays (a day with fewer qualifying games
-- has no parlay of that size; the generator would have built a short one).
--
-- Point in time, no lookahead. Every pick is scored at its own gameTime from results that were in the
-- database and settled before it: a result counts once it is GREATEST(its gameTime + 6 hours, its
-- createdAt), and only when that moment is at or before the scored pick's gameTime. A pick's own result
-- is at least its gameTime + 6 hours, so it can never feed its own score, and no later result can either.
-- gradedAt is not used (a bulk import grades everything at once). This one event stream drives every
-- record: all-time category, league category, the capper's Last 20 (every category and league,
-- pushes in the count of 20, out of the win %), the edge model's priced columns and its platform rates.
-- The same stream and the same cut-off score OLD and NEW.
--
-- Simplifications, both models alike: the platform rates (OLD only) come from this user's own stream
-- (17,472 of the platform's 18,647 decided original picks), not the nightly rollup; Last 20 is ordered by
-- when a result became known rather than by gameTime; a game is (sport, gameTime, home, away).
-- Payouts use the stored odds as they are (a DEFAULTED -110 pays -110); a push is a void leg (x1.0).
WITH params AS (
  SELECT 'cmse05x5a0000z4osuufx38lr'::text AS uid, DATE '2026-10-19' AS d0, DATE '2026-11-17' AS d1,
         0.55::float8 AS gate, 0.5::float8 AS prior
),
market_keys(family, market) AS (
  VALUES
    ('FOOTBALL','PASS_YDS'),('FOOTBALL','RUSH_YDS'),('FOOTBALL','REC_YDS'),('FOOTBALL','RECEPTIONS'),('FOOTBALL','RUSH_REC_YDS'),('FOOTBALL','PASS_RUSH_YDS'),
    ('FOOTBALL','PASS_ATTEMPTS'),('FOOTBALL','PASS_COMPLETIONS'),('FOOTBALL','PASS_INTERCEPTIONS'),('FOOTBALL','RUSH_ATTEMPTS'),('FOOTBALL','TD'),('FOOTBALL','PASS_TDS'),('FOOTBALL','TD_COUNT'),
    ('BASKETBALL','POINTS'),('BASKETBALL','REBOUNDS'),('BASKETBALL','DEFENSIVE_REBOUNDS'),('BASKETBALL','ASSISTS'),('BASKETBALL','THREES_MADE'),('BASKETBALL','STEALS'),('BASKETBALL','BLOCKS'),('BASKETBALL','TURNOVERS'),
    ('BASKETBALL','POINTS_REBOUNDS_ASSISTS'),('BASKETBALL','POINTS_REBOUNDS'),('BASKETBALL','POINTS_ASSISTS'),('BASKETBALL','REBOUNDS_ASSISTS'),('BASKETBALL','DOUBLE_DOUBLE'),
    ('HOCKEY','POINTS'),('HOCKEY','ASSISTS'),('HOCKEY','SHOTS_ON_GOAL'),('HOCKEY','SAVES'),('HOCKEY','ANYTIME_GOAL'),('HOCKEY','FIRST_GOAL'),
    ('BASEBALL','HITS'),('BASEBALL','TOTAL_BASES'),('BASEBALL','HOME_RUNS'),('BASEBALL','RBIS'),('BASEBALL','RUNS'),('BASEBALL','WALKS'),('BASEBALL','STRIKEOUTS'),('BASEBALL','OUTS_RECORDED')
),
d AS (
  SELECT p.id, p."capperId" AS cid, s.name AS league, p."betType"::text AS bt,
    -- The record key: a prop with a market key reads its market (prop-market-key.ts), else the category.
    -- A family member in another league of the family is the same market (BASKETBALL:POINTS in NBA and WNBA).
    CASE WHEN m.market IS NOT NULL THEN m.family || ':' || m.market ELSE p.category END AS gk,
    p.status::text AS st, CASE p.status::text WHEN 'WIN' THEN 1 WHEN 'LOSS' THEN 0 END AS won,
    p.odds,
    (CASE
          WHEN p."oddsSource"::text = 'DEFAULTED' OR abs(p.odds) < 100 THEN NULL
          WHEN p."oddsSource" IS NOT NULL OR p.odds <> -110 OR p."betType"::text IN ('SPREAD', 'TOTAL') THEN CASE WHEN p.odds > 0 THEN 100.0 / (p.odds + 100) ELSE (-p.odds)::numeric / (-p.odds + 100) END
          ELSE NULL
        END)::float8 AS be,
    (CASE WHEN abs(p.odds) < 100 THEN 210.0 / 110 WHEN p.odds > 0 THEN 1 + p.odds / 100.0 ELSE 1 + 100.0 / (-p.odds) END)::float8 AS dec,
    p."gameTime" AS gt, p."createdAt" AS created,
    GREATEST(p."gameTime" + interval '6 hours', p."createdAt") AS known_at,
    (p."gameTime" AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date AS game_day,
    p."sportId" || '|' || p."gameTime"::text || '|' || lower(COALESCE(p."homeTeam", '')) || '|' || lower(COALESCE(p."awayTeam", '')) AS game
  FROM picks p
  JOIN sports s ON s.id = p."sportId"
  LEFT JOIN market_keys m ON p."betType" = 'PLAYER_PROP' AND m.market = p."propMarket"::text
    AND m.family = CASE upper(s.name) WHEN 'NFL' THEN 'FOOTBALL' WHEN 'NCAAF' THEN 'FOOTBALL' WHEN 'NBA' THEN 'BASKETBALL' WHEN 'WNBA' THEN 'BASKETBALL' WHEN 'NCAAB' THEN 'BASKETBALL' WHEN 'NHL' THEN 'HOCKEY' WHEN 'MLB' THEN 'BASEBALL' END
  WHERE p."userId" = (SELECT uid FROM params) AND p.status IN ('WIN', 'LOSS', 'PUSH')
),
-- One stream: each result arriving (ord 0, at known_at) and each candidate being scored (ord 1, at its gameTime).
ev AS (
  SELECT id, cid, league, bt, gk, known_at AS t, 0 AS ord, NULL::text AS sid,
    COALESCE(won, 0)::float8 AS w, (CASE WHEN won = 0 THEN 1 ELSE 0 END)::float8 AS l, 1::float8 AS g,
    (CASE WHEN be IS NULL OR won IS NULL THEN 0 ELSE won END)::float8 AS pw,
    (CASE WHEN be IS NULL OR won IS NULL THEN 0 ELSE 1 - won END)::float8 AS pl,
    (CASE WHEN be IS NULL OR won IS NULL THEN 0 ELSE be END)::float8 AS imp,
    (CASE WHEN be IS NULL OR won IS NULL THEN 0 ELSE 1 END)::float8 AS pn
  FROM d
  UNION ALL
  SELECT id, cid, league, bt, gk, gt, 1, id, 0, 0, 0, 0, 0, 0, 0
  FROM d, params
  WHERE d.game_day BETWEEN params.d0 AND params.d1 AND d.created < d.gt AND d.gk IS NOT NULL
),
run AS (
  SELECT ev.sid, ev.ord,
    sum(w) FILTER (WHERE gk IS NOT NULL) OVER lg AS lw, sum(l) FILTER (WHERE gk IS NOT NULL) OVER lg AS ll,
    sum(pw) OVER lg AS lpw, sum(pl) OVER lg AS lpl, sum(imp) OVER lg AS limp,
    sum(w) OVER al AS aw, sum(l) OVER al AS al, sum(pw) OVER al AS apw, sum(pl) OVER al AS apl, sum(imp) OVER al AS aimp,
    sum(g) OVER cp AS gc,
    sum(w) OVER pk AS kw, sum(l) OVER pk AS kl, sum(pn) OVER pk AS kpn, sum(imp) OVER pk AS kimp,
    sum(w) OVER pb AS bw, sum(l) OVER pb AS bl, sum(pn) OVER pb AS bpn, sum(imp) OVER pb AS bimp,
    sum(w) OVER tb AS tw, sum(l) OVER tb AS tl, sum(pn) OVER tb AS tpn, sum(imp) OVER tb AS timp
  FROM ev
  WINDOW lg AS (PARTITION BY cid, league, gk ORDER BY t, ord),
         al AS (PARTITION BY cid, gk ORDER BY t, ord),
         cp AS (PARTITION BY cid ORDER BY t, ord),
         pk AS (PARTITION BY league, gk ORDER BY t, ord),
         pb AS (PARTITION BY league, bt ORDER BY t, ord),
         tb AS (PARTITION BY bt ORDER BY t, ord)
),
-- Each capper's results in the order they became known, with running win / loss totals: Last 20 is
-- the difference of two of these rows.
res AS (
  SELECT cid, row_number() OVER w AS rn, sum(COALESCE(won, 0)) OVER w AS cw, sum(CASE WHEN won = 0 THEN 1 ELSE 0 END) OVER w AS cl
  FROM d
  WINDOW w AS (PARTITION BY cid ORDER BY known_at, id)
),
s1 AS (
  SELECT d.*, r.lw, r.ll, r.lpw, r.lpl, r.limp, r.aw, r.al, r.apw, r.apl, r.aimp, r.gc,
    CASE WHEN r.kw + r.kl >= 30 THEN r.kw / (r.kw + r.kl) WHEN r.bw + r.bl >= 30 THEN r.bw / (r.bw + r.bl) WHEN r.tw + r.tl >= 30 THEN r.tw / (r.tw + r.tl) ELSE 0.52 END AS plat,
    CASE WHEN r.kpn >= 30 THEN r.kimp / r.kpn WHEN r.bpn >= 30 THEN r.bimp / r.bpn WHEN r.tpn >= 30 THEN r.timp / r.tpn ELSE 110.0::float8 / 210 END AS plat_be,
    r.apw + r.apl AS pn,
    -- Last 20: the 20 most recent known results (pushes count toward the 20), win % without pushes;
    -- none when fewer than 20 are known (the card shows no Last 20 then).
    CASE WHEN r.gc >= 20 THEN hi.cw - COALESCE(lo.cw, 0) END AS l20w,
    CASE WHEN r.gc >= 20 THEN hi.cl - COALESCE(lo.cl, 0) END AS l20l
  FROM run r
  JOIN d ON d.id = r.sid
  LEFT JOIN res hi ON hi.cid = d.cid AND hi.rn = r.gc
  LEFT JOIN res lo ON lo.cid = d.cid AND lo.rn = r.gc - 20
  WHERE r.ord = 1
),
s2 AS (
  SELECT s1.*,
    -- OLD (scoring.ts, k = 20): win probability, shrunk edge, historical break-even.
    (lw + 20 * (((aw - lw) + 20 * plat) / ((aw - lw) + (al - ll) + 20))) / (lw + ll + 20) AS shrunk,
    ((lpw - limp) + 20 * (((apw - lpw) - (aimp - limp)) / NULLIF(pn - (lpw + lpl) + 20, 0))) / (lpw + lpl + 20) AS shrunk_edge,
    aimp / NULLIF(pn, 0) AS hist
  FROM s1
),
s3 AS (
  SELECT s2.*,
    LEAST(0.99, GREATEST(0.01, hist)) AS hist_c,
    LEAST(0.99, GREATEST(0.01, hist + shrunk_edge)) AS hist_p,
    -- NEW (record-score.ts): p_other = other leagues (all-time minus this league), p_league shrunk toward it.
    (lw + 10 * ((aw - lw + 5) / (aw - lw + al - ll + 10))) / (lw + ll + 10) AS p_lg10,
    (lw + 15 * ((aw - lw + 7.5) / (aw - lw + al - ll + 15))) / (lw + ll + 15) AS p_lg15,
    (lw + 20 * ((aw - lw + 10) / (aw - lw + al - ll + 20))) / (lw + ll + 20) AS p_lg20,
    CASE WHEN l20w + l20l > 0 THEN l20w / (l20w + l20l) END AS l20
  FROM s2
),
scored AS (
  SELECT s3.*,
    CASE
      WHEN be IS NOT NULL AND pn >= 5 THEN 1 / (1 + exp(-(ln(be / (1 - be)) + ln(hist_p / (1 - hist_p)) - ln(hist_c / (1 - hist_c))))) - be
      WHEN be IS NOT NULL THEN LEAST(shrunk - be, shrunk - plat_be)
      ELSE shrunk - plat_be
    END AS edge,
    -- ls1: with a real price the raw record in the category must reach min(break-even, gate).
    (be IS NULL OR aw / (aw + al) >= LEAST(be, (SELECT gate FROM params))) AS ls1
  FROM s3
  WHERE aw + al > 0
),
models AS (
  SELECT s.id, s.game_day, s.game, s.won, s.dec, s.odds, s.aw + s.al AS n_cat, v.model, v.score, v.passes
  FROM scored s
  CROSS JOIN LATERAL (VALUES
    ('OLD edge', s.edge, s.edge >= (SELECT gate FROM params) - 110.0::float8 / 210 AND s.ls1),
    ('NEW K10 F.10', CASE WHEN s.l20 IS NULL THEN s.p_lg10 ELSE 0.9 * s.p_lg10 + 0.1 * s.l20 END, NULL::boolean),
    ('NEW K10 F.20', CASE WHEN s.l20 IS NULL THEN s.p_lg10 ELSE 0.8 * s.p_lg10 + 0.2 * s.l20 END, NULL),
    ('NEW K15 F.10', CASE WHEN s.l20 IS NULL THEN s.p_lg15 ELSE 0.9 * s.p_lg15 + 0.1 * s.l20 END, NULL),
    ('NEW K15 F.20', CASE WHEN s.l20 IS NULL THEN s.p_lg15 ELSE 0.8 * s.p_lg15 + 0.2 * s.l20 END, NULL),
    ('NEW K20 F.10', CASE WHEN s.l20 IS NULL THEN s.p_lg20 ELSE 0.9 * s.p_lg20 + 0.1 * s.l20 END, NULL),
    ('NEW K20 F.20', CASE WHEN s.l20 IS NULL THEN s.p_lg20 ELSE 0.8 * s.p_lg20 + 0.2 * s.l20 END, NULL)
  ) AS v(model, score, passes)
),
qual AS (
  SELECT m.*, row_number() OVER (PARTITION BY model, game_day, game ORDER BY score DESC, n_cat DESC, id) AS in_game
  FROM models m
  WHERE COALESCE(passes, round((score * 1e9)::numeric) / 1e7 >= (SELECT gate FROM params) * 100)
),
legs AS (
  SELECT q.*, row_number() OVER (PARTITION BY model, game_day ORDER BY score DESC, n_cat DESC, id) AS game_rank,
    count(*) OVER (PARTITION BY model, game_day) AS games_that_day
  FROM qual q WHERE in_game = 1
),
sizes(n) AS (VALUES (3), (5), (10)),
parlays AS (
  SELECT l.model, z.n, l.game_day,
    bool_and(l.won IS DISTINCT FROM 0) AS hit,
    exp(sum(ln(CASE WHEN l.won IS NULL THEN 1 ELSE l.dec END))) AS price
  FROM legs l JOIN sizes z ON l.game_rank <= z.n AND l.games_that_day >= z.n
  GROUP BY 1, 2, 3
),
days AS (
  SELECT count(*) AS n FROM generate_series((SELECT d0 FROM params), (SELECT d1 FROM params), interval '1 day')
)
SELECT 'pool' AS section, model, NULL::int AS size,
  round(count(*)::numeric / (SELECT n FROM days), 1) AS per_day,
  count(*) AS n,
  round(100 * avg(won)::numeric, 1) AS hit_pct,
  round(100 * (sum(CASE WHEN won = 1 THEN dec - 1 WHEN won = 0 THEN -1 ELSE 0 END) / NULLIF(count(won), 0))::numeric, 1) AS roi_pct,
  round(avg(dec)::numeric, 3) AS avg_dec,
  round(100 * avg((odds < -200)::int)::numeric, 1) AS fav_200_pct,
  NULL::numeric AS parlay_hit_pct, NULL::numeric AS parlay_roi_pct, NULL::numeric AS avg_parlay_dec
FROM qual GROUP BY model
UNION ALL
SELECT 'legs', l.model, z.n,
  round(count(*)::numeric / NULLIF(count(DISTINCT l.game_day), 0), 1),
  count(*),
  round(100 * avg(l.won)::numeric, 1),
  round(100 * (sum(CASE WHEN l.won = 1 THEN l.dec - 1 WHEN l.won = 0 THEN -1 ELSE 0 END) / NULLIF(count(l.won), 0))::numeric, 1),
  round(avg(l.dec)::numeric, 3),
  round(100 * avg((l.odds < -200)::int)::numeric, 1),
  NULL, NULL, NULL
FROM legs l JOIN sizes z ON l.game_rank <= z.n AND l.games_that_day >= z.n
GROUP BY l.model, z.n
UNION ALL
SELECT 'parlays', model, n, NULL, count(*),
  NULL, NULL, NULL, NULL,
  round(100 * avg(hit::int)::numeric, 1),
  round(100 * avg(CASE WHEN hit THEN price - 1 ELSE -1 END)::numeric, 1),
  round(avg(price)::numeric, 2)
FROM parlays GROUP BY model, n
ORDER BY 1, 3 NULLS FIRST, 2;
