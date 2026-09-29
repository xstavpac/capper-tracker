// Read-only aggregates for the /picks ledger's summary strip and capper
// records. Both are single grouped queries that return a handful of rows -
// nothing here fetches pick rows to the app (egress: see
// docs/design/picks-by-capper-egress.md).
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { easternDateRange } from "@/lib/dates";
import { WIN_UNITS } from "@/server/data/capper-list-aggregates";
import { LIVE_SPORTS } from "@/server/data/odds";
import { matchGameResult } from "@/server/data/grading";
import { recordStatsFromTotals, unitsWonOnBet, type RecordTotals } from "@/server/data/stats";

export type PicksSummaryFilters = {
  capperId?: string;
  sportId?: string;
  status?: string;
  startDateKey: string;
  endDateKey: string;
};

export type PicksSummary = {
  wins: number;
  losses: number;
  pushes: number;
  pending: number;
  netUnits: number;
  roi: number;
};

function toSummary(t: RecordTotals, pending: number): PicksSummary {
  const s = recordStatsFromTotals(t);
  return { wins: s.wins, losses: s.losses, pushes: s.pushes, pending, netUnits: s.netUnits, roi: s.roi };
}

// One grouped query over the same filter set the list uses (minus bet type,
// which is derived from text and can't be expressed in SQL - see
// summarizeLoadedPicks). Same win/loss/push, units and ROI math as /cappers
// (WIN_UNITS + recordStatsFromTotals).
export async function getPicksSummary(userId: string, f: PicksSummaryFilters): Promise<PicksSummary> {
  const { start, end } = easternDateRange(f.startDateKey, f.endDateKey);
  const rows = await prisma.$queryRaw<
    {
      wins: number;
      losses: number;
      pushes: number;
      pending: number;
      unitsWon: number;
      unitsLost: number;
      unitsRisked: number;
    }[]
  >(Prisma.sql`
    SELECT
      (count(*) FILTER (WHERE p.status = 'WIN'))::int AS wins,
      (count(*) FILTER (WHERE p.status = 'LOSS'))::int AS losses,
      (count(*) FILTER (WHERE p.status = 'PUSH'))::int AS pushes,
      (count(*) FILTER (WHERE p.status = 'PENDING'))::int AS pending,
      COALESCE(sum(${WIN_UNITS}) FILTER (WHERE p.status = 'WIN' AND p.odds <> 0), 0)::float8 AS "unitsWon",
      COALESCE(sum(p.units) FILTER (WHERE p.status = 'LOSS'), 0)::float8 AS "unitsLost",
      COALESCE(sum(p.units) FILTER (WHERE p.status IN ('WIN', 'LOSS', 'PUSH')), 0)::float8 AS "unitsRisked"
    FROM picks p
    WHERE p."userId" = ${userId}
      AND p."gameTime" >= ${start} AND p."gameTime" < ${end}
      ${f.capperId ? Prisma.sql`AND p."capperId" = ${f.capperId}` : Prisma.empty}
      ${f.sportId ? Prisma.sql`AND p."sportId" = ${f.sportId}` : Prisma.empty}
      ${f.status ? Prisma.sql`AND p.status = ${f.status}::"PickStatus"` : Prisma.empty}
  `);
  const r = rows[0];
  if (!r) return { wins: 0, losses: 0, pushes: 0, pending: 0, netUnits: 0, roi: 0 };
  return toSummary(r, r.pending);
}

// Same totals computed from rows the page already loaded. Used only when the
// bet-type chip is active: bet type is derived in JS (NRFI/YRFI from text,
// prop market re-parsed from betDetail) so it has no faithful SQL predicate,
// and the rows are already in memory - no extra query, no extra egress.
export function summarizeLoadedPicks(
  picks: { status: string; units: number; odds: number }[]
): PicksSummary {
  const t: RecordTotals = { wins: 0, losses: 0, pushes: 0, unitsWon: 0, unitsLost: 0, unitsRisked: 0 };
  let pending = 0;
  for (const p of picks) {
    if (p.status === "PENDING") pending++;
    else if (p.status === "WIN") {
      t.wins++;
      t.unitsRisked += p.units;
      if (p.odds !== 0) t.unitsWon += unitsWonOnBet(p.units, p.odds);
    } else if (p.status === "LOSS") {
      t.losses++;
      t.unitsLost += p.units;
      t.unitsRisked += p.units;
    } else if (p.status === "PUSH") {
      t.pushes++;
      t.unitsRisked += p.units;
    }
  }
  return toSummary(t, pending);
}

// All-time W-L for the cappers on the page, one grouped query.
export async function getCapperAllTimeRecords(
  userId: string,
  capperIds: string[]
): Promise<Map<string, { wins: number; losses: number }>> {
  const out = new Map<string, { wins: number; losses: number }>();
  if (capperIds.length === 0) return out;
  const rows = await prisma.pick.groupBy({
    by: ["capperId", "status"],
    where: { userId, capperId: { in: capperIds }, status: { in: ["WIN", "LOSS"] } },
    _count: { _all: true },
  });
  for (const r of rows) {
    const rec = out.get(r.capperId) ?? { wins: 0, losses: 0 };
    if (r.status === "WIN") rec.wins = r._count._all;
    else rec.losses = r._count._all;
    out.set(r.capperId, rec);
  }
  return out;
}

// Sports the user has at least one pick in (for the sport chips).
export async function getSportIdsWithPicks(userId: string): Promise<string[]> {
  const rows = await prisma.pick.groupBy({ by: ["sportId"], where: { userId } });
  return rows.map((r) => r.sportId);
}

// Final scores for settled picks, matched with the same matcher grading uses
// (matchGameResult) so the score shown is always the game the pick graded
// against. One query for the whole page: game_results rows in the picks'
// date span for the sports involved, narrow columns only. Picks with no match
// (ungraded-by-score, manual overrides, unsupported sport) are simply absent.
export async function getFinalScoresForPicks(
  picks: {
    id: string;
    sportName: string;
    status: string;
    gameTime: Date;
    homeTeam: string;
    awayTeam: string;
    betDetail: string | null;
    gameNumber: number | null;
  }[]
): Promise<Map<string, { home: number; away: number }>> {
  const out = new Map<string, { home: number; away: number }>();
  const settled = picks.filter((p) => p.status !== "PENDING" && p.status !== "CANCELLED");
  const keyByName = new Map(LIVE_SPORTS.map((s) => [s.label, s.key]));
  const sportKeys = Array.from(new Set(settled.map((p) => keyByName.get(p.sportName)).filter((k): k is string => !!k)));
  if (settled.length === 0 || sportKeys.length === 0) return out;

  const times = settled.map((p) => p.gameTime.getTime());
  const rows = await prisma.gameResult.findMany({
    where: {
      sportKey: { in: sportKeys },
      gameDate: { gte: new Date(Math.min(...times) - 2 * 86400000), lt: new Date(Math.max(...times) + 2 * 86400000) },
    },
    select: { sportKey: true, gameDate: true, homeTeam: true, awayTeam: true, homeScore: true, awayScore: true, gameNumber: true },
  });
  for (const p of settled) {
    const key = keyByName.get(p.sportName);
    if (!key) continue;
    const match = matchGameResult(
      rows.filter((r) => r.sportKey === key),
      p
    );
    if (match) out.set(p.id, { home: match.game.homeScore, away: match.game.awayScore });
  }
  return out;
}
