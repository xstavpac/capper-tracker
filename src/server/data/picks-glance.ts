// Read-only aggregates for the /picks "at a glance" row. Every card is ranked and cut to
// GLANCE_COUNT rows in the database: nothing here returns a pick row to the app.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { easternDateRange } from "@/lib/dates";
import { WIN_UNITS } from "@/server/data/capper-list-aggregates";
import { uwEffSql } from "@/server/data/cappers-page-aggregates";
import { round2HalfUpSql } from "@/server/data/page-aggregate-fragments";
import { LIVE_SPORTS, getTickerOddsForSport } from "@/server/data/odds";
import { liveGameHref, type PickGame } from "@/lib/pick-game-link";
import { sideGroupKey } from "@/lib/pick-display";

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

// A Most Backed row: one side of one market of one game, with the distinct cappers on it.
// `side`: HOME / AWAY / DRAW (moneyline, spread), OVER / UNDER (game totals), NRFI / YRFI.
// `line`: the side's most common line among those picks (the lowest on a tie), null when none has one.
export type MostBackedRow = {
  sportName: string;
  homeTeam: string;
  awayTeam: string;
  gameTime: Date;
  betType: string;
  period: string;
  side: string;
  line: number | null;
  cappers: number;
};

// A group needs this many distinct cappers to be a consensus: to get a pill, and to be in Most Backed.
export const CONSENSUS_MIN_CAPPERS = 2;

// The side a pick is on, from fields stored at import and never from its text: pickedSide for a
// moneyline or spread, the stamped category for a game total (…OVER / …UNDER) and for NRFI / YRFI.
// NULL for a market with no stored side: team totals and player props. storedSide
// (lib/pick-display.ts) is the same rule for a loaded pick.
const SIDE_SQL = Prisma.sql`CASE
  WHEN p."betType" IN ('MONEYLINE', 'SPREAD') THEN p."pickedSide"::text
  WHEN p."betType" = 'TOTAL' AND p.category LIKE '%OVER' THEN 'OVER'
  WHEN p."betType" = 'TOTAL' AND p.category LIKE '%UNDER' THEN 'UNDER'
  WHEN p."betType" = 'NRFI' AND p.category IN ('NRFI', 'YRFI') THEN p.category
END`;

// The consensus on every side of the day: sideGroupKey -> distinct cappers, for the groups with at
// least CONSENSUS_MIN_CAPPERS. A group is a game + market + side (home team, away team, start time,
// bet type, period, side) over ALL of the day's picks, whatever their status and whatever the page
// is filtered to - so a pill reads the same number under any filter. One small row per group; no
// pick leaves the database.
export async function getDayConsensus(userId: string, startDateKey: string, endDateKey: string): Promise<Map<string, number>> {
  const { start, end } = easternDateRange(startDateKey, endDateKey);
  const rows = await prisma.$queryRaw<{ homeTeam: string; awayTeam: string; gameTime: Date; bt: string; period: string; side: string; n: number }[]>(Prisma.sql`
    SELECT b."homeTeam", b."awayTeam", b."gameTime", b.bt, b.period, b.side, count(DISTINCT b."capperId")::int AS n
    FROM (
      SELECT p."capperId", p."homeTeam", p."awayTeam", p."gameTime", p."betType"::text AS bt, p.period::text AS period, ${SIDE_SQL} AS side
      FROM picks p
      WHERE p."userId" = ${userId} AND p."gameTime" >= ${ts(start)} AND p."gameTime" < ${ts(end)}
    ) b
    WHERE b.side IS NOT NULL
    GROUP BY b."homeTeam", b."awayTeam", b."gameTime", b.bt, b.period, b.side
    HAVING count(DISTINCT b."capperId") >= ${CONSENSUS_MIN_CAPPERS}
  `);
  return new Map(rows.map((r) => [sideGroupKey({ homeTeam: r.homeTeam, awayTeam: r.awayTeam, gameTime: new Date(r.gameTime), betType: r.bt, period: r.period }, r.side), Number(r.n)]));
}

