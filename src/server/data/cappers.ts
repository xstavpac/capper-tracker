import { prisma } from "@/lib/prisma";
import type { Source } from "@prisma/client";
import { normalizeName, duplicateNameDistance } from "@/lib/fuzzy-match";
import {
  computeStats,
  computeCategoryBreakdown,
  computeSpecialistTag,
  pickCategory,
  chipSetForLeague,
  weightedRoiScore,
  filterPicksByGradedWindow,
  RANKING_MIN_SAMPLE,
  type OverallStats,
  type PickCategoryKey,
  type CategoryBreakdownItem,
  type SpecialistTag,
  type ScorecardWindow,
} from "@/server/data/stats";

export type CapperLeagueFilter = { sportName?: string; category?: PickCategoryKey };

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
    select: { capperId: true, betType: true, period: true, betDetail: true, odds: true, line: true },
  });
  const matchingCapperIds = new Set(
    picks.filter((p) => !filter.category || pickCategory(p) === filter.category).map((p) => p.capperId)
  );

  return prisma.capper.findMany({
    where: { userId, id: { in: Array.from(matchingCapperIds) } },
    orderBy: [{ isFavorite: "desc" }, { name: "asc" }],
  });
}

export async function getCapperById(userId: string, capperId: string) {
  return prisma.capper.findFirst({
    where: { id: capperId, userId },
  });
}

export async function getPlanStatus(userId: string) {
  const subscription = await prisma.subscription.findUnique({ where: { userId } });
  const isPro = subscription?.plan === "PRO";
  const capperCount = await prisma.capper.count({ where: { userId } });

  return { isPro, capperCount };
}

export type LeaderboardEntry = {
  capperId: string;
  name: string;
  colorTag: string | null;
  stats: OverallStats;
  weightedScore: number;
  specialist: SpecialistTag | null;
};

// Backs the redesigned Cappers page's sortable leaderboard table - returns
// EVERY capper with their raw stats (no pre-filtering, no rank-vs-unranked
// split) so the table can sort by any column the user clicks; "small
// sample" and rank-worthiness become display concerns (a tag, not an
// exclusion) rather than being decided here. `window` reuses
// ScorecardWindow/filterPicksByGradedWindow (the same This-week/All-time
// toggle already used on the capper detail page) rather than inventing a
// separate windowing concept.
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
  });
  const scoped = filter?.category ? allPicks.filter((p) => pickCategory(p) === filter.category) : allPicks;
  const windowed = filterPicksByGradedWindow(scoped, window);

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

  return cappers.map((capper) => {
    const stats = computeStats(byCapper.get(capper.id) ?? []);
    return {
      capperId: capper.id,
      name: capper.name,
      colorTag: capper.colorTag,
      stats,
      weightedScore: weightedRoiScore(stats),
      specialist: computeSpecialistTag(allByCapper.get(capper.id) ?? []),
    };
  });
}

export type ActivityEntry = { capperId: string; name: string; colorTag: string | null; pickCount: number };

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
  });
  const scoped = filter?.category ? picks.filter((p) => pickCategory(p) === filter.category) : picks;

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

export type CategoryLeaderboardEntry = {
  capperId: string;
  name: string;
  wins: number;
  losses: number;
  pushes: number;
  winPct: number;
};

export type SportCategoryPanelData = {
  breakdown: CategoryBreakdownItem[];
  // Keyed by PickCategoryKey, but sparse (a category with zero cappers past
  // CATEGORY_LEADERBOARD_MIN_PICKS just won't have an entry) - Partial is the
  // honest type for that rather than claiming every key is always present.
  leaderboards: Partial<Record<PickCategoryKey, CategoryLeaderboardEntry[]>>;
};

const CATEGORY_LEADERBOARD_MIN_PICKS = 3;
const CATEGORY_LEADERBOARD_LIMIT = 5;

// Powers the Live page's category breakdown tiles AND their expandable "top
// cappers in this category" leaderboards, both off one picks query - a tile
// grid with N categories would otherwise mean either N separate queries or
// (worse) a fresh one per click. Scoped by sportName via chipSetForLeague
// rather than hardcoded to MLB, so the same tile+leaderboard pattern is
// ready for another sport's own category set later without any changes
// here - only chipSetForLeague itself would need a new case.
export async function getSportCategoryPanelData(userId: string, sportName: string): Promise<SportCategoryPanelData> {
  const picks = await prisma.pick.findMany({
    where: { userId, sport: { name: sportName } },
    include: { capper: true },
  });

  const breakdown = computeCategoryBreakdown(picks, chipSetForLeague(sportName));

  const leaderboards: Partial<Record<PickCategoryKey, CategoryLeaderboardEntry[]>> = {};
  for (const item of breakdown) {
    const scoped = picks.filter((p) => pickCategory(p) === item.key);

    const byCapper = new Map<string, { name: string; picks: typeof scoped }>();
    for (const pick of scoped) {
      const existing = byCapper.get(pick.capperId);
      if (existing) existing.picks.push(pick);
      else byCapper.set(pick.capperId, { name: pick.capper.name, picks: [pick] });
    }

    leaderboards[item.key] = Array.from(byCapper.entries())
      .map(([capperId, g]) => {
        const stats = computeStats(g.picks);
        return { capperId, name: g.name, wins: stats.wins, losses: stats.losses, pushes: stats.pushes, winPct: stats.winPct };
      })
      .filter((e) => e.wins + e.losses + e.pushes >= CATEGORY_LEADERBOARD_MIN_PICKS)
      .sort((a, b) => b.winPct - a.winPct)
      .slice(0, CATEGORY_LEADERBOARD_LIMIT);
  }

  return { breakdown, leaderboards };
}

