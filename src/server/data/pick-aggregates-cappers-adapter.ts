// The Cappers-page data functions that consume per-capper pick history
// (getCapperLeaderboardTable, getFavoriteCappersSummary, getSportCategoryPanelData,
// getMostActiveThisWeek), imported by src/app/(app)/cappers/page.tsx.
//
// Data flow: the database summarizes, the app receives only the small result.
// capper-list-aggregates.ts runs the GROUP BY / window-function queries (one row
// per capper x window, per capper x category, ...) and this file turns those raw
// totals into the page's shapes with the SAME rounding/derivation functions the
// JS path uses (recordStatsFromTotals, weightedRoiScore,
// specialistFromCategoryTotals in stats.ts). No path here fetches raw Pick rows,
// except the explicit fallbacks below.
//
// Entry points come in two forms:
//   - Batched (getCapperLeaderboardTablesByWindow, getFavoriteCappersSummariesByWindow):
//     all six windows from one query - what page.tsx calls.
//   - Per-window (getCapperLeaderboardTable, getFavoriteCappersSummary): thin
//     wrappers over the batched code for the requested window, kept so existing
//     callers (the T2 harness registry, tests) keep their signatures.
//
// The specialist tags and the category panel read the STORED Pick.category
// (stamped at insert, backfilled once for older picks - see
// scripts/backfill-pick-category.ts); there is no raw-pick fallback for them. If
// PICK_CATEGORY_VERSION is ever bumped, run the backfill so stored categories
// are restamped - until then they reflect the old version's classification.
//
// The one remaining raw-pick JS path is legacyCapperLeaderboardTable /
// legacyMostActiveThisWeek, used only for filter.category (no route sets it
// today) - not worth a SQL variant.
import { prisma } from "@/lib/prisma";
import {
  computeStats,
  computeSpecialistTag,
  pickCategory,
  chipSetForLeague,
  weightedRoiScore,
  recordStatsFromTotals,
  specialistFromCategoryTotals,
  winPctOf,
  ALL_TIME_WINDOW,
  SCORECARD_WINDOWS,
  PICK_CATEGORY_LABELS,
  RANKING_MIN_SAMPLE,
  SPECIALIST_CONCENTRATION_THRESHOLD,
  type PickCategoryKey,
  type CategoryBreakdownItem,
  type CategoryDecidedTotals,
  type RecordStats,
  type ScorecardWindow,
  type SpecialistTag,
  type SportCategoryPanelData,
  type CategoryLeaderboardEntry,
} from "@/server/data/stats";
import { getCapperPickDataset, sliceIntoWindows } from "@/server/data/pick-aggregates";
import {
  queryWindowTotals,
  queryCurrentStreaks,
  querySpecialistCandidates,
  queryCategoryPanel,
  zeroOddsWinUnitsWon,
  type WindowTotals,
  type StreakRow,
} from "@/server/data/capper-list-aggregates";
import {
  getCappersForUser,
  getMostActiveThisWeek as legacyMostActiveThisWeek,
  type CapperLeagueFilter,
  type LeaderboardEntry,
  type FavoriteCappersSummary,
  type ActivityEntry,
} from "@/server/data/cappers";
// SportCategoryPanelData / CategoryLeaderboardEntry come from stats.ts, not
// from sport-category-panel-legacy.ts - that file is a parity-test/T2-harness-
// only reference (its getSportCategoryPanelData is unused by any page since
// #128) and production code must not import it. This adapter's own
// getSportCategoryPanelData below reuses the same shared type on purpose
// ("same name, same return shape" is the point of the migration).

export { getPlanStatus } from "@/server/data/cappers";

// Mirrors cappers.ts's own private CATEGORY_LEADERBOARD_MIN_PICKS /
// CATEGORY_LEADERBOARD_LIMIT constants - kept in sync by hand since they
// aren't exported from there.
const CATEGORY_LEADERBOARD_MIN_PICKS = 3;
const CATEGORY_LEADERBOARD_LIMIT = 5;
const ACTIVE_WEEK_DAYS = 7;

type EntriesByWindow = Record<ScorecardWindow, LeaderboardEntry[]>;
type SummariesByWindow = Record<ScorecardWindow, FavoriteCappersSummary>;

