// Read-only aggregates for the /picks "at a glance" row. Every card is ranked and cut to
// GLANCE_COUNT rows in the database: nothing here returns a pick row to the app.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { easternDateRange } from "@/lib/dates";
import { WIN_UNITS } from "@/server/data/capper-list-aggregates";
import { uwEffSql } from "@/server/data/cappers-page-aggregates";
import { round2HalfUpSql } from "@/server/data/page-aggregate-fragments";

// gameTime is a timestamp WITHOUT time zone holding UTC. A bare Date parameter is sent as timestamptz
// and converted in the session's zone, so each bound is written as UTC text instead (as
// cappers-page-aggregates does).
const ts = (d: Date) => Prisma.sql`${d.toISOString()}::timestamp`;

// Rows a card shows.
export const GLANCE_COUNT = 5;

// A Winners / Losers row: the capper's graded picks of the day. `sports` are the leagues those
// picks were in, by name.
export type GlanceCapper = { capperId: string; name: string; sports: string[]; wins: number; losses: number; pushes: number; netUnits: number };

// The day's winners and losers in one statement: net units over the graded picks (WIN / LOSS / PUSH)
// whose GAME is in the Eastern day range - the same picks the /picks stat cards count - per capper,
// test cappers left out. Units are the /cappers expression (WIN_UNITS, uw_eff, rounded like its sort
// keys), so a capper's number here is the one shown everywhere else; a non-finite value (a win at
// odds 0) has no label to draw and is in neither list.
//   winners: net units > 0, ranked net units desc, then wins desc, then name.
//   losers:  net units < 0, ranked net units asc (most negative first), then losses desc, then name.
// The name order is byte order of the lowercased name, then the name, then the id, so equal rows
// never swap between loads.
export async function getDayWinnersAndLosers(userId: string, startDateKey: string, endDateKey: string): Promise<{ winners: GlanceCapper[]; losers: GlanceCapper[] }> {
  const { start, end } = easternDateRange(startDateKey, endDateKey);
  const byName = Prisma.sql`lower(n.name) COLLATE "C", n.name COLLATE "C", n.cid COLLATE "C"`;
  const cols = Prisma.sql`n.cid AS "capperId", n.name, n.sports, n.wins, n.losses, n.pushes, n.net AS "netUnits"`;
  const rows = await prisma.$queryRaw<(GlanceCapper & { side: "w" | "l"; rk: number })[]>(Prisma.sql`
    WITH roster AS (SELECT id, name FROM cappers WHERE "userId" = ${userId} AND NOT "isTest"),
    a AS (
      SELECT p."capperId" AS cid,
        (count(*) FILTER (WHERE p.status = 'WIN'))::int AS wins,
        (count(*) FILTER (WHERE p.status = 'LOSS'))::int AS losses,
        (count(*) FILTER (WHERE p.status = 'PUSH'))::int AS pushes,
        COALESCE(sum(${WIN_UNITS}) FILTER (WHERE p.status = 'WIN' AND p.odds <> 0), 0)::float8 AS "unitsWon",
        COALESCE(sum(p.units) FILTER (WHERE p.status = 'LOSS'), 0)::float8 AS "unitsLost",
        COALESCE(bit_or(CASE WHEN p.units > 0 THEN 1 WHEN p.units < 0 THEN 2 ELSE 4 END) FILTER (WHERE p.status = 'WIN' AND p.odds = 0), 0)::int AS "zeroOddsWinFlags",
        array_agg(DISTINCT s.name ORDER BY s.name) AS sports
      FROM picks p
      JOIN sports s ON s.id = p."sportId"
      WHERE p."userId" = ${userId} AND p.status IN ('WIN', 'LOSS', 'PUSH')
        AND p."gameTime" >= ${ts(start)} AND p."gameTime" < ${ts(end)}
      GROUP BY p."capperId"
    ),
    n AS (
      SELECT g.cid, r.name, g.sports, g.wins, g.losses, g.pushes, ${round2HalfUpSql(Prisma.sql`g.net_raw`)} AS net
      FROM (SELECT a.*, ${uwEffSql("a")} - a."unitsLost" AS net_raw FROM a) g
      JOIN roster r ON r.id = g.cid
    ),
    w AS (SELECT (row_number() OVER (ORDER BY n.net DESC, n.wins DESC, ${byName}))::int AS rk, ${cols} FROM n WHERE n.net > 0 AND n.net < 'Infinity'::float8),
    l AS (SELECT (row_number() OVER (ORDER BY n.net ASC, n.losses DESC, ${byName}))::int AS rk, ${cols} FROM n WHERE n.net < 0 AND n.net > '-Infinity'::float8)
    SELECT 'w' AS side, w.* FROM w WHERE w.rk <= ${GLANCE_COUNT}
    UNION ALL
    SELECT 'l' AS side, l.* FROM l WHERE l.rk <= ${GLANCE_COUNT}
  `);
  const side = (s: "w" | "l"): GlanceCapper[] =>
    rows
      .filter((r) => r.side === s)
      .sort((x, y) => Number(x.rk) - Number(y.rk))
      .map((r) => ({ capperId: r.capperId, name: r.name, sports: r.sports ?? [], wins: Number(r.wins), losses: Number(r.losses), pushes: Number(r.pushes), netUnits: Number(r.netUnits) }));
  return { winners: side("w"), losers: side("l") };
}
