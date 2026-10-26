import { revalidateTag } from "next/cache";
import { prisma } from "@/lib/prisma";
import { cacheKeys } from "@/lib/cache-keys";
import { cachedByTag } from "@/server/data/cached";

// The user's capper roster: every capper, favorites first, then by name. One
// accessor for every page that needs the list (/picks, /charts, /picks/import,
// the /live category panel, the /live board's capper names and colours).
//
// The roster used to be a database read per page load - about 150 a day for one
// user, 190 rows each. It changes only when the user's cappers do, so it is held
// in the Data Cache per user and busted by revalidateCapperRoster from every
// capper write. The TTL is only the backstop for a write that does not go
// through one of those (a manual SQL edit); every runtime writer is listed in
// capper-roster-guard-acceptance-test.ts.
//
// Four columns, the union of what the callers read: id and name everywhere,
// colorTag and isFavorite for the /live board's pick cards. The result is shared
// by concurrent callers (see cached.ts) - read it, never mutate it.
//
// NOT for write paths. The import and find-or-create paths read the roster
// themselves, inside their own transaction, once per action: a roster that is
// stale by a few seconds there would create a duplicate capper.
export type CapperRosterEntry = { id: string; name: string; colorTag: string | null; isFavorite: boolean };

export const CAPPER_ROSTER_REVALIDATE_SECONDS = 3600;

export function loadCapperRoster(userId: string): Promise<CapperRosterEntry[]> {
  return prisma.capper.findMany({
    where: { userId },
    select: { id: true, name: true, colorTag: true, isFavorite: true },
    orderBy: [{ isFavorite: "desc" }, { name: "asc" }],
  });
}

export function getCapperRoster(userId: string): Promise<CapperRosterEntry[]> {
  return cachedByTag(cacheKeys.cappersRoster(userId), CAPPER_ROSTER_REVALIDATE_SECONDS, () => loadCapperRoster(userId));
}

// Call from every code path that creates, renames, favorites, merges or deletes
// a capper, after the write has committed. A no-op outside a Next request.
export function revalidateCapperRoster(userId: string): void {
  revalidateTag(cacheKeys.cappersRoster(userId));
}
