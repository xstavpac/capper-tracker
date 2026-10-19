// Frozen copies of the raw-pick Cappers-page functions that used to live in
// cappers.ts: getCappersForUser's league/category filter branch,
// getCapperLeaderboardTable, getFavoriteCappersSummary and getMostActiveThisWeek.
// Each reads a capper list's full pick history with no limit (the "capperId IN
// (...)" / sport-name LEFT JOIN shapes in pg_stat_statements). No page has called
// them since /cappers moved to SQL (#116-#145); they are kept, unchanged apart
// from imports, because capper-list-aggregates-acceptance-test.ts and the T2
// harness's `old` registry entry compare the SQL versions against them.
//
// NO production code may import this file - legacy-reference-import-guard-acceptance-test.ts
// fails if anything outside tests/scripts does.
import { prisma } from "@/lib/prisma";
import {
  computeStats,
  computeSpecialistTag,
  pickCategory,
  weightedRoiScore,
  filterPicksByGameWindow,
  ALL_TIME_WINDOW,
  type ScorecardWindow,
} from "@/server/data/stats";
import type { ActivityEntry, CapperLeagueFilter, FavoriteCappersSummary, LeaderboardEntry } from "@/server/data/cappers";

// Re-exported so this module is a complete stand-in for the old cappers.ts in the
// T2 harness registry.
export { getPlanStatus } from "@/server/data/cappers";

export async function getCappersForUser(userId: string, filter?: CapperLeagueFilter) {
  if (!filter?.sportName && !filter?.category) {
    return prisma.capper.findMany({
      where: { userId },
      orderBy: [{ isFavorite: "desc" }, { name: "asc" }],
    });
  }

  // Membership-only filter for now (Phase 2) - narrows which cappers show up
  // for the active league/bet-type chips. The grid itself doesn't display
  // per-filter stats yet; that's the Phase 3 ranked-list rebuild.
  const picks = await prisma.pick.findMany({
    where: { userId, ...(filter.sportName ? { sport: { name: filter.sportName } } : {}) },
    select: {
      capperId: true,
      betType: true,
      period: true,
      betDetail: true,
      odds: true,
      line: true,
      sport: { select: { name: true } },
    },
  });
  const matchingCapperIds = new Set(
    picks
      .filter((p) => !filter.category || pickCategory({ ...p, sportName: p.sport.name }) === filter.category)
      .map((p) => p.capperId)
  );

  return prisma.capper.findMany({
    where: { userId, id: { in: Array.from(matchingCapperIds) } },
    orderBy: [{ isFavorite: "desc" }, { name: "asc" }],
  });
}

// Backs the redesigned Cappers page's sortable leaderboard table - returns
// every capper with their raw stats (no rank-vs-unranked split) so the
// table can sort by any column the user clicks; "small sample" and
// rank-worthiness become display concerns (a tag, not an exclusion) rather
// than being decided here. The one exclusion this DOES apply: a capper with
// zero decided picks in the selected window is left out entirely (not
// shown at 0%) for every window except ALL - see ALL_TIME_WINDOW. `window`
// reuses ScorecardWindow/filterPicksByGameWindow (the same This-week/
// All-time toggle already used on the capper detail page) rather than
// inventing a separate windowing concept.
export async function getCapperLeaderboardTable(
  userId: string,
  window: ScorecardWindow,
  filter?: CapperLeagueFilter
): Promise<LeaderboardEntry[]> {
  const cappers = await getCappersForUser(userId, filter);
  if (cappers.length === 0) return [];

  const allPicks = await prisma.pick.findMany({
    where: {
      userId,
      capperId: { in: cappers.map((c) => c.id) },
      ...(filter?.sportName ? { sport: { name: filter.sportName } } : {}),
    },
    include: { sport: true },
  });
  const scoped = filter?.category
    ? allPicks.filter((p) => pickCategory({ ...p, sportName: p.sport.name }) === filter.category)
    : allPicks;
  const windowed = filterPicksByGameWindow(scoped, window);

  const byCapper = new Map<string, typeof windowed>();
  for (const pick of windowed) {
    const list = byCapper.get(pick.capperId);
    if (list) list.push(pick);
    else byCapper.set(pick.capperId, [pick]);
  }
  // Specialist tag always looks at this capper's full all-time history, not
  // just the active window - a real specialization is a lasting pattern, not
  // something that should flicker in and out depending on which 7 days
  // happen to be graded right now.
  const allByCapper = new Map<string, typeof allPicks>();
  for (const pick of allPicks) {
    const list = allByCapper.get(pick.capperId);
    if (list) list.push(pick);
    else allByCapper.set(pick.capperId, [pick]);
  }

  // Every window but ALL only lists cappers who actually had a decided pick
  // in that period - a 0-pick capper isn't part of that period's action and
  // would otherwise sit at 0% in the middle of the ranking. ALL keeps every
  // capper, 0-pick or not, since it's meant to represent the full roster.
  const excludesZeroPick = window !== ALL_TIME_WINDOW;

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
        specialist: computeSpecialistTag(allByCapper.get(capper.id) ?? []),
        isFavorite: capper.isFavorite,
      };
    });
}

