import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { OddsGame } from "@/server/data/odds";

// Postgres-side projections of OddsSnapshot.data for the two model-engine
// readers that used to pull every full daily board into JS (a whole day's
// bookmaker x market payload is ~70-320 kB per snapshot; see the PR that added
// this file for measured numbers). Same idea as getOddsGameStubs in odds.ts:
// jsonb_array_elements / jsonb_agg inside Postgres, so only the handful of
// fields each reader actually looks at leave the database.
//
// Each projection returns SYNTHETIC OddsGame objects: one bookmaker holding
// exactly the market slices the existing JS helpers (moneylinePrice,
// totalLine, pregame-facts' findMarket) read. The synthetic shape is what
// keeps the semantics identical - the unchanged helpers run over it and pick
// the same first-match values the full board would have given them. Only
// homeTeam / awayTeam / commenceTime and those market slices are populated;
// nothing else on an OddsGame is read by these callers.

// jsonb_array_elements raises on a non-array, and a missing key yields SQL NULL.
// Both are "nothing here" to the old JS (which would have thrown on a
// malformed board rather than skipped it, so this is strictly more lenient).
const arr = (expr: string) => `(CASE WHEN jsonb_typeof(${expr}) = 'array' THEN ${expr} ELSE '[]'::jsonb END)`;

// [name, price] outcome pairs; price is omitted (not null) when the outcome had
// no price key, so the JS side sees `undefined` exactly as before.
const OUTCOME_PAIR = `CASE WHEN jsonb_exists(o.oc, 'price') THEN jsonb_build_array(o.oc->'name', o.oc->'price') ELSE jsonb_build_array(o.oc->'name') END`;

// Tendencies (moneylinePrice / totalLine): "first bookmaker that has it".
//   ml : the outcomes of each bookmaker's FIRST h2h market, flattened in
//        (bookmaker order, outcome order), keeping only the first outcome of
//        each distinct name. The first name match in that list is the first
//        name match moneylinePrice would find bookmaker by bookmaker: any
//        later outcome with the same name could never be the first match for
//        a query its earlier twin didn't already answer. (A board lists every
//        bookmaker's pair of outcomes; this keeps two entries per game.)
//   pt : the first outcome carrying a `point` key, walking bookmakers in order
//        and using each bookmaker's FIRST totals market - totalLine's rule,
//        including its `!== undefined` (an explicit JSON null point counts).
const TENDENCY_COLS = `
         g.ord::int AS ord,
         g.game->'homeTeam' AS "homeTeam",
         g.game->'awayTeam' AS "awayTeam",
         g.game->'commenceTime' AS "commenceTime",
         (SELECT COALESCE(jsonb_agg(d.pair ORDER BY d.bord, d.oord), '[]'::jsonb)
            FROM (
              SELECT DISTINCT ON (o.oc->'name') b.bord, o.oord, ${OUTCOME_PAIR} AS pair
                FROM jsonb_array_elements(${arr("g.game->'bookmakers'")}) WITH ORDINALITY AS b(bk, bord)
                CROSS JOIN LATERAL (
                  SELECT m.mk FROM jsonb_array_elements(${arr("b.bk->'markets'")}) WITH ORDINALITY AS m(mk, mord)
                   WHERE m.mk->>'key' = 'h2h' ORDER BY m.mord LIMIT 1
                ) fm
                CROSS JOIN LATERAL jsonb_array_elements(${arr("fm.mk->'outcomes'")}) WITH ORDINALITY AS o(oc, oord)
               ORDER BY o.oc->'name', b.bord, o.oord
            ) d
         ) AS ml,
         (SELECT jsonb_build_array(o.oc->'point')
            FROM jsonb_array_elements(${arr("g.game->'bookmakers'")}) WITH ORDINALITY AS b(bk, bord)
            CROSS JOIN LATERAL (
              SELECT m.mk FROM jsonb_array_elements(${arr("b.bk->'markets'")}) WITH ORDINALITY AS m(mk, mord)
               WHERE m.mk->>'key' = 'totals' ORDER BY m.mord LIMIT 1
            ) fm
            CROSS JOIN LATERAL jsonb_array_elements(${arr("fm.mk->'outcomes'")}) WITH ORDINALITY AS o(oc, oord)
           WHERE jsonb_exists(o.oc, 'point')
           ORDER BY b.bord, o.oord LIMIT 1
         ) AS pt`;

