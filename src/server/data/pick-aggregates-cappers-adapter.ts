// T3-based reimplementation of the Cappers-page data functions that consume
// per-capper pick history (getCapperLeaderboardTable, getFavoriteCappersSummary,
// getSportCategoryPanelData), built on top of the shared pick-aggregate module
// (pick-aggregates.ts: getCapperPickDataset + sliceIntoWindows) instead of each
// function running its own prisma.pick.findMany.
//
// Deliberately NOT imported by src/app/(app)/cappers/page.tsx or re-exported
// from src/server/data/cappers.ts yet - /cappers still runs on the original
// implementations. This module exists to be registered as the "t3" entry in
// scripts/t2-harness/capture-output.ts's IMPLEMENTATIONS map and diffed
// against "old" via the harness before any live call site switches over.
// getPlanStatus and getMostActiveThisWeek are untouched by the T3 design
// (they don't fit the windowed per-capper-pick-history shape) and are
// re-exported here unchanged so this module still satisfies the harness's
// full CappersImpl shape.
import { prisma } from "@/lib/prisma";
import {
  computeStats,
  computeSpecialistTag,
  computeCategoryBreakdown,
  pickCategory,
  chipSetForLeague,
  weightedRoiScore,
  ALL_TIME_WINDOW,
  type PickCategoryKey,
  type ScorecardWindow,
} from "@/server/data/stats";
import { getCapperPickDataset, sliceIntoWindows } from "@/server/data/pick-aggregates";
import {
  getCappersForUser,
  getPlanStatus,
  getMostActiveThisWeek,
  type CapperLeagueFilter,
  type LeaderboardEntry,
  type FavoriteCappersSummary,
  type SportCategoryPanelData,
  type CategoryLeaderboardEntry,
} from "@/server/data/cappers";

export { getPlanStatus, getMostActiveThisWeek };

// Mirrors cappers.ts's own private CATEGORY_LEADERBOARD_MIN_PICKS /
// CATEGORY_LEADERBOARD_LIMIT constants - kept in sync by hand since they
// aren't exported from there.
const CATEGORY_LEADERBOARD_MIN_PICKS = 3;
const CATEGORY_LEADERBOARD_LIMIT = 5;

export async function getCapperLeaderboardTable(
  userId: string,
  window: ScorecardWindow,
  filter?: CapperLeagueFilter
): Promise<LeaderboardEntry[]> {
  // Roster fetching stays outside T3, exactly as designed - getCappersForUser
  // is the existing, unmodified function (it also applies the `category`
  // half of `filter`, which getCapperPickDataset deliberately doesn't know
  // about).
  const cappers = await getCappersForUser(userId, filter);
  if (cappers.length === 0) return [];

  const dataset = await getCapperPickDataset(userId, {
    sportName: filter?.sportName,
    capperIds: cappers.map((c) => c.id),
  });

  const scopedAll = filter?.category
    ? dataset.all.filter((p) => pickCategory({ ...p, sportName: p.sport.name }) === filter.category)
    : dataset.all;

  const windowed = sliceIntoWindows(scopedAll, [window])[window];

  const byCapper = new Map<string, typeof windowed>();
  for (const pick of windowed) {
    const list = byCapper.get(pick.capperId);
    if (list) list.push(pick);
    else byCapper.set(pick.capperId, [pick]);
  }

  // Every window but ALL only lists cappers who actually had a decided pick
  // in that period - same rule as the original implementation.
  const excludesZeroPick = window !== ALL_TIME_WINDOW;

  // Iterates `cappers` (the roster), never dataset.byCapperId.keys() - a
  // zero-pick capper has no key in that map and would silently vanish from
  // the ALL window (which must show the full roster) if iteration were
  // switched to keys-based. See pick-aggregates-cappers-adapter.test.ts.
  return cappers
    .filter((capper) => !excludesZeroPick || byCapper.has(capper.id))
    .map((capper) => {
      const stats = computeStats(byCapper.get(capper.id) ?? []);
      return {
        capperId: capper.id,
        name: capper.name,
        colorTag: capper.colorTag,
        stats,
        weightedScore: weightedRoiScore(stats),
        // Specialist tag reads the capper's full, category-UNFILTERED
        // all-time history (dataset.byCapperId, not scopedAll grouped) -
        // same as the original: a `filter.category` chip narrows the
        // leaderboard, not what "specialist in X" means.
        specialist: computeSpecialistTag(dataset.byCapperId.get(capper.id) ?? []),
        isFavorite: capper.isFavorite,
      };
    });
}

export async function getFavoriteCappersSummary(userId: string, window: ScorecardWindow): Promise<FavoriteCappersSummary | null> {
  const favoriteCappers = await prisma.capper.findMany({
    where: { userId, isFavorite: true },
    select: { id: true },
  });
  if (favoriteCappers.length === 0) return null;
  const favoriteIds = new Set(favoriteCappers.map((c) => c.id));

  const [allEntries, favoriteDataset] = await Promise.all([
    getCapperLeaderboardTable(userId, window),
    getCapperPickDataset(userId, { capperIds: Array.from(favoriteIds) }),
  ]);

  return {
    collectiveStats: computeStats(sliceIntoWindows(favoriteDataset.all, [window])[window]),
    entries: allEntries.filter((e) => favoriteIds.has(e.capperId)),
  };
}

export async function getSportCategoryPanelData(userId: string, sportName: string): Promise<SportCategoryPanelData> {
  // T3's dataset carries only the capperId scalar (no capper relation), so
  // the per-category leaderboard below must explicitly join capperId against
  // this separately-fetched roster to recover capper.name - never left
  // implicit. See pick-aggregates-cappers-adapter.test.ts for a test that
  // fails if this join is dropped.
  const [dataset, roster] = await Promise.all([
    getCapperPickDataset(userId, { sportName }),
    getCappersForUser(userId),
  ]);
  const nameByCapperId = new Map(roster.map((c) => [c.id, c.name]));

  const breakdown = computeCategoryBreakdown(dataset.all, chipSetForLeague(sportName));

  const leaderboards: Partial<Record<PickCategoryKey, CategoryLeaderboardEntry[]>> = {};
  for (const item of breakdown) {
    const scoped = dataset.all.filter((p) => pickCategory({ ...p, sportName }) === item.key);

    const byCapper = new Map<string, typeof scoped>();
    for (const pick of scoped) {
      const list = byCapper.get(pick.capperId);
      if (list) list.push(pick);
      else byCapper.set(pick.capperId, [pick]);
    }

    leaderboards[item.key] = Array.from(byCapper.entries())
      .map(([capperId, picks]) => {
        const stats = computeStats(picks);
        const name = nameByCapperId.get(capperId) ?? "Unknown capper";
        return { capperId, name, wins: stats.wins, losses: stats.losses, pushes: stats.pushes, winPct: stats.winPct };
      })
      .filter((e) => e.wins + e.losses + e.pushes >= CATEGORY_LEADERBOARD_MIN_PICKS)
      .sort((a, b) => b.winPct - a.winPct)
      .slice(0, CATEGORY_LEADERBOARD_LIMIT);
  }

  return { breakdown, leaderboards };
}
