-- Parlay Generator scoring backtest: old Wilson ranking vs the win-rate model vs the edge model.
-- One read-only statement that returns aggregates only, for pasting into the Supabase SQL editor.
--
-- Variants, ranked within each user + Eastern game day:
--   old_wilson     best-of-two record, Wilson lower bound at z = 1.5, gate on the chosen record's raw win %
--   win_rate_378   the #378 model: shrunk win probability minus the pick's break-even (platform's if no real price)
--   edge_logit     lib/parlay/scoring.ts: shrunk edge moved to the pick's price on the log-odds scale; under 5 priced
--                  picks the worse of the capper's and the platform's edge; no real price, the platform's
--
-- Point in time: a pick is scored from results known before it was posted. posted_at is LEAST(datePosted, gameTime)
-- and a result counts from gameTime + 6 hours. gradedAt is deliberately not used: a bulk import grades everything at
-- once, which would leave those records empty. datePosted is our import time, not the capper's own post time.
-- Platform rates are point in time too, with the same under-30 fallback.
--
-- Output, one row per group:
--   rank_bucket       hit rate and average edge by rank (1, 2, 3, 4-5, 6-10, 11+)
--   price_range_top5  the same for each variant's top 5 per day, by the pick's price. Reporting only: nothing in the
--                     scoring uses price ranges.
-- scope: ALL, and EXCL_NHL_MLB because their moneyline and puck-line grading looks wrong. gating: UNGATED, and GATED_55
-- for the default 55% gate. avg_edge is won minus break-even over picks with a real price.
WITH market_keys(family, market) AS (
  VALUES
    ('FOOTBALL','PASS_YDS'),('FOOTBALL','RUSH_YDS'),('FOOTBALL','REC_YDS'),('FOOTBALL','RECEPTIONS'),('FOOTBALL','RUSH_REC_YDS'),('FOOTBALL','PASS_RUSH_YDS'),
    ('FOOTBALL','PASS_ATTEMPTS'),('FOOTBALL','PASS_COMPLETIONS'),('FOOTBALL','PASS_INTERCEPTIONS'),('FOOTBALL','RUSH_ATTEMPTS'),('FOOTBALL','TD'),('FOOTBALL','PASS_TDS'),
    ('BASKETBALL','POINTS'),('BASKETBALL','REBOUNDS'),('BASKETBALL','ASSISTS'),('BASKETBALL','THREES_MADE'),('BASKETBALL','STEALS'),('BASKETBALL','BLOCKS'),
    ('BASKETBALL','POINTS_REBOUNDS_ASSISTS'),('BASKETBALL','POINTS_REBOUNDS'),('BASKETBALL','POINTS_ASSISTS'),('BASKETBALL','REBOUNDS_ASSISTS'),('BASKETBALL','DOUBLE_DOUBLE'),
    ('HOCKEY','POINTS'),('HOCKEY','ASSISTS'),('HOCKEY','SHOTS_ON_GOAL'),('HOCKEY','SAVES'),('HOCKEY','ANYTIME_GOAL'),('HOCKEY','FIRST_GOAL'),
    ('BASEBALL','HITS'),('BASEBALL','TOTAL_BASES'),('BASEBALL','HOME_RUNS'),('BASEBALL','RBIS'),('BASEBALL','RUNS'),('BASEBALL','WALKS'),('BASEBALL','STRIKEOUTS'),('BASEBALL','OUTS_RECORDED')
),
d AS (
  SELECT p.id, p."userId" AS uid, p."capperId" AS cid, s.name AS league, upper(s.name) IN ('NHL', 'MLB') AS nhl_mlb,
    p."betType"::text AS bt, COALESCE(m.family || ':' || m.market, p.category) AS gk,
    (p.status = 'WIN')::int AS won, p.odds,
    (CASE
          WHEN p."oddsSource"::text = 'DEFAULTED' OR abs(p.odds) < 100 THEN NULL
          WHEN p."oddsSource" IS NOT NULL OR p.odds <> -110 OR p."betType"::text IN ('SPREAD', 'TOTAL') THEN CASE WHEN p.odds > 0 THEN 100.0 / (p.odds + 100) ELSE (-p.odds)::numeric / (-p.odds + 100) END
          ELSE NULL
        END)::float8 AS be,
    LEAST(p."datePosted", p."gameTime") AS posted_at,
    p."gameTime" + interval '6 hours' AS known_at,
    (p."gameTime" AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date AS game_day
  FROM picks p
  JOIN sports s ON s.id = p."sportId"
  LEFT JOIN market_keys m ON p."betType" = 'PLAYER_PROP' AND m.market = p."propMarket"::text
    AND m.family = CASE upper(s.name) WHEN 'NFL' THEN 'FOOTBALL' WHEN 'NCAAF' THEN 'FOOTBALL' WHEN 'NBA' THEN 'BASKETBALL' WHEN 'WNBA' THEN 'BASKETBALL' WHEN 'NHL' THEN 'HOCKEY' WHEN 'MLB' THEN 'BASEBALL' END
  WHERE p.status IN ('WIN', 'LOSS') AND NOT p."isRecipientCopy" AND COALESCE(m.family || ':' || m.market, p.category) IS NOT NULL
),
-- One stream per pick: its result arriving (ord 0), and the moment it is scored (ord 1).
ev AS (
  SELECT uid, cid, league, bt, gk, known_at AS t, 0 AS ord, NULL::text AS id,
    won::float8 AS w, (1 - won)::float8 AS l,
    (CASE WHEN be IS NULL THEN 0 ELSE won END)::float8 AS pw, (CASE WHEN be IS NULL THEN 0 ELSE 1 - won END)::float8 AS pl,
    COALESCE(be, 0) AS imp, (CASE WHEN be IS NULL THEN 0 ELSE 1 END)::float8 AS pn
  FROM d
  UNION ALL
  SELECT uid, cid, league, bt, gk, posted_at, 1, id, 0, 0, 0, 0, 0, 0 FROM d
),
run AS (
  SELECT ev.id,
    sum(w) OVER lg AS lw, sum(l) OVER lg AS ll, sum(pw) OVER lg AS lpw, sum(pl) OVER lg AS lpl, sum(imp) OVER lg AS limp,
    sum(w) OVER al AS aw, sum(l) OVER al AS al, sum(pw) OVER al AS apw, sum(pl) OVER al AS apl, sum(imp) OVER al AS aimp,
    sum(w) OVER pk AS kw, sum(l) OVER pk AS kl, sum(pn) OVER pk AS kpn, sum(imp) OVER pk AS kimp,
    sum(w) OVER pb AS bw, sum(l) OVER pb AS bl, sum(pn) OVER pb AS bpn, sum(imp) OVER pb AS bimp,
    sum(w) OVER tb AS tw, sum(l) OVER tb AS tl, sum(pn) OVER tb AS tpn, sum(imp) OVER tb AS timp
  FROM ev
  WINDOW lg AS (PARTITION BY uid, cid, league, gk ORDER BY t, ord),
         al AS (PARTITION BY uid, cid, gk ORDER BY t, ord),
         pk AS (PARTITION BY league, gk ORDER BY t, ord),
         pb AS (PARTITION BY league, bt ORDER BY t, ord),
         tb AS (PARTITION BY bt ORDER BY t, ord)
),
s1 AS (
  SELECT d.*, r.lw, r.ll, r.lpw, r.lpl, r.limp, r.aw, r.al, r.apw, r.apl, r.aimp,
    CASE WHEN r.kw + r.kl >= 30 THEN r.kw / (r.kw + r.kl) WHEN r.bw + r.bl >= 30 THEN r.bw / (r.bw + r.bl) WHEN r.tw + r.tl >= 30 THEN r.tw / (r.tw + r.tl) ELSE 0.52 END AS plat,
    CASE WHEN r.kpn >= 30 THEN r.kimp / r.kpn WHEN r.bpn >= 30 THEN r.bimp / r.bpn WHEN r.tpn >= 30 THEN r.timp / r.tpn ELSE 110.0::float8 / 210 END AS plat_be,
    r.apw + r.apl AS pn
  FROM d JOIN run r ON r.id = d.id
  WHERE r.aw + r.al > 0
),
s2 AS (
  SELECT s1.*,
    (lw + 20 * (((aw - lw) + 20 * plat) / ((aw - lw) + (al - ll) + 20))) / (lw + ll + 20) AS shrunk,
    ((lpw - limp) + 20 * (((apw - lpw) - (aimp - limp)) / (pn - (lpw + lpl) + 20))) / (lpw + lpl + 20) AS shrunk_edge,
    aimp / NULLIF(pn, 0) AS hist
  FROM s1
),
s3 AS (
  SELECT s2.*,
    LEAST(0.99, GREATEST(0.01, hist)) AS hist_c,
    LEAST(0.99, GREATEST(0.01, hist + shrunk_edge)) AS hist_p
  FROM s2
),
s4 AS (
  SELECT s3.*,
    CASE
      WHEN be IS NOT NULL AND pn >= 5 THEN 1 / (1 + exp(-(ln(be / (1 - be)) + ln(hist_p / (1 - hist_p)) - ln(hist_c / (1 - hist_c))))) - be
      WHEN be IS NOT NULL THEN LEAST(shrunk - be, shrunk - plat_be)
      ELSE shrunk - plat_be
    END AS edge_logit,
    COALESCE(shrunk - be, shrunk - plat_be) AS win_rate_378,
    CASE WHEN lw + ll = 0 THEN NULL ELSE (lw / (lw + ll) + 1.125 / (lw + ll) - 1.5 * sqrt((lw / (lw + ll)) * (ll / (lw + ll)) / (lw + ll) + 0.5625 / ((lw + ll) * (lw + ll)))) / (1 + 2.25 / (lw + ll)) END AS lb_league,
    (aw / (aw + al) + 1.125 / (aw + al) - 1.5 * sqrt((aw / (aw + al)) * (al / (aw + al)) / (aw + al) + 0.5625 / ((aw + al) * (aw + al)))) / (1 + 2.25 / (aw + al)) AS lb_overall
  FROM s3
),
scored AS (
  SELECT s4.*,
    GREATEST(lb_league, lb_overall) AS old_wilson,
    CASE WHEN lb_league IS NOT NULL AND lb_overall <= lb_league THEN 100 * lw / (lw + ll) ELSE 100 * aw / (aw + al) END AS old_win_pct
  FROM s4
)
-- @@FINAL
, ranked AS (
  SELECT v.variant, sc.scope, g.gating, s.won, s.be, v.score,
    row_number() OVER (PARTITION BY v.variant, sc.scope, g.gating, s.uid, s.game_day ORDER BY v.score DESC, s.id) AS rk,
    CASE
      WHEN s.be IS NULL THEN '7 no real price'
      WHEN s.odds <= -300 THEN '1 -300 or shorter'
      WHEN s.odds <= -151 THEN '2 -299 to -151'
      WHEN s.odds < 0 THEN '3 -150 to -100'
      WHEN s.odds < 150 THEN '4 +100 to +149'
      WHEN s.odds < 300 THEN '5 +150 to +299'
      ELSE '6 +300 or longer'
    END AS price_range
  FROM scored s
  CROSS JOIN LATERAL (VALUES
    ('old_wilson', s.old_wilson, s.old_win_pct >= 55),
    ('win_rate_378', s.win_rate_378, s.win_rate_378 >= 0.55 - 110.0::float8 / 210),
    ('edge_logit', s.edge_logit, s.edge_logit >= 0.55 - 110.0::float8 / 210)
  ) AS v(variant, score, passes)
  CROSS JOIN LATERAL (VALUES ('ALL', true), ('EXCL_NHL_MLB', NOT s.nhl_mlb)) AS sc(scope, keep)
  CROSS JOIN LATERAL (VALUES ('UNGATED', true), ('GATED_55', v.passes)) AS g(gating, keep)
  WHERE sc.keep AND g.keep
)
SELECT 'rank_bucket' AS section, scope, gating, variant,
  CASE WHEN rk <= 3 THEN 'rank ' || rk WHEN rk <= 5 THEN 'rank 4-5' WHEN rk <= 10 THEN 'rank 6-10' ELSE 'rank 11+' END AS grp,
  count(*) AS picks, round(100 * avg(won)::numeric, 1) AS hit_pct, count(be) AS priced,
  round(100 * avg(won - be)::numeric, 1) AS avg_edge_pct, round(100 * avg(score)::numeric, 1) AS avg_score_pct
FROM ranked
GROUP BY 2, 3, 4, 5
UNION ALL
SELECT 'price_range_top5', scope, gating, variant, price_range,
  count(*), round(100 * avg(won)::numeric, 1), count(be),
  round(100 * avg(won - be)::numeric, 1), round(100 * avg(score)::numeric, 1)
FROM ranked
WHERE rk <= 5
GROUP BY 2, 3, 4, 5
ORDER BY 1, 2, 3, 4, 5;
