// Capper and sport find-or-create for the bulk import paths (catalog picks and
// MLP parlays), usable both on the shared client and inside a transaction.
//
// The pick import runs these INSIDE its entitlement + insert transaction (see
// resolveImportRefs, called from bulkImportPicksAction through
// insertPicksWithEntitlementCheck). It used to find-or-create cappers and
// sports while it resolved each pasted line, before any pick was inserted - so
// an import that then timed out, threw, or was refused by the Free-plan pick
// limit left behind cappers with no picks. Inside the transaction they commit
// with the picks or not at all.
//
// Both helpers never raise on a concurrent create (INSERT ... ON CONFLICT DO
// NOTHING, then read the winner), which is what makes them safe in a
// transaction: a caught unique violation would leave Postgres in the aborted
// state (25P02) and fail every later statement.
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeName } from "@/lib/fuzzy-match";
import { findOrCreateCapper } from "@/server/data/capper-find-or-create";
import type { PickInsertData } from "@/server/data/subscriptions";

type Db = PrismaClient | Prisma.TransactionClient;

export type CapperRef = { id: string; name: string };

// Find this user's capper by normalized name, else create it. `existingCappers`
// is the caller's snapshot of the user's cappers and `cache` its per-import
// name -> id memo; both are updated, so a capper created for one line is found
// by the next. Shared by the pick and parlay imports - both must resolve a name
// the same way, or a capper created by one could fail to match in the other.
export async function resolveOrCreateCapperId(
  userId: string,
  capperName: string,
  existingCappers: CapperRef[],
  cache: Map<string, string>,
  db: Db = prisma
): Promise<string> {
  const normalizedName = normalizeName(capperName);
  // An empty normalized name (emoji-only / punctuation-only) matches nothing by
  // that rule - and must not share a cache key - so it goes straight to
  // findOrCreateCapper, whose index-expression rule tells such names apart.
  const cacheKey = normalizedName === "" ? "raw:" + capperName.trim().toLowerCase() : normalizedName;
  let capperId = cache.get(cacheKey);
  if (!capperId) {
    const existing =
      normalizedName === "" ? undefined : existingCappers.find((c) => normalizeName(c.name) === normalizedName);
    if (existing) {
      capperId = existing.id;
    } else {
      // Race-safe find-or-create: a concurrent create of the same name returns
      // the existing row instead of throwing.
      const { capper } = await findOrCreateCapper(userId, capperName, { source: "OTHER", customSource: "Catalog import" }, db);
      capperId = capper.id;
      if (!existingCappers.some((c) => c.id === capper.id)) existingCappers.push(capper);
    }
    cache.set(cacheKey, capperId);
  }
  return capperId;
}

// Find a sport by name (case-insensitively, as always), else create it.
// Sport.name is unique, so two imports creating the same new sport at once used
// to make the loser's sport.create throw P2002. The create is now ON CONFLICT
// DO NOTHING; the loser reads the winner's row.
//
// The insert is raw SQL, so Prisma does not fill defaults: `id` (cuid in the
// schema, Prisma-side) is set here. sports has no other column.
export async function resolveOrCreateSportId(sportName: string, cache: Map<string, string>, db: Db = prisma): Promise<string> {
  const key = sportName.toLowerCase();
  let sportId = cache.get(key);
  if (!sportId) {
    const found = await db.sport.findFirst({
      where: { name: { equals: sportName, mode: "insensitive" } },
      select: { id: true },
    });
    if (found) {
      sportId = found.id;
    } else {
      const inserted = await db.$queryRaw<{ id: string }[]>`
        INSERT INTO sports (id, name) VALUES (${globalThis.crypto.randomUUID()}, ${sportName})
        ON CONFLICT (name) DO NOTHING
        RETURNING id`;
      if (inserted.length > 0) {
        sportId = inserted[0].id;
      } else {
        // Lost the race: the row exists now under exactly this name.
        const winner = await db.sport.findUnique({ where: { name: sportName }, select: { id: true } });
        if (!winner) throw new Error('Could not create or find sport "' + sportName + '".');
        sportId = winner.id;
      }
    }
    cache.set(key, sportId);
  }
  return sportId;
}

// A pick queued for insert that still names its capper and sport instead of
// carrying their ids - nothing has been written for it yet.
export type PendingPickInsert = Omit<PickInsertData, "capperId" | "sportId"> & { capperName: string; sportName: string };

// Turns queued picks into insertable rows: finds or creates each distinct
// capper and sport (in first-appearance order) on `db`, which the pick import
// passes as its open transaction. One capper read, then per NEW capper the
// same three statements findOrCreateCapper always issued, and one lookup per
// distinct sport.
export async function resolveImportRefs(db: Db, userId: string, rows: PendingPickInsert[]): Promise<PickInsertData[]> {
  if (rows.length === 0) return [];
  const existingCappers: CapperRef[] = await db.capper.findMany({ where: { userId }, select: { id: true, name: true } });
  const capperCache = new Map<string, string>();
  const sportCache = new Map<string, string>();

  const out: PickInsertData[] = [];
  for (const { capperName, sportName, ...rest } of rows) {
    const capperId = await resolveOrCreateCapperId(userId, capperName, existingCappers, capperCache, db);
    const sportId = await resolveOrCreateSportId(sportName, sportCache, db);
    out.push({ ...rest, capperId, sportId });
  }
  return out;
}