// Most Backed: the consensus sides of the day's games that have NOT started and still have a pending
// pick, cut to GLANCE_COUNT in the database. `upcoming` is every pending pick of the day whose game
// has not started, whatever its market.
//
// A row's count is getDayConsensus's count for the same group (every pick of the day on that side),
// so it is always the number on that side's "N cappers on this side" pills. Groups under
// CONSENSUS_MIN_CAPPERS are not listed. Different lines on one side (-3 and -3.5) are one row; it
// carries the most common line.
// Ranked by cappers desc, then earliest start, then the side's label (team or Over / Under, then the
// line), then the rest of the key so equal rows never swap.
export async function getMostBacked(userId: string, startDateKey: string, endDateKey: string, now: Date = new Date()): Promise<{ rows: MostBackedRow[]; upcoming: number }> {
  const { start, end } = easternDateRange(startDateKey, endDateKey);
  const rows = await prisma.$queryRaw<(Omit<MostBackedRow, "cappers" | "sportName"> & { upcoming: number; rk: number | null; sport: string; n: number })[]>(Prisma.sql`
    WITH base AS (
      SELECT p."capperId", p."homeTeam", p."awayTeam", p."gameTime", p."betType"::text AS bt, p.period::text AS period, p.line, s.name AS sport,
        (p.status = 'PENDING') AS pending, ${SIDE_SQL} AS side
      FROM picks p
      JOIN sports s ON s.id = p."sportId"
      WHERE p."userId" = ${userId}
        AND p."gameTime" >= ${ts(start)} AND p."gameTime" < ${ts(end)} AND p."gameTime" > ${ts(now)}
    ),
    g AS (
      SELECT b."homeTeam", b."awayTeam", b."gameTime", b.bt, b.period, b.side, min(b.sport) AS sport,
        count(DISTINCT b."capperId")::int AS n,
        mode() WITHIN GROUP (ORDER BY b.line) AS line
      FROM base b
      WHERE b.side IS NOT NULL
      GROUP BY b."homeTeam", b."awayTeam", b."gameTime", b.bt, b.period, b.side
      HAVING count(DISTINCT b."capperId") >= ${CONSENSUS_MIN_CAPPERS} AND bool_or(b.pending)
    ),
    top AS (
      SELECT g.*, (row_number() OVER (
        ORDER BY g.n DESC, g."gameTime" ASC,
          lower(CASE g.side WHEN 'HOME' THEN g."homeTeam" WHEN 'AWAY' THEN g."awayTeam" ELSE g.side END) COLLATE "C",
          g.line ASC NULLS FIRST, g."homeTeam" COLLATE "C", g."awayTeam" COLLATE "C", g.bt COLLATE "C", g.period COLLATE "C", g.side COLLATE "C"
      ))::int AS rk
      FROM g
    )
    SELECT t.upcoming, top.rk, top."homeTeam", top."awayTeam", top."gameTime", top.bt AS "betType", top.period, top.side, top.line, top.sport, top.n
    FROM (SELECT (count(*) FILTER (WHERE pending))::int AS upcoming FROM base) t
    LEFT JOIN top ON top.rk <= ${GLANCE_COUNT}
  `);
  return {
    upcoming: Number(rows[0]?.upcoming ?? 0),
    rows: rows
      .filter((r) => r.rk !== null)
      .sort((x, y) => Number(x.rk) - Number(y.rk))
      .map((r) => ({
        sportName: r.sport,
        homeTeam: r.homeTeam,
        awayTeam: r.awayTeam,
        // A timestamp without time zone comes back as that wall time read as UTC, which is what it holds.
        gameTime: new Date(r.gameTime),
        betType: r.betType,
        period: r.period,
        side: r.side,
        line: r.line === null ? null : Number(r.line),
        cappers: Number(r.n),
      })),
  };
}

// The /live game page for each game, where today's odds slate has it: `key` -> href. The slate is the
// layout ticker's own cached read (getTickerOddsForSport: ids, teams and start times, no prices), so
// this adds no database read to a page load. A game the slate does not carry (another day's, a league
// with no Live board, a feed failure) simply has no link.
export async function getLiveGameHrefs(games: (PickGame & { key: string; sportName: string })[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const bySport = new Map<string, typeof games>();
  for (const g of games) {
    const sportKey = LIVE_SPORTS.find((s) => s.label === g.sportName)?.key;
    if (sportKey) bySport.set(sportKey, [...(bySport.get(sportKey) ?? []), g]);
  }
  await Promise.all(
    Array.from(bySport.entries()).map(async ([sportKey, group]) => {
      try {
        const slate = await getTickerOddsForSport(sportKey);
        for (const g of group) {
          const href = liveGameHref(slate, g, sportKey);
          if (href) out.set(g.key, href);
        }
      } catch (err) {
        console.error("[picks-glance] no game links for", sportKey, err);
      }
    })
  );
  return out;
}
