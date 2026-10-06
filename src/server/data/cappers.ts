import { prisma } from "@/lib/prisma";
import { Prisma, type Source } from "@prisma/client";
import { findOrCreateCapper, findCapperNameCollision } from "@/server/data/capper-find-or-create";
import { normalizeName, duplicateNameDistance } from "@/lib/fuzzy-match";
import { cacheKeys } from "@/lib/cache-keys";
import { cachedByTag } from "@/server/data/cached";
import {
  computeStats,
  computeSpecialistTag,
  pickCategory,
  weightedRoiScore,
  filterPicksByGameWindow,
  ALL_TIME_WINDOW,
  RANKING_MIN_SAMPLE,
  type RecordStats,
  type PickCategoryKey,
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
  stats: RecordStats;
  weightedScore: number;
  specialist: SpecialistTag | null;
  isFavorite: boolean;
};

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

// Ownership-checked so a crafted capperId can't toggle another user's
// capper. Returns the new value (not just void) so the caller can update
// optimistic UI state from the real persisted result rather than assuming
// the toggle direction it guessed client-side actually landed.
export async function toggleFavoriteCapper(userId: string, capperId: string): Promise<boolean> {
  const capper = await prisma.capper.findFirst({ where: { id: capperId, userId } });
  if (!capper) {
    throw new Error("Capper not found.");
  }
  const updated = await prisma.capper.update({
    where: { id: capperId },
    data: { isFavorite: !capper.isFavorite },
  });
  return updated.isFavorite;
}

export type FavoriteCappersSummary = {
  // OverallStats' currentStreak field is NOT meaningful here - see the
  // comment where this is actually computed (getFavoriteCappersSummary
  // below) for why. The type is shared with every other single-capper stats
  // object, but this particular value must never be read as one.
  collectiveStats: RecordStats;
  entries: LeaderboardEntry[];
};

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

// getSportCategoryPanelData (the raw-pick original), SportCategoryPanelData
// and CategoryLeaderboardEntry moved to sport-category-panel-legacy.ts - NOT
// called by any page (/cappers and /live both use the SQL version in
// pick-aggregates-cappers-adapter.ts, same name, same return shape, since
// #128) and only ever needed as the parity reference for
// capper-list-aggregates-acceptance-test.ts, live-category-panel-parity-acceptance-test.ts,
// and the T2 harness's `old` registry entry. Import it from there, not here.

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
  const { name, ...rest } = data;
  const { capper, created } = await findOrCreateCapper(userId, name, rest);
  if (!created) {
    throw new Error(`You already have a capper named "${name.trim()}".`);
  }
  return capper;
}

export type CapperSummary = { id: string; name: string; pickCount: number };

// Every one of a user's cappers with their pick count, alphabetical - backs
// the merge tool's manual "pick any two cappers" selector.
//
// Cached per user in the shared Data Cache (60 s), tagged with the user's
// dashboard tag: it changes only when the user's cappers or picks do, and every
// such mutation revalidates that tag (docs/cache-invalidation-contract.md).
export async function getCappersWithPickCounts(userId: string): Promise<CapperSummary[]> {
  return cachedByTag(cacheKeys.cappersWithPickCounts(userId), 60, () => loadCappersWithPickCounts(userId), [
    cacheKeys.dashboard(userId),
  ]);
}

async function loadCappersWithPickCounts(userId: string): Promise<CapperSummary[]> {
  const cappers = await prisma.capper.findMany({
    where: { userId },
    // Only what CapperSummary carries: the full capper row (photo, notes, source, ...) was
    // fetched for the whole roster on every capper-detail load and discarded.
    select: { id: true, name: true, _count: { select: { picks: true } } },
    orderBy: { name: "asc" },
  });
  return cappers.map((c) => ({ id: c.id, name: c.name, pickCount: c._count.picks }));
}

export type SuspectedDuplicatePair = { capperA: CapperSummary; capperB: CapperSummary; distance: number };

// Canonical (order-independent) key for a capper pair - always the
// lexicographically smaller id first, so "A~B" and "B~A" resolve to the same
// identity regardless of which capper happened to be cappers[i] vs
// cappers[j] in a given scan, or which side the user clicked in the UI.
function orderedPairIds(idA: string, idB: string): [string, string] {
  return idA < idB ? [idA, idB] : [idB, idA];
}

