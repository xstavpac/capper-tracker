// Everything /cappers/[capperId] derives from a capper's pick history, computed by ONE statement
// instead of by fetching every pick of the capper with three relation includes
// (docs/design/dashboard-capper-detail-egress.md PR 4; Q2, Q3, Q7, Q8, Q11).
//
// The statement is composed from the shared blocks in page-aggregate-fragments.ts:
//   totals       the hero record/ROI/net units for `window` (all sports)
//   sportTotals  the same totals for `categoryWindow`, one row per sport (the selected sport is
//                only known once the all-time tab list exists, so every sport comes back - Q3)
//   tiles        decided picks per (window, sport, category) for ALL / `window` / `categoryWindow`
//   firstKeys    each sport's first-appearance key, the stable tie-break of the sport-tab sort
//   recent       the newest 10 picks of every sport plus the newest 10 overall
//   series       the capper's DECIDED picks, narrow (no relations), in canonical order
//   meta         pick count / tracked-since / last-pick over every status
// and everything else runs the EXISTING JS over that narrow series (Q2, no SQL twins): the current
// streak (Q11), momentum, consistency, best odds range and both units charts (Q7, full fidelity,
// no downsampling). Only the totals involve SQL float math (ordered sums, as /cappers has done
// since #123); ROI / winPct / round2 / labels / the tab sort stay in stats.ts and are applied here
// to raw totals, so each rule keeps one implementation.
//
// No cache (Q8/Q9): `now` is taken per request and used for the SQL windows AND the JS window
// filters. capper-detail-legacy.ts is the frozen JS path this replaces;
// capper-detail-acceptance-test.ts and scripts/t2-harness/capper-detail-parity.ts hold the two equal.
import type { PickStatus } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { windowTotalsSelect, zeroOddsWinUnitsWon, type WindowTotals } from "@/server/data/capper-list-aggregates";
import {
  CAPPER_RECENT_ORDER_BY,
  DECIDED_SERIES_ORDER_BY,
  buildPageBundleQuery,
  capperPickMetaFromBundle,
  capperPickMetaSelect,
  capperRecentPicksFromRows,
  capperRecentPicksSelect,
  categoryTileRowsFromBundle,
  categoryTilesSelect,
  decidedSeriesSelect,
  narrowSeriesFromRows,
  queryPageBundle,
  sportFirstKeysFromBundle,
  sportFirstKeysSelect,
} from "@/server/data/page-aggregate-fragments";
import {
  DEFAULT_CHIP_SET,
  categoryBreakdownFromCounts,
  chipSetForLeague,
  computeBestOddsRange,
  computeConsistency,
  computeMomentum,
  computeUnitsChartData,
  currentStreak,
  filterPicksByGameWindow,
  recordStatsFromTotals,
  type CategoryBreakdownItem,
  type MomentumBreakdown,
  type OddsRangeStat,
  type ScorecardWindow,
  type UnitsChartPoint,
} from "@/server/data/stats";

export type CapperDetailParams = {
  window: ScorecardWindow;
  categoryWindow: ScorecardWindow;
  // The raw `?categorySport=` value; resolved against the capper's tabs below.
  categorySport?: string;
};

// The record fields the page renders (both the hero cards and the sport strip).
export type CapperRecordView = { wins: number; losses: number; pushes: number; roi: number; netUnits: number };

// The columns a recent-picks row (plus PickStatusButtons and formatPickLabel) reads.
export type CapperRecentPickView = {
  id: string;
  awayTeam: string;
  homeTeam: string;
  betDetail: string | null;
  betType: string;
  line: number | null;
  odds: number;
  units: number;
  gameTime: Date;
  status: PickStatus;
};

// Exactly what the page reads - nothing else is computed, so nothing else has to agree with legacy.
export type CapperDetailView = {
  stats: CapperRecordView; // `window`, all sports
  currentStreak: { type: "WIN" | "LOSS" | "NONE"; count: number }; // all-time
  momentum: MomentumBreakdown;
  allTimeUniversalBreakdown: CategoryBreakdownItem[]; // gates the "record by bet type" section
  universalBreakdown: CategoryBreakdownItem[]; // `window`
  chartData: UnitsChartPoint[]; // `window`, full fidelity
  sportTabs: string[]; // sports with >= 1 all-time tile, most tiles first
  selectedCategorySport: string | undefined;
  activeCategoryBreakdown: CategoryBreakdownItem[]; // selected sport x `categoryWindow`
  activeSportStats: CapperRecordView | null; // null when the selected sport has no pick in `categoryWindow`
  activeSportChartData: UnitsChartPoint[];
  recentPicks: CapperRecentPickView[];
  recentPicksSport: string | null;
  trackedSinceMs: number | null;
  lastPickMs: number | null;
  bestOddsRange: OddsRangeStat | null;
  consistency: { label: "Steady" | "Volatile"; cv: number } | null;
  associatedPickCount: number;
};

export function windowsForCapperDetail(p: Pick<CapperDetailParams, "window" | "categoryWindow">): ScorecardWindow[] {
  return Array.from(new Set<ScorecardWindow>(["ALL", p.window, p.categoryWindow]));
}

// A totals part keeps only the rows of ONE window: the bundle's `w` CTE carries every window any
// part needs, and each part reads only its own.
function onlyWindow(select: Prisma.Sql, window: ScorecardWindow): Prisma.Sql {
  return Prisma.sql`SELECT * FROM (${select}) t WHERE t."window" = ${window}`;
}

