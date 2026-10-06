// The /dashboard League Savant card: each in-season league's best cappers this season, as CTEs of the
// one panels statement (capper-panels.ts). One grouped read of the picks (GROUP BY league, capper)
// returns every league's top rows, last-30-day units included, so the card's league dropdown never
// fetches. No pick row reaches JS.
//
// A "league" here is what the leaderboard's league filter means: a `sports` row, by name. The feed
// knows it by its Odds API key (`feeds`: LIVE_SPORTS' key / label pairs).
//
//   sv_days    the feed's game days (Eastern) per league, back SAVANT_FEED_LOOKBACK_DAYS; `pre` marks
//              a day of preseason games only.
//   sv_season  per league, from the regular-season days: the newest season's first day (the first
//              day, or the first after a break longer than SAVANT_SEASON_GAP_DAYS), its last day, and
//              whether the feed holds anything before it (the season before, or its own preseason).
//              Without that the "first day" may only be where the feed's history starts.
//   sv_league  every league (a feed key, a sports row, or both) with:
//                in_season  a final in game_results within SAVANT_IN_SEASON_DAYS of today, or - only
//                           when there is none - a game in the newest odds snapshot that close
//                start/src  the season window's start (SavantSeasonSource)
//   sv_g       decided-pick totals per league and roster capper inside the league's window. Leagues
//              out of season are read only when the feed names no league in season at all.
//   savant     ranked: adjusted = units / (decided + SAVANT_PRIOR_PICKS), best first, ties to more
//              decided picks, then name. score = the percentile of `adjusted` in the league, a tie
//              counting half (the capper's own place included): round(100 * (below + tied / 2) / n).
//              The top SAVANT_PANEL_COUNT per league.
//   sv_leagues the leagues the card offers, with their window.
import { Prisma } from "@prisma/client";
import { WIN_UNITS } from "@/server/data/capper-list-aggregates";
import { round2 } from "@/server/data/stats";
import { APP_TIME_ZONE, startOfEasternDay } from "@/lib/dates";
import {
  SAVANT_FALLBACK_DAYS,
  SAVANT_FEED_LOOKBACK_DAYS,
  SAVANT_IN_SEASON_DAYS,
  SAVANT_PANEL_COUNT,
  SAVANT_PRIOR_PICKS,
  SAVANT_SEASON_GAP_DAYS,
  SAVANT_TREND_DAYS,
  type LeagueSavant,
  type SavantLeague,
  type SavantRow,
  type SavantSeasonSource,
} from "@/lib/league-savant";

const DAY_MS = 86400000;
export type SavantFeed = { key: string; label: string };
export const SAVANT_OUTPUTS = ["savant", "sv_leagues"];

// A stored UTC timestamp as its Eastern calendar day, and an Eastern day back as the UTC timestamp of
// its midnight.
const easternDay = (col: Prisma.Sql) => Prisma.sql`(${col} AT TIME ZONE 'UTC' AT TIME ZONE ${APP_TIME_ZONE})::date`;
const easternMidnight = (day: Prisma.Sql) => Prisma.sql`(${day}::timestamp AT TIME ZONE ${APP_TIME_ZONE} AT TIME ZONE 'UTC')`;
// Snapshot games carry `commenceTime` as the Odds API's "YYYY-MM-DDTHH:MM:SSZ"; compared as text, so
// a malformed one can never fail the statement.
const isoSeconds = (d: Date) => d.toISOString().slice(0, 19) + "Z";

