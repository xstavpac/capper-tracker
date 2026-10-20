import { prisma } from "@/lib/prisma";
import { Prisma, type Source } from "@prisma/client";
import { findOrCreateCapper, findCapperNameCollision } from "@/server/data/capper-find-or-create";
import { findMergeDuplicates, lockUserPickInserts, type MergeDuplicatePick } from "@/server/data/pick-dedup";
import { EXISTING_PICK_SELECT } from "@/server/data/duplicate-db-match";
import { ENTITLEMENT_TX_OPTIONS } from "@/server/data/subscriptions";
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

// Every capper the user has, favorites first. (The old league/category filter
// branch read the user's whole pick history to narrow the list; no page used it -
// it lives on in cappers-legacy.ts as a parity reference.) Only id and name:
// every caller (/picks, /charts, /picks/import, the /live category panel) uses
// just those two, and the full row (notes, photo url, ...) was read for the
// whole roster on every one of those page loads.
export async function getCappersForUser(userId: string) {
  return prisma.capper.findMany({
    where: { userId },
    select: { id: true, name: true },
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

// getCapperLeaderboardTable moved to cappers-legacy.ts - no page calls it (the /cappers page
// computes in SQL, cappers-page-aggregates.ts); kept there only as a parity
// reference for the acceptance tests and the T2 harness.

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

// getFavoriteCappersSummary moved to cappers-legacy.ts - no page calls it (the /cappers page
// computes in SQL, cappers-page-aggregates.ts); kept there only as a parity
// reference for the acceptance tests and the T2 harness.

export type ActivityEntry = { capperId: string; name: string; colorTag: string | null; pickCount: number };

// getMostActiveThisWeek moved to cappers-legacy.ts - no page calls it (the /cappers page
// computes in SQL, cappers-page-aggregates.ts); kept there only as a parity
// reference for the acceptance tests and the T2 harness.

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

export type MergeCappersResult = {
  mergedPickCount: number;
  primaryName: string;
  duplicateName: string;
  // Moved picks that are now the same bet as one the surviving capper already
  // had. Reported only - see mergeCappers.
  duplicatePicks: MergeDuplicatePick[];
};

// Reassigns every pick from `duplicateId` to `primaryId`, then deletes the
// now-empty duplicate capper - both userId-scoped so one user can't merge or
// touch another's cappers via a crafted id. Order matters: Pick.capperId has
// onDelete: Cascade (prisma/schema.prisma), so deleting the duplicate BEFORE
// reassigning its picks would silently wipe that pick history instead of
// preserving it. Wrapped in a transaction so a failure partway through never
// leaves picks reassigned but the duplicate row still sitting there (or vice
// versa).
//
// Both cappers can hold the same pick (that is usually why they are being
// merged), and moving the picks then leaves the survivor with it twice. Those
// pairs are DETECTED and REPORTED in duplicatePicks - nothing is deleted,
// skipped or changed because of them; what to do with them is the user's call.
// The read, the reassign and the delete share one transaction under the
// per-user pick-insert lock, so an import running at the same moment cannot
// add a pick between the report and the move.
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

  const { count, duplicatePicks } = await prisma.$transaction(async (tx) => {
    await lockUserPickInserts(tx, userId);
    const select = { ...EXISTING_PICK_SELECT, sport: { select: { name: true } } };
    const keptPicks = await tx.pick.findMany({ where: { userId, capperId: primaryId }, select, orderBy: { id: "asc" } });
    const movedPicks = await tx.pick.findMany({ where: { userId, capperId: duplicateId }, select, orderBy: { id: "asc" } });
    const duplicatePicks = findMergeDuplicates(keptPicks, movedPicks);
    const { count } = await tx.pick.updateMany({ where: { userId, capperId: duplicateId }, data: { capperId: primaryId } });
    await tx.capper.delete({ where: { id: duplicateId } });
    return { count, duplicatePicks };
  }, ENTITLEMENT_TX_OPTIONS);

  return { mergedPickCount: count, primaryName: primary.name, duplicateName: duplicate.name, duplicatePicks };
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