// Powers the Favorites section at the top of the Cappers page - the
// collective card pools every favorited capper's picks into one array and
// runs it through the exact same computeStats/filterPicksByGameWindow
// used everywhere else (capper detail page, leaderboard table), rather than
// a separate aggregation. The individual-capper list below it reuses
// getCapperLeaderboardTable wholesale (same per-capper stats+streak
// computation as the main leaderboard) filtered down to just the
// favorited ids, instead of recomputing anything. Returns null when the
// user has no favorites, so the page can skip rendering the section
// entirely rather than showing an empty state for a feature they haven't
// used yet.
export async function getFavoriteCappersSummary(
  userId: string,
  window: ScorecardWindow
): Promise<FavoriteCappersSummary | null> {
  const favoriteCappers = await prisma.capper.findMany({
    where: { userId, isFavorite: true },
    select: { id: true },
  });
  if (favoriteCappers.length === 0) return null;
  const favoriteIds = new Set(favoriteCappers.map((c) => c.id));

  const [allEntries, favoritePicks] = await Promise.all([
    getCapperLeaderboardTable(userId, window),
    prisma.pick.findMany({ where: { userId, capperId: { in: Array.from(favoriteIds) } } }),
  ]);

  // collectiveStats.currentStreak technically exists (computeStats always
  // returns one), but is NOT meaningful on this particular object and must
  // never be surfaced or reused - it's derived from multiple cappers' picks
  // interleaved by gameTime, not one continuous chronological run for a
  // single capper the way every other use of currentStreak in this app is.
  // This is exactly why FavoriteCappersSummary (the component rendering
  // this) never reads this field - keep it that way.
  return {
    collectiveStats: computeStats(filterPicksByGameWindow(favoritePicks, window)),
    entries: allEntries.filter((e) => favoriteIds.has(e.capperId)),
  };
}

const ACTIVE_WEEK_DAYS = 7;

// Ranks by pick VOLUME (picks given, via datePosted) rather than win rate -
// a distinct question from every other leaderboard here ("who's been
// talking" vs "who's been right"). Deliberately counts every pick posted
// this week regardless of status, including still-PENDING ones - activity
// is about how much a capper has been giving picks, not how many have
// settled yet.
export async function getMostActiveThisWeek(
  userId: string,
  filter?: CapperLeagueFilter,
  limit = 5
): Promise<ActivityEntry[]> {
  const cappers = await getCappersForUser(userId, filter);
  if (cappers.length === 0) return [];

  const weekStart = new Date(Date.now() - ACTIVE_WEEK_DAYS * 86400000);
  const picks = await prisma.pick.findMany({
    where: {
      userId,
      capperId: { in: cappers.map((c) => c.id) },
      datePosted: { gte: weekStart },
      ...(filter?.sportName ? { sport: { name: filter.sportName } } : {}),
    },
    include: { sport: true },
  });
  const scoped = filter?.category
    ? picks.filter((p) => pickCategory({ ...p, sportName: p.sport.name }) === filter.category)
    : picks;

  const counts = new Map<string, number>();
  for (const pick of scoped) {
    counts.set(pick.capperId, (counts.get(pick.capperId) ?? 0) + 1);
  }

  return cappers
    .map((capper) => ({ capperId: capper.id, name: capper.name, colorTag: capper.colorTag, pickCount: counts.get(capper.id) ?? 0 }))
    .filter((e) => e.pickCount > 0)
    .sort((a, b) => b.pickCount - a.pickCount)
    .slice(0, limit);
}