// The one statement. Exported so the measurement script runs exactly what production runs.
export function buildCapperDetailBundleQuery(userId: string, capperId: string, params: CapperDetailParams, now: Date) {
  const scope = { userId, capperId };
  return buildPageBundleQuery({
    windows: { windows: windowsForCapperDetail(params), now },
    parts: [
      { name: "totals", select: onlyWindow(windowTotalsSelect({ userId, capperIds: [capperId] }), params.window) },
      {
        name: "sportTotals",
        select: onlyWindow(windowTotalsSelect({ userId, capperIds: [capperId], groupBySport: true }), params.categoryWindow),
      },
      { name: "tiles", select: categoryTilesSelect({ ...scope, groupBySport: true }) },
      { name: "firstKeys", select: sportFirstKeysSelect(scope) },
      { name: "recent", select: capperRecentPicksSelect(scope), orderBy: CAPPER_RECENT_ORDER_BY },
      { name: "series", select: decidedSeriesSelect(scope), orderBy: DECIDED_SERIES_ORDER_BY },
      { name: "meta", select: capperPickMetaSelect(scope) },
    ],
  });
}

function recordFromTotals(t: WindowTotals | undefined): CapperRecordView {
  const r = recordStatsFromTotals({
    wins: t?.wins ?? 0,
    losses: t?.losses ?? 0,
    pushes: t?.pushes ?? 0,
    // A WIN at odds = 0 makes the JS unitsWon Infinity/NaN; reproduced, not fixed (Q6).
    unitsWon: zeroOddsWinUnitsWon(t?.zeroOddsWinFlags ?? 0) ?? t?.unitsWon ?? 0,
    unitsLost: t?.unitsLost ?? 0,
    unitsRisked: t?.unitsRisked ?? 0,
  });
  return { wins: r.wins, losses: r.losses, pushes: r.pushes, roi: r.roi, netUnits: r.netUnits };
}

// Pure: bundle rows -> the page's view. `now` must be the instant the bundle's SQL windows used.
export function capperDetailFromBundle(bundle: Record<string, unknown[]>, params: CapperDetailParams, now: Date): CapperDetailView {
  const series = narrowSeriesFromRows(bundle.series ?? []);
  const tiles = categoryTileRowsFromBundle(bundle.tiles ?? []);
  const meta = capperPickMetaFromBundle(bundle.meta ?? []);

  // Sport tabs: every sport in first-appearance order (its first pick of ANY status, canonical
  // order), keep those with >= 1 all-time tile in the sport's chip set, then a stable sort by
  // total tile count desc - so equal totals keep first-appearance order.
  const firstKeys = sportFirstKeysFromBundle(bundle.firstKeys ?? []).sort((a, b) => (a.firstKey < b.firstKey ? -1 : a.firstKey > b.firstKey ? 1 : 0));
  const tabs = firstKeys
    .map(({ sport }) => ({
      sportName: sport,
      breakdown: categoryBreakdownFromCounts(
        tiles.filter((t) => t.window === "ALL" && t.sport === sport),
        chipSetForLeague(sport)
      ),
    }))
    .filter((s) => s.breakdown.length > 0)
    .sort((a, b) => b.breakdown.reduce((sum, item) => sum + item.count, 0) - a.breakdown.reduce((sum, item) => sum + item.count, 0));

  const selectedCategorySport = tabs.find((s) => s.sportName === params.categorySport)?.sportName ?? tabs[0]?.sportName;

  // The record-by-bet-type section: the six markets every sport shares, summed across sports.
  const universal = (window: ScorecardWindow) =>
    categoryBreakdownFromCounts(
      tiles.filter((t) => t.window === window),
      DEFAULT_CHIP_SET
    );

  const sportTotal = ((bundle.sportTotals ?? []) as WindowTotals[]).find((t) => t.sport === selectedCategorySport);
  const sportSeries = series.filter((p) => p.sport.name === selectedCategorySport);
  const recent = capperRecentPicksFromRows(bundle.recent ?? [], selectedCategorySport);

  return {
    stats: recordFromTotals(((bundle.totals ?? []) as WindowTotals[])[0]),
    currentStreak: currentStreak(series),
    momentum: computeMomentum(series),
    allTimeUniversalBreakdown: universal("ALL"),
    universalBreakdown: universal(params.window),
    chartData: computeUnitsChartData(filterPicksByGameWindow(series, params.window, now)),
    sportTabs: tabs.map((s) => s.sportName),
    selectedCategorySport,
    activeCategoryBreakdown:
      selectedCategorySport === undefined
        ? []
        : categoryBreakdownFromCounts(
            tiles.filter((t) => t.window === params.categoryWindow && t.sport === selectedCategorySport),
            chipSetForLeague(selectedCategorySport)
          ),
    // A row exists only when the sport has >= 1 pick (any status) in the window - the JS path's
    // `activeSportPicksInWindow.length > 0`.
    activeSportStats: sportTotal ? recordFromTotals(sportTotal) : null,
    activeSportChartData: computeUnitsChartData(filterPicksByGameWindow(sportSeries, params.categoryWindow, now)),
    recentPicks: recent.picks.map((p) => ({
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
    recentPicksSport: recent.scopedSport,
    trackedSinceMs: meta.trackedSinceMs,
    lastPickMs: meta.lastPickMs,
    bestOddsRange: computeBestOddsRange(series),
    consistency: computeConsistency(series),
    associatedPickCount: meta.count,
  };
}

// `now` is a parameter only so the parity harness can pin it; the page passes nothing.
export async function getCapperDetailData(
  userId: string,
  capperId: string,
  params: CapperDetailParams,
  now: Date = new Date()
): Promise<CapperDetailView> {
  const bundle = await queryPageBundle(buildCapperDetailBundleQuery(userId, capperId, params, now));
  return capperDetailFromBundle(bundle, params, now);
}
