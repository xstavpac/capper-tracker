// Recent swings for Consensus Hybrid: each team's last n finished games against
// the lines posted for them (the sign conventions and the line choice live in
// lib/parlay/recent-swings.ts). Later PRs place the edges of a box from these.
//
// Reads, per (sport, Eastern day), once for every user:
//   1. game_results - SCORE COLUMNS ONLY (externalId, gameDate, teams, scores,
//      gameNumber). The row's JSON blobs (innings, linescores, scoring plays)
//      are never selected. The last n games per team are picked in SQL
//      (row_number over each team's sides), inside a lookback window.
//   2. odds_snapshots - the egress risk: a row is a whole sport-day of games
//      with every book and market (70-320 kB, more with props). The main
//      spread and total are extracted INSIDE Postgres (jsonb path queries) for
//      only the games found in step 1, so each stored line comes back as a
//      handful of small values. No snapshot row ever reaches this process.
//      FanDuel's line when it has the market, else the first book that does.
//
// The whole sport's teams are computed and cached under one key
// (cacheKeys.recentSwings), so every user generating that day reuses it; the
// caller's `teams` only select from it. The cache is day-grained: games on the
// same Eastern day as `before` are not included (a team that already played
// earlier today does not have that game here), only finished games that started
// before the day began. A game with no stored line is returned with its scores
// and lineSource "missing", never dropped.
//
// Team names: scores come from the score feed (ESPN / MLB), lines from the Odds
// API. The join is SQL-side on a folded name (lower-case, Latin-1 accents
// removed, periods dropped, whitespace collapsed - normalizeTeamName's rules for
// the accents the feeds use), widened by the cross-source alias rows
// (team-name-match.ts), then re-checked in JS with teamNamesMatch. A team the
// feeds spell differently with no alias row returns its games as "missing".
//
// A 0-0 "final" is skipped: a postponed game the score feed reports as
// Final persists a phantom 0-0 result.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { cacheKeys } from "@/lib/cache-keys";
import { addDaysToDateKey, easternDateKey, easternDayStart } from "@/lib/dates";
import { assembleSwings, oddsSpellings, type StoredLine, type SwingGame, type SwingScore } from "@/lib/parlay/recent-swings";
import { normalizeTeamName, teamNamesMatch } from "@/lib/team-name-match";
import { cachedByTag } from "@/server/data/cached";

export const DEFAULT_SWING_GAMES = 5;
const MAX_SWING_GAMES = 10;
// Long enough for n games of a weekly sport (a bye week included), short enough
// that an early-season team is not shown last season's games.
const WEEKLY_LOOKBACK_DAYS = 70;
const DAILY_LOOKBACK_DAYS = 35;
// How many days before a game its line can already sit in a snapshot row (the
// seed has no upper date bound: a week of NFL games is posted at once).
const WEEKLY_LOOKAHEAD_DAYS = 8;
const DAILY_LOOKAHEAD_DAYS = 3;
// The games it reads started before the day began; only a game that was still
// being scored at midnight can change, so an hour is plenty.
const SWINGS_CACHE_TTL_SECONDS = 3600;

const isWeekly = (sportKey: string) => sportKey.startsWith("americanfootball_");

// normalizeTeamName in SQL, for the accents the score and odds feeds use. Raw:
// the column is one of two fixed names, never a value.
function foldSql(column: string): Prisma.Sql {
  return Prisma.raw(
    `btrim(regexp_replace(replace(translate(lower(${column}), 'àáâãäåçèéêëìíîïñòóôõöùúûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy'), '.', ''), '\\s+', ' ', 'g'))`
  );
}

type ScoreRow = { externalId: string; gameDate: Date; homeTeam: string; awayTeam: string; homeScore: number; awayScore: number; gameNumber: number | null };

async function readScores(sportKey: string, floor: Date, cutoff: Date, n: number): Promise<SwingScore[]> {
  const rows = await prisma.$queryRaw<ScoreRow[]>(Prisma.sql`
    WITH recent AS (
      SELECT r."externalId", r."gameDate", r."homeTeam", r."awayTeam", r."homeScore", r."awayScore", r."gameNumber"
      FROM game_results r
      WHERE r."sportKey" = ${sportKey} AND r."gameDate" >= ${floor} AND r."gameDate" < ${cutoff}
        AND NOT (r."homeScore" = 0 AND r."awayScore" = 0)
    ),
    ranked AS (
      SELECT s."externalId",
             row_number() OVER (PARTITION BY s.team ORDER BY s."gameDate" DESC, s."externalId") AS rn
      FROM (SELECT "externalId", "gameDate", "homeTeam" AS team FROM recent
            UNION ALL
            SELECT "externalId", "gameDate", "awayTeam" AS team FROM recent) s
    )
    SELECT r."externalId", r."gameDate", r."homeTeam", r."awayTeam", r."homeScore", r."awayScore", r."gameNumber"
    FROM recent r
    WHERE r."externalId" IN (SELECT "externalId" FROM ranked WHERE rn <= ${n})
  `);
  return rows.map((r) => ({ ...r, gameDate: r.gameDate.toISOString() }));
}

type LineRow = {
  fetchDate: string;
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
  homeSpread: number | null;
  spreadUpdatedAt: string | null;
  total: number | null;
  totalUpdatedAt: string | null;
};