const NO_STREAK = { type: "NONE", count: 0 } as const;
const windowKey = (capperId: string, window: ScorecardWindow) => capperId + "|" + window;

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

function statsFromRows(totals: WindowTotals | undefined, streak: StreakRow | undefined): RecordStats {
  // A WIN at odds = 0 makes the JS unitsWon Infinity/NaN (see
  // zeroOddsWinUnitsWon) - reproduced, not fixed.
  const poisoned = zeroOddsWinUnitsWon(totals?.zeroOddsWinFlags ?? 0);
  return {
    ...recordStatsFromTotals({
      wins: totals?.wins ?? 0,
      losses: totals?.losses ?? 0,
      pushes: totals?.pushes ?? 0,
      unitsWon: poisoned ?? totals?.unitsWon ?? 0,
      unitsLost: totals?.unitsLost ?? 0,
      unitsRisked: totals?.unitsRisked ?? 0,
    }),
    currentStreak: streak ? { type: streak.type, count: streak.count } : { ...NO_STREAK },
  };
}

// One query for every requested window's per-capper totals, one for the
// streaks, and one for the specialist tags (all in parallel).
async function buildLeaderboards(
  userId: string,
  sportName: string | undefined,
  windows: ScorecardWindow[]
): Promise<Partial<EntriesByWindow>> {
  const cappers = await getCappersForUser(userId);
  if (cappers.length === 0) return Object.fromEntries(windows.map((w) => [w, []]));

  // ALL is always fetched: with a sport scope it is what decides who is on the
  // roster at all (a capper with no pick in that sport is not listed, in any
  // window - the JS path got there by fetching that sport's whole history).
  const queried = sportName && !windows.includes(ALL_TIME_WINDOW) ? [...windows, ALL_TIME_WINDOW] : windows;
  const now = new Date();
  const [totalRows, streakRows, specialists] = await Promise.all([
    queryWindowTotals({ userId, sportName, windows: queried, now }),
    queryCurrentStreaks({ userId, sportName, windows: queried, now }),
    loadSpecialists(userId, sportName),
  ]);
  const totals = new Map(totalRows.map((r) => [windowKey(r.capperId!, r.window), r]));
  const streaks = new Map(streakRows.map((r) => [windowKey(r.capperId, r.window), r]));

  const onRoster = (capperId: string) => !sportName || (totals.get(windowKey(capperId, ALL_TIME_WINDOW))?.nPicks ?? 0) > 0;

  const out: Partial<EntriesByWindow> = {};
  for (const window of windows) {
    // Every window but ALL only lists cappers who actually had a pick in that
    // period - same rule as the original implementation (which counts a
    // CANCELLED pick with gradedAt set as "having a pick").
    const excludesZeroPick = window !== ALL_TIME_WINDOW;
    out[window] = cappers
      .filter((c) => onRoster(c.id))
      .filter((c) => !excludesZeroPick || (totals.get(windowKey(c.id, window))?.nPicks ?? 0) > 0)
      .map((c) => {
        const stats = statsFromRows(totals.get(windowKey(c.id, window)), streaks.get(windowKey(c.id, window)));
        return {
          capperId: c.id,
          name: c.name,
          colorTag: c.colorTag,
          stats,
          weightedScore: weightedRoiScore(stats),
          specialist: specialists.get(c.id) ?? null,
          isFavorite: c.isFavorite,
        };
      });
  }
  return out;
}

export async function getCapperLeaderboardTablesByWindow(userId: string, filter?: CapperLeagueFilter): Promise<EntriesByWindow> {
  if (filter?.category) {
    const entries = await Promise.all(SCORECARD_WINDOWS.map((w) => legacyCapperLeaderboardTable(userId, w, filter)));
    return Object.fromEntries(SCORECARD_WINDOWS.map((w, i) => [w, entries[i]])) as EntriesByWindow;
  }
  return (await buildLeaderboards(userId, filter?.sportName, SCORECARD_WINDOWS)) as EntriesByWindow;
}

export async function getCapperLeaderboardTable(
  userId: string,
  window: ScorecardWindow,
  filter?: CapperLeagueFilter
): Promise<LeaderboardEntry[]> {
  if (filter?.category) return legacyCapperLeaderboardTable(userId, window, filter);
  return (await buildLeaderboards(userId, filter?.sportName, [window]))[window] ?? [];
}