// Scans a user's own cappers for likely-duplicate name pairs (exact-but-
// somehow-distinct rows, or a fuzzy typo/plural match) - surfaced as review
// suggestions in the merge tool, never auto-merged. Sorted by distance (0 =
// exact duplicates first, since those are the least ambiguous) then by the
// larger pair's combined pick count descending, so the highest-impact
// suggestions surface first. Excludes any pair previously dismissed via
// dismissDuplicatePair - keyed by capper id, not name, so a rename can't
// resurface (or wrongly suppress) a dismissal.
export async function findSuspectedDuplicateCappers(userId: string): Promise<SuspectedDuplicatePair[]> {
  const [cappers, dismissed] = await Promise.all([
    getCappersWithPickCounts(userId),
    prisma.dismissedDuplicatePair.findMany({ where: { userId }, select: { capperAId: true, capperBId: true } }),
  ]);
  const dismissedKeys = new Set(dismissed.map((d) => d.capperAId + "|" + d.capperBId));

  const pairs: SuspectedDuplicatePair[] = [];
  for (let i = 0; i < cappers.length; i++) {
    for (let j = i + 1; j < cappers.length; j++) {
      const distance = duplicateNameDistance(cappers[i].name, cappers[j].name);
      if (distance === null) continue;
      const [a, b] = orderedPairIds(cappers[i].id, cappers[j].id);
      if (dismissedKeys.has(a + "|" + b)) continue;
      pairs.push({ capperA: cappers[i], capperB: cappers[j], distance });
    }
  }

  return pairs.sort(
    (a, b) => a.distance - b.distance || b.capperA.pickCount + b.capperB.pickCount - (a.capperA.pickCount + a.capperB.pickCount)
  );
}

// Persists a "not a duplicate" dismissal so it survives refreshes and future
// scans (see findSuspectedDuplicateCappers above) - previously this was
// client-only React state (merge-cappers-panel.tsx's `dismissed` Set), which
// reset on every reload/revisit. Both cappers must belong to `userId` (same
// ownership check pattern as mergeCappers) so a crafted id can't dismiss a
// pair for another user's data. Idempotent: dismissing an already-dismissed
// pair again just no-ops (unique constraint on the canonical id pair) rather
// than erroring - upsert avoids a race between a concurrent duplicate click
// and a genuine check-then-insert.
export async function dismissDuplicatePair(userId: string, capperIdA: string, capperIdB: string): Promise<void> {
  if (capperIdA === capperIdB) {
    throw new Error("Can't dismiss a capper against itself.");
  }
  const [capperA, capperB] = await Promise.all([
    prisma.capper.findFirst({ where: { id: capperIdA, userId } }),
    prisma.capper.findFirst({ where: { id: capperIdB, userId } }),
  ]);
  if (!capperA || !capperB) {
    throw new Error("One or both cappers weren't found.");
  }

  const [a, b] = orderedPairIds(capperIdA, capperIdB);
  await prisma.dismissedDuplicatePair.upsert({
    where: { capperAId_capperBId: { capperAId: a, capperBId: b } },
    create: { userId, capperAId: a, capperBId: b },
    update: {},
  });
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

// Plain rename, no merge semantics - updateMany (not update) so the where
// clause can carry both id and userId in one query rather than a separate
// ownership check. A name that collides with another of this user's cappers
// (same rules as creation, see findOrCreateCapper) is REFUSED with a friendly
// error, never treated as a merge signal: the UI is what decides merge vs.
// rename (an explicit, separate action the user picks), never this function
// inferring intent from the name string. Changing only the case/spacing of the
// capper's OWN name is fine - the capper itself is excluded from the check.
export async function renameCapper(userId: string, capperId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Capper name is required.");
  }
  if (await findCapperNameCollision(userId, trimmed, capperId)) {
    throw new Error(`You already have a capper named "${trimmed}".`);
  }
  let count: number;
  try {
    ({ count } = await prisma.capper.updateMany({ where: { id: capperId, userId }, data: { name: trimmed } }));
  } catch (err) {
    // Raced past the check above and hit cappers_user_lower_name_key.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new Error(`You already have a capper named "${trimmed}".`);
    }
    throw err;
  }
  if (count === 0) {
    throw new Error("Capper not found.");
  }
}

export type DeleteCapperResult = { deletedPickCount: number };

// id+userId scoped in one query (deleteMany, not delete - Capper's only
// unique identifier is id, so a plain delete() can't also require userId in
// its where clause) so one user can't delete another's capper via a crafted
// id. Pick.capperId and ParlayBet.capperId both have onDelete: Cascade
// (prisma/schema.prisma), so this one call also removes every pick and
// parlay leg tied to the capper - by design, for the junk/parser-misfire
// case this exists for (see cappers-leaderboard-table.tsx's "Toronto
// Argonauts vs. Edmonton Elks" example), not something to soften with a
// pick-preserving alternative. The caller is responsible for confirming
// with the user first; this function does not ask.
export async function deleteCapper(userId: string, capperId: string): Promise<DeleteCapperResult> {
  const deletedPickCount = await prisma.pick.count({ where: { userId, capperId } });
  const { count } = await prisma.capper.deleteMany({ where: { id: capperId, userId } });
  if (count === 0) {
    throw new Error("Capper not found.");
  }
  return { deletedPickCount };
}
