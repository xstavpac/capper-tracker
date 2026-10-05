// The /dashboard summary, computed by ONE statement in the database instead of by
// fetching every pick the user ever made (docs/design/dashboard-capper-detail-egress.md,
// PR 2). The statement is composed from the shared blocks in page-aggregate-fragments.ts:
// pooled ALL-window totals, category tiles (DEFAULT_CHIP_SET pushed down), the settled
// units series already downsampled in SQL (Q10), the newest 10 picks, the pending
// counts, and - for the stat cards' deltas and sparklines - the last STAT_WEEKS weeks'
// activity and the roster counts. ROI / winPct / round2 / labels stay in stats.ts and the mappers, applied to raw
// totals, so each rule has one implementation. dashboard-summary-legacy.ts is the frozen
// JS path this replaces; dashboard-summary-acceptance-test.ts and
// scripts/t2-harness/dashboard-parity.ts hold the two equal on everything but `trends`,
// which the legacy path never had.
import { cacheKeys } from "@/lib/cache-keys";
import { cachedByTag } from "@/server/data/cached";
import {
  DASHBOARD_RECENT_ORDER_BY,
  UNITS_SERIES_ORDER_BY,
  buildPageBundleQuery,
  categoryTileRowsFromBundle,
  categoryTilesSelect,
  chartPointsFromSeriesRows,
  dashboardRecentPicksFromRows,
  dashboardRecentPicksSelect,
  dashboardTrendsFromBundle,
  pendingCountsFromBundle,
  pendingCountsSelect,
  queryPageBundle,
  rosterTrendSelect,
  unitsSeriesRowsFromBundle,
  unitsSeriesSelect,
  weeklyTrendSelect,
} from "@/server/data/page-aggregate-fragments";
import { STAT_WEEKS } from "@/server/data/cappers-page-aggregates";
import { windowTotalsSelect, zeroOddsWinUnitsWon, type WindowTotals } from "@/server/data/capper-list-aggregates";
import { DASHBOARD_REPORTS_CACHE_TTL_SECONDS, DEFAULT_CHIP_SET, categoryBreakdownFromCounts, recordStatsFromTotals } from "@/server/data/stats";

export const STALE_PENDING_HOURS = 24;
const DAY_MS = 86400000;

/** Dashboard summary - fully derived; callers never re-process a pick array. */
// Its own key ("v2": the summary gained `trends`, and an entry cached by the previous deploy
// must not be read as the new shape), still invalidated by the shared dashboard tag.
export async function getDashboardSummary(userId: string) {
  return cachedByTag(`dashboard-summary:v2:${userId}`, DASHBOARD_REPORTS_CACHE_TTL_SECONDS, () => computeDashboardSummary(userId), [cacheKeys.dashboard(userId)]);
}

// The one statement. Exported so the measurement script runs exactly what production runs.
export function buildDashboardBundleQuery(userId: string, now: Date) {
  const staleCutoff = new Date(now.getTime() - STALE_PENDING_HOURS * 3600000);
  // weekEdges[i]..weekEdges[i + 1] is trend week i (oldest first); the last edge is now. The
  // same rolling weeks as the /cappers stat cards.
  const weekEdges = Array.from({ length: STAT_WEEKS + 1 }, (_, i) => new Date(now.getTime() - (STAT_WEEKS - i) * 7 * DAY_MS));
  return buildPageBundleQuery({
    windows: { windows: ["ALL"], now },
    parts: [
      { name: "totals", select: windowTotalsSelect({ userId, pooled: true }) },
      { name: "tiles", select: categoryTilesSelect({ userId, chipSet: DEFAULT_CHIP_SET }) },
      { name: "series", select: unitsSeriesSelect({ userId }), orderBy: UNITS_SERIES_ORDER_BY },
      { name: "recent", select: dashboardRecentPicksSelect({ userId }), orderBy: DASHBOARD_RECENT_ORDER_BY },
      { name: "pending", select: pendingCountsSelect({ userId, staleCutoff }) },
      { name: "weekly", select: weeklyTrendSelect({ userId, start: weekEdges[0], now }) },
      { name: "roster", select: rosterTrendSelect({ userId, weekEnds: weekEdges.slice(1), monthAgo: new Date(now.getTime() - 30 * DAY_MS) }) },
    ],
  });
}

// `now` is a parameter only so the parity harness can pin it; production passes nothing.
export async function computeDashboardSummary(userId: string, now: Date = new Date()) {
  const bundle = await queryPageBundle(buildDashboardBundleQuery(userId, now));

  // ALL has no window predicate, so the one pooled row's nPicks is every pick of any status
  // (== picks.length on the old path). No picks at all -> no row -> zeros.
  const t = ((bundle.totals ?? []) as WindowTotals[])[0];
  const record = recordStatsFromTotals({
    wins: t?.wins ?? 0,
    losses: t?.losses ?? 0,
    pushes: t?.pushes ?? 0,
    // A WIN at odds = 0 makes the JS unitsWon Infinity/NaN; reproduced, not fixed (Q6).
    unitsWon: zeroOddsWinUnitsWon(t?.zeroOddsWinFlags ?? 0) ?? t?.unitsWon ?? 0,
    unitsLost: t?.unitsLost ?? 0,
    unitsRisked: t?.unitsRisked ?? 0,
  });
  const pending = pendingCountsFromBundle(bundle.pending ?? []);

  return {
    // Q4: only the fields the page reads. currentStreak, longestWinStreak, longestLossStreak,
    // winPct, unitsWon and unitsLost were computed and never rendered (evidence in the PR).
    overall: { wins: record.wins, losses: record.losses, pushes: record.pushes, roi: record.roi, netUnits: record.netUnits },
    totalPicks: t?.nPicks ?? 0,
    // DEFAULT_CHIP_SET, not chipSetForLeague: this mixes every sport, and F5 ML / NRFI only
    // mean anything within MLB. Stored Pick.category only.
    categoryBreakdown: categoryBreakdownFromCounts(categoryTileRowsFromBundle(bundle.tiles ?? []), DEFAULT_CHIP_SET),
    chartData: chartPointsFromSeriesRows(unitsSeriesRowsFromBundle(bundle.series ?? [])),
    pendingCount: pending.pending,
    stalePendingCount: pending.stale,
    recentPicks: dashboardRecentPicksFromRows(bundle.recent ?? []),
    // The stat cards' deltas and sparklines; not part of the legacy summary.
    // unitsRisked is the all-time total (what `overall.roi` divides by), so ROI can be walked
    // back week by week.
    trends: { ...dashboardTrendsFromBundle(bundle.weekly ?? [], bundle.roster ?? [], STAT_WEEKS), unitsRisked: t?.unitsRisked ?? 0 },
  };
}