// ---------------------------------------------------------------------------
// Specialist tags
// ---------------------------------------------------------------------------

// Reads the capper's full, category-UNFILTERED all-time history (within the
// sport scope, when one is active - same as the original): a `filter.category`
// chip narrows the leaderboard, not what "specialist in X" means. The database
// sends only the categories that could qualify (see querySpecialistCandidates);
// the decision is stats.ts's specialistFromCategoryTotals.
async function loadSpecialists(userId: string, sportName: string | undefined): Promise<Map<string, SpecialistTag | null>> {
  const rows = await querySpecialistCandidates({
    userId,
    sportName,
    minShare: SPECIALIST_CONCENTRATION_THRESHOLD,
    minSample: RANKING_MIN_SAMPLE,
  });

  const byCapper = new Map<string, { decidedTotal: number; overall: { wins: number; losses: number }; candidates: typeof rows }>();
  for (const r of rows) {
    const g = byCapper.get(r.capperId) ?? { decidedTotal: r.decidedTotal, overall: { wins: r.totalWins, losses: r.totalLosses }, candidates: [] };
    g.candidates.push(r);
    byCapper.set(r.capperId, g);
  }

  const out = new Map<string, SpecialistTag | null>();
  for (const [capperId, g] of byCapper) {
    // Tie-break order: the category whose first decided pick (createdAt, id)
    // came first is considered first, so it wins an exact 50/50 share tie.
    const ordered = g.candidates
      .slice()
      .sort((a, b) => (a.firstDecidedKey < b.firstDecidedKey ? -1 : a.firstDecidedKey > b.firstDecidedKey ? 1 : 0))
      .map((c) => [c.category as PickCategoryKey, { wins: c.wins, losses: c.losses, pushes: c.pushes }] as [PickCategoryKey, CategoryDecidedTotals]);
    out.set(capperId, specialistFromCategoryTotals(g.decidedTotal, g.overall, ordered));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Favorites
// ---------------------------------------------------------------------------

// `unscopedEntriesByWindow` is the ALL-leagues leaderboard (what the caller
// already has when no league pill is active) - passing it avoids recomputing
// it. Omitted, it's built here. The collective card always pools the
// favorites' picks across every sport, whatever league pill is active.
export async function getFavoriteCappersSummariesByWindow(
  userId: string,
  unscopedEntriesByWindow?: EntriesByWindow
): Promise<SummariesByWindow | null> {
  return buildFavoriteSummaries(userId, SCORECARD_WINDOWS, unscopedEntriesByWindow) as Promise<SummariesByWindow | null>;
}

export async function getFavoriteCappersSummary(userId: string, window: ScorecardWindow): Promise<FavoriteCappersSummary | null> {
  return (await buildFavoriteSummaries(userId, [window]))?.[window] ?? null;
}

async function buildFavoriteSummaries(
  userId: string,
  windows: ScorecardWindow[],
  unscopedEntries?: Partial<EntriesByWindow>
): Promise<Partial<SummariesByWindow> | null> {
  const favoriteCappers = await prisma.capper.findMany({
    where: { userId, isFavorite: true },
    select: { id: true },
  });
  if (favoriteCappers.length === 0) return null;
  const favoriteIds = new Set(favoriteCappers.map((c) => c.id));

  const [entriesByWindow, pooled] = await Promise.all([
    unscopedEntries ?? buildLeaderboards(userId, undefined, windows),
    queryWindowTotals({ userId, capperIds: Array.from(favoriteIds), pooled: true, windows }),
  ]);
  const pooledByWindow = new Map(pooled.map((r) => [r.window, r]));

  const out: Partial<SummariesByWindow> = {};
  for (const window of windows) {
    // collectiveStats.currentStreak is NOT meaningful on this pooled object (it
    // would be a streak across several cappers' interleaved results) and is
    // never read by the UI - a fixed placeholder, not computed.
    out[window] = {
      collectiveStats: statsFromRows(pooledByWindow.get(window), undefined),
      entries: (entriesByWindow[window] ?? []).filter((e) => favoriteIds.has(e.capperId)),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Category panel ("Best at...")
// ---------------------------------------------------------------------------

export async function getSportCategoryPanelData(userId: string, sportName: string): Promise<SportCategoryPanelData> {
  const [rows, roster] = await Promise.all([
    queryCategoryPanel({ userId, sportName, minPicks: CATEGORY_LEADERBOARD_MIN_PICKS, limit: CATEGORY_LEADERBOARD_LIMIT }),
    getCappersForUser(userId),
  ]);

  // The aggregates carry only the capperId, so the per-category leaderboard
  // must explicitly join it against this separately-fetched roster to recover
  // capper.name - never left implicit.
  const nameByCapperId = new Map(roster.map((c) => [c.id, c.name]));

  const rowsByCategory = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = rowsByCategory.get(r.category);
    if (list) list.push(r);
    else rowsByCategory.set(r.category, [r]);
  }

  const breakdown: CategoryBreakdownItem[] = [];
  for (const key of chipSetForLeague(sportName)) {
    const categoryRows = rowsByCategory.get(key);
    if (!categoryRows) continue;
    // The pooled totals ride on every row of the category.
    const { categoryWins: wins, categoryLosses: losses, categoryPushes: pushes } = categoryRows[0];
    const count = wins + losses + pushes;
    // A category with picks but none decided yet would render as a dead 0-0 tile.
    if (count === 0) continue;
    breakdown.push({ key, label: PICK_CATEGORY_LABELS[key], wins, losses, pushes, winPct: winPctOf(wins, losses), count });
  }

  const leaderboards: Partial<Record<PickCategoryKey, CategoryLeaderboardEntry[]>> = {};
  for (const item of breakdown) {
    leaderboards[item.key] = (rowsByCategory.get(item.key) ?? [])
      .map((r) => ({
        capperId: r.capperId,
        name: nameByCapperId.get(r.capperId) ?? "Unknown capper",
        wins: r.wins,
        losses: r.losses,
        pushes: r.pushes,
        winPct: winPctOf(r.wins, r.losses),
        firstKey: r.firstAnyKey,
      }))
      .filter((e) => e.wins + e.losses + e.pushes >= CATEGORY_LEADERBOARD_MIN_PICKS)
      // Equal win% ties: the capper whose first pick in this category (any
      // status) is earlier by createdAt, id ranks first.
      .sort((a, b) => b.winPct - a.winPct || (a.firstKey < b.firstKey ? -1 : a.firstKey > b.firstKey ? 1 : 0))
      .slice(0, CATEGORY_LEADERBOARD_LIMIT)
      .map(({ firstKey: _firstKey, ...entry }) => entry);
  }

  return { breakdown, leaderboards };
}

// ---------------------------------------------------------------------------
// Most active this week
// ---------------------------------------------------------------------------

// Counts in the database (groupBy) instead of fetching the week's rows. The
// roster is every capper: with a league pill the original narrowed it to
// cappers with a pick in that sport (a full-history fetch), but the counts
// below are already scoped to that sport and zero-count cappers are dropped, so
// the result is identical.
export async function getMostActiveThisWeek(userId: string, filter?: CapperLeagueFilter, limit = 5): Promise<ActivityEntry[]> {
  if (filter?.category) return legacyMostActiveThisWeek(userId, filter, limit);

  const cappers = await getCappersForUser(userId);
  if (cappers.length === 0) return [];

  const weekStart = new Date(Date.now() - ACTIVE_WEEK_DAYS * 86400000);
  const groups = await prisma.pick.groupBy({
    by: ["capperId"],
    where: {
      userId,
      datePosted: { gte: weekStart },
      ...(filter?.sportName ? { sport: { name: filter.sportName } } : {}),
    },
    _count: { _all: true },
  });
  const counts = new Map(groups.map((g) => [g.capperId, g._count._all]));

  return cappers
    .map((capper) => ({ capperId: capper.id, name: capper.name, colorTag: capper.colorTag, pickCount: counts.get(capper.id) ?? 0 }))
    .filter((e) => e.pickCount > 0)
    .sort((a, b) => b.pickCount - a.pickCount)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Legacy raw-pick JS path (fallback - see the header comment)
// ---------------------------------------------------------------------------

export async function legacyCapperLeaderboardTable(
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
  // switched to keys-based.
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
        // all-time history (dataset.byCapperId, not scopedAll grouped).
        specialist: computeSpecialistTag(dataset.byCapperId.get(capper.id) ?? []),
        isFavorite: capper.isFavorite,
      };
    });
}
