// FROZEN pre-migration reference for /cappers/[capperId] (docs/design/dashboard-capper-detail-
// egress.md §8 "legacy"). It is the derivation the page ran inline until the capper-detail egress
// PR: fetch every pick of the capper with three relation includes (getPicksForCapper, which stays
// in picks.ts for capper-comparison.ts), then compute every section from that one array in JS.
// Kept ONLY so capper-detail-acceptance-test.ts and scripts/t2-harness/capper-detail-parity.ts have
// something to diff the one-statement path against, and deleted after the observation period.
// Nothing under src/ outside a *-acceptance-test.ts file may import this module
// (legacy-reference-import-guard-acceptance-test.ts enforces it).
//
// Deliberate differences from the page code it was extracted from, for a fair comparison rather
// than a behavior change:
//   - `now` is an explicit parameter (the page's filters read the clock), so both paths run at the
//     same pinned instant (filterPicksByGameWindow takes it as an optional third argument);
//   - the picks are put in the explicit total order (gameTime, createdAt, id) before use;
//   - the result is the view the page reads (CapperDetailView), not the page's local variables, and
//     the recent picks / stats are narrowed to the fields the page renders.
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { comparePicksChronological } from "@/lib/pick-order";
import type { CapperDetailParams, CapperDetailView } from "@/server/data/capper-detail";
import {
  DEFAULT_CHIP_SET,
  chipSetForLeague,
  computeBestOddsRange,
  computeCategoryBreakdown,
  computeConsistency,
  computeMomentum,
  computeStats,
  computeUnitsChartData,
  filterPicksByGameWindow,
  selectCapperRecentPicks,
} from "@/server/data/stats";

export type LegacyCapperPick = Prisma.PickGetPayload<{ include: { capper: true; sport: true; league: true } }>;

// getPicksForCapper, verbatim.
export async function loadLegacyCapperPicks(userId: string, capperId: string): Promise<LegacyCapperPick[]> {
  return prisma.pick.findMany({
    where: { userId, capperId },
    include: { capper: true, sport: true, league: true },
    orderBy: [{ gameTime: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
}

const recordView = (s: ReturnType<typeof computeStats>) => ({ wins: s.wins, losses: s.losses, pushes: s.pushes, roi: s.roi, netUnits: s.netUnits });

export function computeCapperDetailLegacy(rows: LegacyCapperPick[], params: CapperDetailParams, now: Date): CapperDetailView {
  const picks = [...rows].sort(comparePicksChronological);
  const { window, categoryWindow } = params;

  const stats = computeStats(filterPicksByGameWindow(picks, window, now));
  const allTimeStats = computeStats(picks);
  const allTimeUniversalBreakdown = computeCategoryBreakdown(picks, DEFAULT_CHIP_SET);
  const momentum = computeMomentum(picks);
  const universalBreakdown = computeCategoryBreakdown(filterPicksByGameWindow(picks, window, now), DEFAULT_CHIP_SET);

  const categoryBreakdownsBySport = Array.from(new Set(picks.map((p) => p.sport.name)))
    .map((sportName) => {
      const sportPicks = picks.filter((p) => p.sport.name === sportName);
      return { sportName, sportPicks, breakdown: computeCategoryBreakdown(sportPicks, chipSetForLeague(sportName)) };
    })
    .filter((s) => s.breakdown.length > 0)
    .sort((a, b) => b.breakdown.reduce((sum, item) => sum + item.count, 0) - a.breakdown.reduce((sum, item) => sum + item.count, 0));

  const selectedCategorySport =
    categoryBreakdownsBySport.find((s) => s.sportName === params.categorySport)?.sportName ?? categoryBreakdownsBySport[0]?.sportName;
  const activeSportPicks = categoryBreakdownsBySport.find((s) => s.sportName === selectedCategorySport)?.sportPicks ?? [];

  const activeSportPicksInWindow = filterPicksByGameWindow(activeSportPicks, categoryWindow, now);
  const activeCategoryBreakdown = computeCategoryBreakdown(activeSportPicksInWindow, chipSetForLeague(selectedCategorySport ?? ""));
  const activeSportStats = activeSportPicksInWindow.length > 0 ? computeStats(activeSportPicksInWindow) : null;
  const activeSportChartData = computeUnitsChartData(activeSportPicksInWindow);

  const chartData = computeUnitsChartData(filterPicksByGameWindow(picks, window, now));
  const { picks: recentPicks, scopedSport: recentPicksSport } = selectCapperRecentPicks(picks, selectedCategorySport);

  return {
    stats: recordView(stats),
    currentStreak: allTimeStats.currentStreak,
    momentum,
    allTimeUniversalBreakdown,
    universalBreakdown,
    chartData,
    sportTabs: categoryBreakdownsBySport.map((s) => s.sportName),
    selectedCategorySport,
    activeCategoryBreakdown,
    activeSportStats: activeSportStats ? recordView(activeSportStats) : null,
    activeSportChartData,
    recentPicks: recentPicks.map((p) => ({
      id: p.id,
      awayTeam: p.awayTeam,
      homeTeam: p.homeTeam,
      betDetail: p.betDetail,
      betType: p.betType,
      line: p.line,
      odds: p.odds,
      units: p.units,
      gameTime: p.gameTime,
      status: p.status,
    })),
    recentPicksSport,
    trackedSinceMs: picks.length > 0 ? Math.min(...picks.map((p) => p.datePosted.getTime())) : null,
    lastPickMs: picks.length > 0 ? Math.max(...picks.map((p) => p.datePosted.getTime())) : null,
    bestOddsRange: computeBestOddsRange(picks),
    consistency: computeConsistency(picks),
    associatedPickCount: picks.length,
  };
}

// First differing path between two JSON-shaped values, or null. `===` on numbers with -0 == +0
// (design doc §5), NaN == NaN, Dates by instant; key sets must match exactly (undefined-valued
// keys are ignored so an absent and an undefined `selectedCategorySport` compare equal).
export function firstDiff(a: unknown, b: unknown, path = "$"): string | null {
  if (typeof a === "number" && typeof b === "number") return a === b || (Number.isNaN(a) && Number.isNaN(b)) ? null : `${path}: ${a} !== ${b}`;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime() ? null : `${path}: ${a.toISOString()} !== ${b.toISOString()}`;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b ? null : `${path}: ${String(a)} !== ${String(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs non-array`;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} !== ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const defined = (o: object) => Object.keys(o).filter((k) => (o as Record<string, unknown>)[k] !== undefined).sort();
  const ka = defined(a);
  const kb = defined(b);
  if (ka.join(",") !== kb.join(",")) return `${path}: keys [${ka}] !== [${kb}]`;
  for (const k of ka) {
    const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}
