// Data the redesigned /cappers page needs beyond the per-capper leaderboard rows
// (pick-aggregates-cappers-adapter.ts): the last-20 sparkline series and the four
// overview stat cards. Kept in its own file so cappers.ts and the adapter stay
// untouched. Every query summarizes in the database; only small results come back.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { scorecardWindowRange, recordStatsFromTotals, type ScorecardWindow } from "@/server/data/stats";
import { ORDER_DESC, WIN_UNITS, queryCurrentStreaks, queryWindowTotals } from "@/server/data/capper-list-aggregates";

export const SPARKLINE_PICKS = 20;
export const HOT_STREAK_MIN = 5;
const DAY_MS = 86400000;

export type CapperSparkline = {
  // Cumulative units after each of the capper's last (up to) 20 decided picks,
  // oldest first, starting from 0. Not affected by the page's time window.
  points: number[];
  netUnits: number;
};

// The capper's last 20 WIN/LOSS picks in the canonical chronological order
// (gameTime, createdAt, id - same tie-break as the streak logic), across every
// sport. Pushes are flat and add nothing to a units line, so they are skipped.
export async function getCapperSparklines(userId: string): Promise<Map<string, CapperSparkline>> {
  const rows = await prisma.$queryRaw<{ capperId: string; delta: number }[]>(Prisma.sql`
    WITH r AS (
      SELECT
        p."capperId" AS cid,
        CASE WHEN p.status = 'WIN' THEN COALESCE(${WIN_UNITS}, 0) ELSE -p.units END::float8 AS delta,
        row_number() OVER (PARTITION BY p."capperId" ORDER BY ${ORDER_DESC}) AS rn
      FROM picks p
      WHERE p."userId" = ${userId} AND p.status IN ('WIN', 'LOSS')
    )
    SELECT cid AS "capperId", delta FROM r WHERE rn <= ${SPARKLINE_PICKS} ORDER BY cid, rn DESC
  `);

  const out = new Map<string, CapperSparkline>();
  for (const { capperId, delta } of rows) {
    let s = out.get(capperId);
    if (!s) {
      s = { points: [0], netUnits: 0 };
      out.set(capperId, s);
    }
    s.netUnits += delta;
    s.points.push(s.netUnits);
  }
  for (const s of out.values()) s.netUnits = Math.round(s.netUnits * 100) / 100;
  return out;
}

export type OverviewStats = {
  activeCappers: number;
  // Change against the immediately preceding period of the same length; null for
  // ALL, which has no earlier period to compare with.
  activeCappersDelta: number | null;
  picksThisWeek: number;
  // Percent change vs the 7 days before; null when last week had no picks.
  picksThisWeekPct: number | null;
  avgRoi: number;
  gradedPicks: number;
  hotStreaks: number;
};

async function activeCapperCount(userId: string, range: { start: Date; end: Date } | null): Promise<number> {
  const groups = await prisma.pick.groupBy({
    by: ["capperId"],
    where: { userId, ...(range ? { datePosted: { gte: range.start, lt: range.end } } : {}) },
  });
  return groups.length;
}

export async function getCappersOverview(userId: string, window: ScorecardWindow, now = new Date()): Promise<OverviewStats> {
  const range = scorecardWindowRange(window, now);
  const previous = range ? { start: new Date(range.start.getTime() - (range.end.getTime() - range.start.getTime())), end: range.start } : null;
  const weekStart = new Date(now.getTime() - 7 * DAY_MS);
  const priorWeekStart = new Date(now.getTime() - 14 * DAY_MS);

  const [active, activePrev, thisWeek, lastWeek, pooled, streaks] = await Promise.all([
    activeCapperCount(userId, range),
    previous ? activeCapperCount(userId, previous) : Promise.resolve(null),
    prisma.pick.count({ where: { userId, datePosted: { gte: weekStart, lt: now } } }),
    prisma.pick.count({ where: { userId, datePosted: { gte: priorWeekStart, lt: weekStart } } }),
    queryWindowTotals({ userId, pooled: true, windows: [window], now }),
    queryCurrentStreaks({ userId, windows: [window], now }),
  ]);

  const totals = pooled[0];
  const stats = recordStatsFromTotals({
    wins: totals?.wins ?? 0,
    losses: totals?.losses ?? 0,
    pushes: totals?.pushes ?? 0,
    unitsWon: totals?.unitsWon ?? 0,
    unitsLost: totals?.unitsLost ?? 0,
    unitsRisked: totals?.unitsRisked ?? 0,
  });

  return {
    activeCappers: active,
    activeCappersDelta: activePrev === null ? null : active - activePrev,
    picksThisWeek: thisWeek,
    picksThisWeekPct: lastWeek > 0 ? Math.round(((thisWeek - lastWeek) / lastWeek) * 1000) / 10 : null,
    avgRoi: stats.roi,
    gradedPicks: stats.wins + stats.losses + stats.pushes,
    hotStreaks: streaks.filter((s) => s.type === "WIN" && s.count >= HOT_STREAK_MIN).length,
  };
}
