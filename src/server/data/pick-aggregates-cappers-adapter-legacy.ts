// The Cappers-page leaderboard / favorites / most-active functions that lived in
// pick-aggregates-cappers-adapter.ts, moved here unchanged apart from imports.
// No page calls any of them: /cappers computes everything in one SQL bundle
// (cappers-page-aggregates.ts). They are kept because the acceptance tests
// (capper-list-aggregates-, cappers-page-aggregates-, pick-aggregates-cappers-
// adapter-acceptance-test.ts) and the T2 harness's `t3` registry entry use them as
// parity references - and their filter.category fallback
// (legacyCapperLeaderboardTable / legacyMostActiveThisWeek) reads full pick
// history (cappers-legacy.ts, pick-aggregates-legacy.ts).
//
// NO production code may import this file - legacy-reference-import-guard-acceptance-test.ts
// fails if anything outside tests/scripts does. The functions production still
// uses are re-exported below from the live adapter, so `import * as adapter`
// from here still sees the whole old module.
import { prisma } from "@/lib/prisma";
import {
  computeStats,
  computeSpecialistTag,
  pickCategory,
  weightedRoiScore,
  ALL_TIME_WINDOW,
  SCORECARD_WINDOWS,
  RANKING_MIN_SAMPLE,
  SPECIALIST_CONCENTRATION_THRESHOLD,
  type ScorecardWindow,
  type SpecialistTag,
} from "@/server/data/stats";
import { getCapperPickDataset, sliceIntoWindows } from "@/server/data/pick-aggregates-legacy";
import { queryWindowTotals, queryCurrentStreaks, querySpecialistCandidates } from "@/server/data/capper-list-aggregates";
import type { CapperLeagueFilter, LeaderboardEntry, FavoriteCappersSummary, ActivityEntry } from "@/server/data/cappers";
import { getCappersForUser, getMostActiveThisWeek as legacyMostActiveThisWeek } from "@/server/data/cappers-legacy";
import { statsFromRows, specialistTagsFromCandidateRows } from "@/server/data/pick-aggregates-cappers-adapter";

export { statsFromRows, specialistTagsFromCandidateRows, getSportCategoryPanelData } from "@/server/data/pick-aggregates-cappers-adapter";
export { getPlanStatus } from "@/server/data/cappers";

const ACTIVE_WEEK_DAYS = 7;

type EntriesByWindow = Record<ScorecardWindow, LeaderboardEntry[]>;
type SummariesByWindow = Record<ScorecardWindow, FavoriteCappersSummary>;

const windowKey = (capperId: string, window: ScorecardWindow) => capperId + "|" + window;

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

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
  return specialistTagsFromCandidateRows(rows);
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