// Pregame facts (pregame-facts.ts findMarket): "first bookmaker that carries the
// market", then that ONE market's outcomes.
//   ml : all outcomes of the first bookmaker's first h2h market ([] if none).
//   pt : the first `point`-bearing outcome of the first bookmaker's first totals
//        market (NULL if that market has none - the old code stopped at the
//        first bookmaker with a totals market too, it did not keep looking).
const PREGAME_COLS = `
         g.ord::int AS ord,
         g.game->'homeTeam' AS "homeTeam",
         g.game->'awayTeam' AS "awayTeam",
         g.game->'commenceTime' AS "commenceTime",
         (SELECT COALESCE(jsonb_agg(${OUTCOME_PAIR} ORDER BY o.oord), '[]'::jsonb)
            FROM (
              SELECT m.mk FROM jsonb_array_elements(${arr("g.game->'bookmakers'")}) WITH ORDINALITY AS b(bk, bord)
               CROSS JOIN LATERAL jsonb_array_elements(${arr("b.bk->'markets'")}) WITH ORDINALITY AS m(mk, mord)
               WHERE m.mk->>'key' = 'h2h' ORDER BY b.bord, m.mord LIMIT 1
            ) fm
            CROSS JOIN LATERAL jsonb_array_elements(${arr("fm.mk->'outcomes'")}) WITH ORDINALITY AS o(oc, oord)
         ) AS ml,
         (SELECT jsonb_build_array(o.oc->'point')
            FROM (
              SELECT m.mk FROM jsonb_array_elements(${arr("g.game->'bookmakers'")}) WITH ORDINALITY AS b(bk, bord)
               CROSS JOIN LATERAL jsonb_array_elements(${arr("b.bk->'markets'")}) WITH ORDINALITY AS m(mk, mord)
               WHERE m.mk->>'key' = 'totals' ORDER BY b.bord, m.mord LIMIT 1
            ) fm
            CROSS JOIN LATERAL jsonb_array_elements(${arr("fm.mk->'outcomes'")}) WITH ORDINALITY AS o(oc, oord)
           WHERE jsonb_exists(o.oc, 'point')
           ORDER BY o.oord LIMIT 1
         ) AS pt`;

type ProjectionRow = {
  ord: number;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
  ml: unknown[][];
  pt: [number | null] | null;
};

// Rebuilds the minimal OddsGame the unchanged helpers read (see header).
export function synthesizeOddsGame(row: ProjectionRow): OddsGame {
  const outcomes = row.ml.map((pair) => (pair.length > 1 ? { name: pair[0], price: pair[1] } : { name: pair[0] }));
  const markets: { key: string; outcomes: unknown[] }[] = [{ key: "h2h", outcomes }];
  if (row.pt) markets.push({ key: "totals", outcomes: [{ point: row.pt[0] }] });
  return {
    homeTeam: row.homeTeam,
    awayTeam: row.awayTeam,
    commenceTime: row.commenceTime,
    bookmakers: [{ markets }],
  } as unknown as OddsGame;
}