// The main spread and total of every snapshot game whose teams are one of
// `pairs`, extracted in Postgres. The lateral subqueries walk
// bookmakers -> markets -> outcomes with jsonb_path_query (lax mode: a game
// with no bookmakers, or a book without the market, simply yields no row) and
// keep ONE outcome per market: FanDuel's first, else the first book's.
export async function readStoredLines(sportKey: string, fromDate: string, toDate: string, pairs: { home: string; away: string }[]): Promise<StoredLine[]> {
  if (pairs.length === 0) return [];
  return prisma.$queryRaw<LineRow[]>(Prisma.sql`
    SELECT s."fetchDate",
           g.elem->>'id' AS "eventId",
           g.elem->>'homeTeam' AS "homeTeam",
           g.elem->>'awayTeam' AS "awayTeam",
           g.elem->>'commenceTime' AS "commenceTime",
           sp.point AS "homeSpread", sp.last_update AS "spreadUpdatedAt",
           tt.point AS total, tt.last_update AS "totalUpdatedAt"
    FROM odds_snapshots s
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.data) = 'array' THEN s.data ELSE '[]'::jsonb END) AS g(elem)
    JOIN unnest(${pairs.map((p) => p.home)}::text[], ${pairs.map((p) => p.away)}::text[]) AS w(h, a)
      ON ${foldSql("g.elem->>'homeTeam'")} = w.h AND ${foldSql("g.elem->>'awayTeam'")} = w.a
    LEFT JOIN LATERAL (
      SELECT (o->>'point')::float8 AS point, m->>'last_update' AS last_update
      FROM jsonb_path_query(g.elem, '$.bookmakers[*]') WITH ORDINALITY AS b(bk, ord)
      CROSS JOIN LATERAL jsonb_path_query(b.bk, '$.markets[*] ? (@.key == "spreads")') AS m
      CROSS JOIN LATERAL jsonb_path_query(m, '$.outcomes[*]') AS o
      WHERE o->>'name' = g.elem->>'homeTeam' AND o->>'point' IS NOT NULL
      ORDER BY (b.bk->>'key' = 'fanduel') DESC, b.ord
      LIMIT 1
    ) sp ON true
    LEFT JOIN LATERAL (
      SELECT (o->>'point')::float8 AS point, m->>'last_update' AS last_update
      FROM jsonb_path_query(g.elem, '$.bookmakers[*]') WITH ORDINALITY AS b(bk, ord)
      CROSS JOIN LATERAL jsonb_path_query(b.bk, '$.markets[*] ? (@.key == "totals")') AS m
      CROSS JOIN LATERAL jsonb_path_query(m, '$.outcomes[*]') AS o
      WHERE o->>'name' = 'Over' AND o->>'point' IS NOT NULL
      ORDER BY (b.bk->>'key' = 'fanduel') DESC, b.ord
      LIMIT 1
    ) tt ON true
    WHERE s."sportKey" = ${sportKey} AND s."fetchDate" >= ${fromDate} AND s."fetchDate" <= ${toDate}
      AND (sp.point IS NOT NULL OR tt.point IS NOT NULL)
  `);
}

async function computeSportSwings(sportKey: string, day: string, n: number): Promise<Record<string, SwingGame[]>> {
  const cutoff = easternDayStart(day);
  const floor = easternDayStart(addDaysToDateKey(day, -(isWeekly(sportKey) ? WEEKLY_LOOKBACK_DAYS : DAILY_LOOKBACK_DAYS)));
  const scores = await readScores(sportKey, floor, cutoff, n);
  if (scores.length === 0) return {};

  // Both spellings of each side (the alias rows), folded the way the SQL folds.
  const seen = new Set<string>();
  const pairs: { home: string; away: string }[] = [];
  for (const s of scores) {
    for (const home of oddsSpellings(s.homeTeam, sportKey)) {
      for (const away of oddsSpellings(s.awayTeam, sportKey)) {
        const pair = { home: normalizeTeamName(home), away: normalizeTeamName(away) };
        if (!seen.has(pair.home + "|" + pair.away)) {
          seen.add(pair.home + "|" + pair.away);
          pairs.push(pair);
        }
      }
    }
  }
  const dates = scores.map((s) => easternDateKey(new Date(s.gameDate))).sort();
  const lookahead = isWeekly(sportKey) ? WEEKLY_LOOKAHEAD_DAYS : DAILY_LOOKAHEAD_DAYS;
  const lines = await readStoredLines(sportKey, addDaysToDateKey(dates[0], -lookahead), dates[dates.length - 1], pairs);

  const result = assembleSwings(sportKey, scores, lines, n);
  console.log(
    "[getRecentSwings] computed",
    JSON.stringify({ sportKey, day, n, scoreRows: scores.length, lineRows: lines.length, teams: Object.keys(result).length, bytes: Buffer.byteLength(JSON.stringify({ scores, lines })) })
  );
  return result;
}

// Each requested team's last `n` finished games before the Eastern day of
// `before`, most recent first, keyed by the team name as given (the odds feed's
// spelling). A team with no finished games in the window maps to [].
export async function getRecentSwings(args: { sport: string; teams: string[]; before: Date; n?: number }): Promise<Record<string, SwingGame[]>> {
  const n = Math.min(MAX_SWING_GAMES, Math.max(1, Math.floor(args.n ?? DEFAULT_SWING_GAMES) || DEFAULT_SWING_GAMES));
  const day = easternDateKey(args.before);
  const all = await cachedByTag(cacheKeys.recentSwings(args.sport, day, n), SWINGS_CACHE_TTL_SECONDS, () => computeSportSwings(args.sport, day, n));
  const names = Object.keys(all);
  const out: Record<string, SwingGame[]> = {};
  for (const team of args.teams) {
    const key = names.find((k) => teamNamesMatch(k, team, args.sport));
    out[team] = key ? all[key] : [];
  }
  return out;
}