// Blocks an exact-name duplicate (case/punctuation-insensitive) for this
// user before it ever reaches the DB - the bulk-import path already checks
// this itself (so this rarely fires there), but the manual "Add Capper"
// form had no such check at all, which is how a real production account
// ended up with two identical "Nicky Cashin" rows. Near-duplicate (fuzzy,
// non-exact) names are intentionally NOT blocked here - those are surfaced
// as a non-blocking suggestion in the bulk-import UI instead, since a hard
// block on a fuzzy match risks refusing a genuinely different capper who
// just happens to have a similar name.
export async function createCapper(
  userId: string,
  data: {
    name: string;
    source: Source;
    customSource?: string;
    photoUrl?: string;
    notes?: string;
    sportSpecialization?: string;
    colorTag?: string;
  }
) {
  const normalized = normalizeName(data.name);
  const existing = await prisma.capper.findMany({ where: { userId }, select: { name: true } });
  if (existing.some((c) => normalizeName(c.name) === normalized)) {
    throw new Error(`You already have a capper named "${data.name}".`);
  }

  return prisma.capper.create({
    data: { ...data, userId },
  });
}

export type CapperSummary = { id: string; name: string; pickCount: number };

// Every one of a user's cappers with their pick count, alphabetical - backs
// the merge tool's manual "pick any two cappers" selector.
export async function getCappersWithPickCounts(userId: string): Promise<CapperSummary[]> {
  const cappers = await prisma.capper.findMany({
    where: { userId },
    include: { _count: { select: { picks: true } } },
    orderBy: { name: "asc" },
  });
  return cappers.map((c) => ({ id: c.id, name: c.name, pickCount: c._count.picks }));
}

export type SuspectedDuplicatePair = { capperA: CapperSummary; capperB: CapperSummary; distance: number };

// Scans a user's own cappers for likely-duplicate name pairs (exact-but-
// somehow-distinct rows, or a fuzzy typo/plural match) - surfaced as review
// suggestions in the merge tool, never auto-merged. Sorted by distance (0 =
// exact duplicates first, since those are the least ambiguous) then by the
// larger pair's combined pick count descending, so the highest-impact
// suggestions surface first.
export async function findSuspectedDuplicateCappers(userId: string): Promise<SuspectedDuplicatePair[]> {
  const cappers = await getCappersWithPickCounts(userId);

  const pairs: SuspectedDuplicatePair[] = [];
  for (let i = 0; i < cappers.length; i++) {
    for (let j = i + 1; j < cappers.length; j++) {
      const distance = duplicateNameDistance(cappers[i].name, cappers[j].name);
      if (distance === null) continue;
      pairs.push({ capperA: cappers[i], capperB: cappers[j], distance });
    }
  }

  return pairs.sort(
    (a, b) => a.distance - b.distance || b.capperA.pickCount + b.capperB.pickCount - (a.capperA.pickCount + a.capperB.pickCount)
  );
}

export type MergeCappersResult = { mergedPickCount: number; primaryName: string; duplicateName: string };

// Reassigns every pick from `duplicateId` to `primaryId`, then deletes the
// now-empty duplicate capper - both userId-scoped so one user can't merge or
// touch another's cappers via a crafted id. Order matters: Pick.capperId has
// onDelete: Cascade (prisma/schema.prisma), so deleting the duplicate BEFORE
// reassigning its picks would silently wipe that pick history instead of
// preserving it. Wrapped in a transaction so a failure partway through never
// leaves picks reassigned but the duplicate row still sitting there (or vice
// versa).
export async function mergeCappers(userId: string, primaryId: string, duplicateId: string): Promise<MergeCappersResult> {
  if (primaryId === duplicateId) {
    throw new Error("Can't merge a capper into itself.");
  }

  const [primary, duplicate] = await Promise.all([
    prisma.capper.findFirst({ where: { id: primaryId, userId } }),
    prisma.capper.findFirst({ where: { id: duplicateId, userId } }),
  ]);
  if (!primary || !duplicate) {
    throw new Error("One or both cappers weren't found.");
  }

  const [{ count }] = await prisma.$transaction([
    prisma.pick.updateMany({ where: { userId, capperId: duplicateId }, data: { capperId: primaryId } }),
    prisma.capper.delete({ where: { id: duplicateId } }),
  ]);

  return { mergedPickCount: count, primaryName: primary.name, duplicateName: duplicate.name };
}