// Every OddsSnapshot game for a sport, in (fetchDate, position-in-board)
// order, as synthetic OddsGames for recomputeTeamTendencies. The old code
// flattened `findMany({ where: { sportKey } })` with NO orderBy, i.e. whatever
// order the heap happened to return; ties between duplicate appearances of one
// game (identical commenceTime across several daily snapshots) resolve to the
// first in that array, so the order is now pinned to fetchDate ascending -
// which is also the order the heap has in practice (one row inserted per day).
export async function getOddsGamesForTendencies(sportKey: string): Promise<{ games: OddsGame[]; snapshotCount: number }> {
  const [rows, counts] = await Promise.all([
    prisma.$queryRaw<ProjectionRow[]>(Prisma.sql`
      SELECT ${Prisma.raw(TENDENCY_COLS)}
      FROM odds_snapshots s
      CROSS JOIN LATERAL jsonb_array_elements(${Prisma.raw(arr("s.data"))}) WITH ORDINALITY AS g(game, ord)
      WHERE s."sportKey" = ${sportKey}
      ORDER BY s."fetchDate", g.ord`),
    prisma.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT count(*)::int AS n FROM odds_snapshots WHERE "sportKey" = ${sportKey}`),
  ]);
  return { games: rows.map(synthesizeOddsGame), snapshotCount: counts[0]?.n ?? 0 };
}

// One day's board for pregame-facts / the pregame sync, in board order. No
// snapshot row and an empty board both come back as [] - the only caller
// treats them identically (no candidate game -> null).
export async function getPregameSnapshotGames(sportKey: string, fetchDate: string): Promise<OddsGame[]> {
  const rows = await prisma.$queryRaw<ProjectionRow[]>(Prisma.sql`
    SELECT ${Prisma.raw(PREGAME_COLS)}
    FROM odds_snapshots s
    CROSS JOIN LATERAL jsonb_array_elements(${Prisma.raw(arr("s.data"))}) WITH ORDINALITY AS g(game, ord)
    WHERE s."sportKey" = ${sportKey} AND s."fetchDate" = ${fetchDate}
    ORDER BY g.ord`);
  return rows.map(synthesizeOddsGame);
}

// The most recent snapshot by fetchDate (what `findFirst({ orderBy: { fetchDate:
// "desc" } })` returned), or null when the sport has none.
export async function getLatestPregameSnapshot(sportKey: string): Promise<{ fetchDate: string; games: OddsGame[] } | null> {
  const latest = await prisma.$queryRaw<{ fetchDate: string }[]>(Prisma.sql`
    SELECT "fetchDate" FROM odds_snapshots WHERE "sportKey" = ${sportKey} ORDER BY "fetchDate" DESC LIMIT 1`);
  if (latest.length === 0) return null;
  return { fetchDate: latest[0].fetchDate, games: await getPregameSnapshotGames(sportKey, latest[0].fetchDate) };
}

// /live's carried-over-from-yesterday games (getYesterdayOddsForSport, odds.ts).
// The whole board is merged into the page's odds list, but every reader of a
// yesterday game uses only its top-level fields (id, teams, commenceTime - dedup,
// pick matching, ordering, links) and, for the few still-live ones that render
// a card, `bookmakers[0].title` plus the FIRST h2h / spreads / totals market
// found walking the bookmakers in order (LiveScoreboard's findMarketAcrossBooks).
// So each game keeps every top-level key except `bookmakers`, and its bookmakers
// shrink to the books those readers can reach - the first one, and the first
// one carrying each of the three markets - with only those three markets kept
// (order, duplicates and every other key on a kept book/market untouched). The
// stored board is typically 70-320 kB per snapshot (props can add far more for
// NFL); the projection is a few kB.
const LIVE_MARKET_KEYS = ["h2h", "spreads", "totals"] as const;

export async function getYesterdayBoardGames(sportKey: string, fetchDate: string): Promise<OddsGame[]> {
  const rows = await prisma.$queryRaw<{ games: OddsGame[] }[]>(Prisma.sql`
    SELECT COALESCE(
             (SELECT jsonb_agg(
                       (g.elem - 'bookmakers') || jsonb_build_object('bookmakers', bb.books)
                       ORDER BY g.ord)
                FROM jsonb_array_elements(${Prisma.raw(arr("s.data"))}) WITH ORDINALITY AS g(elem, ord)
                CROSS JOIN LATERAL (
                  SELECT COALESCE(
                           jsonb_agg((f.bk - 'markets') || jsonb_build_object('markets', f.ms) ORDER BY f.bord)
                             FILTER (WHERE f.bord = 1
                                        OR (f.has_h2h AND NOT f.seen_h2h)
                                        OR (f.has_spreads AND NOT f.seen_spreads)
                                        OR (f.has_totals AND NOT f.seen_totals)),
                           '[]'::jsonb) AS books
                    FROM (
                      SELECT w.bk, w.bord, w.ms, w.has_h2h, w.has_spreads, w.has_totals,
                             COALESCE(bool_or(w.has_h2h) OVER prev, false) AS seen_h2h,
                             COALESCE(bool_or(w.has_spreads) OVER prev, false) AS seen_spreads,
                             COALESCE(bool_or(w.has_totals) OVER prev, false) AS seen_totals
                        FROM (
                          SELECT b.bk, b.bord, x.ms,
                                 EXISTS (SELECT 1 FROM jsonb_array_elements(x.ms) e WHERE e->>'key' = ${LIVE_MARKET_KEYS[0]}) AS has_h2h,
                                 EXISTS (SELECT 1 FROM jsonb_array_elements(x.ms) e WHERE e->>'key' = ${LIVE_MARKET_KEYS[1]}) AS has_spreads,
                                 EXISTS (SELECT 1 FROM jsonb_array_elements(x.ms) e WHERE e->>'key' = ${LIVE_MARKET_KEYS[2]}) AS has_totals
                            FROM jsonb_array_elements(${Prisma.raw(arr("g.elem->'bookmakers'"))}) WITH ORDINALITY AS b(bk, bord)
                            CROSS JOIN LATERAL (
                              SELECT COALESCE(jsonb_agg(m.mk ORDER BY m.mord), '[]'::jsonb) AS ms
                                FROM jsonb_array_elements(${Prisma.raw(arr("b.bk->'markets'"))}) WITH ORDINALITY AS m(mk, mord)
                               WHERE m.mk->>'key' IN (${Prisma.join([...LIVE_MARKET_KEYS])})
                            ) x
                        ) w
                      WINDOW prev AS (ORDER BY w.bord ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
                    ) f
                ) bb
             ),
             '[]'::jsonb
           ) AS games
    FROM odds_snapshots s
    WHERE s."sportKey" = ${sportKey} AND s."fetchDate" = ${fetchDate}
  `);
  return rows.length > 0 ? rows[0].games : [];
}