// Reads the `roster` CTE (capper-panels.ts), so test cappers are left out here as everywhere.
export function savantCtes(userId: string, now: Date, feeds: readonly SavantFeed[]): [string, Prisma.Sql][] {
  const ts = (d: Date) => Prisma.sql`${d.toISOString()}::timestamp`;
  const today = startOfEasternDay(now);
  const todayDay = easternDay(ts(now));
  const lookback = ts(new Date(now.getTime() - SAVANT_FEED_LOOKBACK_DAYS * DAY_MS));
  // Whole Eastern days back from today (from noon, so a clock change in between cannot shift the day).
  const fallback = ts(startOfEasternDay(new Date(today.getTime() + DAY_MS / 2 - SAVANT_FALLBACK_DAYS * DAY_MS)));
  const trend = ts(new Date(now.getTime() - SAVANT_TREND_DAYS * DAY_MS));
  const near = [new Date(now.getTime() - SAVANT_IN_SEASON_DAYS * DAY_MS), new Date(now.getTime() + SAVANT_IN_SEASON_DAYS * DAY_MS)];
  const net = Prisma.sql`CASE WHEN p.status = 'WIN' THEN ${WIN_UNITS} WHEN p.status = 'LOSS' THEN -p.units ELSE 0 END`;
  const decided = Prisma.sql`p.status IN ('WIN', 'LOSS')`;
  const feedRows = feeds.length > 0 ? Prisma.join(feeds.map((f) => Prisma.sql`(${f.key}::text, ${f.label}::text)`)) : Prisma.sql`(NULL::text, NULL::text)`;

  return [
    ["sv_feed", Prisma.sql`SELECT k.key, k.label FROM (VALUES ${feedRows}) AS k(key, label) WHERE k.key IS NOT NULL`],
    [
      "sv_days",
      Prisma.sql`
        SELECT g."sportKey" AS key, ${easternDay(Prisma.sql`g."gameDate"`)} AS day, bool_and(g."isPreseason") AS pre
        FROM game_results g
        WHERE g."sportKey" IN (SELECT key FROM sv_feed) AND g."gameDate" >= ${lookback}
        GROUP BY 1, 2
      `,
    ],
    [
      "sv_season",
      Prisma.sql`
        SELECT s.key, s.start_day, s.last_day,
          EXISTS (SELECT 1 FROM sv_days d WHERE d.key = s.key AND d.day < s.start_day) AS preceded
        FROM (
          SELECT x.key, max(x.day) AS last_day,
            max(x.day) FILTER (WHERE x.gap IS NULL OR x.gap > ${SAVANT_SEASON_GAP_DAYS}::int) AS start_day
          FROM (SELECT d.key, d.day, d.day - lag(d.day) OVER (PARTITION BY d.key ORDER BY d.day) AS gap FROM sv_days d WHERE NOT d.pre) x
          GROUP BY x.key
        ) s
      `,
    ],
    [
      "sv_league",
      Prisma.sql`
        SELECT COALESCE(sp.name, k.label) AS league, sp.id AS sid,
          CASE
            WHEN k.key IS NULL THEN false
            WHEN EXISTS (SELECT 1 FROM sv_days d WHERE d.key = k.key AND d.day >= ${todayDay} - ${SAVANT_IN_SEASON_DAYS}::int) THEN true
            ELSE EXISTS (
              SELECT 1
              FROM (SELECT o.data FROM odds_snapshots o WHERE o."sportKey" = k.key AND o."fetchDate" >= (${todayDay} - ${SAVANT_IN_SEASON_DAYS}::int)::text ORDER BY o."fetchDate" DESC LIMIT 1) o
              CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(o.data) = 'array' THEN o.data ELSE '[]'::jsonb END) AS g(elem)
              WHERE g.elem->>'commenceTime' >= ${isoSeconds(near[0])} AND g.elem->>'commenceTime' <= ${isoSeconds(near[1])}
            )
          END AS in_season,
          CASE
            WHEN z.key IS NULL THEN ${fallback}
            WHEN z.last_day < ${todayDay} - ${SAVANT_SEASON_GAP_DAYS}::int THEN ${ts(today)}
            WHEN z.preceded THEN ${easternMidnight(Prisma.sql`z.start_day`)}
            ELSE ${fallback}
          END AS start,
          CASE
            WHEN z.key IS NULL THEN 'fallback'
            WHEN z.last_day < ${todayDay} - ${SAVANT_SEASON_GAP_DAYS}::int THEN 'upcoming'
            WHEN z.preceded THEN 'feed'
            ELSE 'fallback'
          END AS src
        FROM sv_feed k
        FULL JOIN sports sp ON sp.name = k.label
        LEFT JOIN sv_season z ON z.key = k.key
      `,
    ],
    [
      "sv_g",
      Prisma.sql`
        SELECT l.league, p."capperId" AS cid,
          (count(*) FILTER (WHERE ${decided}))::int AS decided,
          count(*)::int AS picks,
          COALESCE(sum(${net}), 0)::float8 AS units,
          COALESCE(sum(${net}) FILTER (WHERE p."gameTime" >= ${trend}), 0)::float8 AS u30,
          (count(*) FILTER (WHERE p."gameTime" >= ${trend}))::int AS n30
        FROM picks p
        JOIN sv_league l ON l.sid = p."sportId"
        WHERE p."userId" = ${userId} AND p.status IN ('WIN', 'LOSS', 'PUSH')
          AND p."gameTime" >= ${lookback} AND p."gameTime" >= l.start
          AND p."capperId" IN (SELECT id FROM roster)
          AND (l.in_season OR NOT EXISTS (SELECT 1 FROM sv_league a WHERE a.in_season))
        GROUP BY l.league, p."capperId"
        HAVING count(*) FILTER (WHERE ${decided}) >= 1
      `,
    ],
    [
      "savant",
      Prisma.sql`
        SELECT t.league, t.cid AS "capperId", t.name, t.units, t.picks, t.u30, t.n30, t.pos,
          round(100 * ((t.rk - 1) + t.tied / 2.0) / t.n)::int AS score
        FROM (
          SELECT a.*, r.name,
            rank() OVER (PARTITION BY a.league ORDER BY a.adj) AS rk,
            count(*) OVER (PARTITION BY a.league, a.adj) AS tied,
            count(*) OVER (PARTITION BY a.league) AS n,
            row_number() OVER (PARTITION BY a.league ORDER BY a.adj DESC, a.decided DESC, lower(r.name) COLLATE "C", r.name COLLATE "C", r.id COLLATE "C") AS pos
          FROM (SELECT g.*, round((g.units / (g.decided + ${SAVANT_PRIOR_PICKS}::int))::numeric, 9) AS adj FROM sv_g g) a
          JOIN roster r ON r.id = a.cid
        ) t
        WHERE t.pos <= ${SAVANT_PANEL_COUNT}::int
        ORDER BY t.league, t.pos
      `,
    ],
    [
      "sv_leagues",
      Prisma.sql`
        SELECT l.league, l.in_season AS "inSeason", l.src, to_char(l.start, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS start
        FROM sv_league l
        WHERE l.in_season OR (NOT EXISTS (SELECT 1 FROM sv_league a WHERE a.in_season) AND l.league IN (SELECT league FROM sv_g))
      `,
    ],
  ];
}

// The statement's two outputs as the card's data: leagues in a fixed alphabetical order, each with
// its rows best first.
export function savantFromRows(leagueRows: any[] | undefined, rows: any[] | undefined): LeagueSavant {
  const byLeague = new Map<string, SavantRow[]>();
  for (const r of [...(rows ?? [])].sort((a, b) => Number(a.pos) - Number(b.pos))) {
    const list = byLeague.get(r.league) ?? [];
    list.push({ capperId: r.capperId, name: r.name, units: round2(Number(r.units)), picks: Number(r.picks), score: Number(r.score), last30Units: Number(r.n30) > 0 ? round2(Number(r.u30)) : null });
    byLeague.set(r.league, list);
  }
  const leagues: SavantLeague[] = (leagueRows ?? [])
    .map((l) => ({ league: String(l.league), seasonStart: String(l.start), seasonSource: l.src as SavantSeasonSource, rows: byLeague.get(l.league) ?? [] }))
    .sort((a, b) => (a.league < b.league ? -1 : a.league > b.league ? 1 : 0));
  return { leagues, fromFeed: (leagueRows ?? []).some((l) => l.inSeason === true) };
}
