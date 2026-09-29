// The ONLY place a Capper row may be written at runtime (enforced by
// capper-create-guard-acceptance-test.ts).
//
// Two layers keep a user's capper names unique:
//   1. Strict app-level match - normalizeName (lowercase, every non-alphanumeric
//      stripped), so "Sharp Sam" / "SharpSam" / "Sharp-Sam" are one capper. This is
//      the pre-existing behaviour and is looser than the index, so it stays.
//      Skipped when normalizeName is empty (an emoji-only or punctuation-only
//      name): every such name would otherwise match every other one.
//   2. The unique index cappers_user_lower_name_key on ("userId", lower(btrim(name))),
//      the race backstop. Two concurrent creates can both pass layer 1.
//
// The insert is INSERT ... ON CONFLICT ("userId", lower(btrim(name))) DO NOTHING
// rather than a Prisma create that catches P2002: inside an interactive
// transaction a caught unique violation leaves Postgres in the aborted state
// (25P02), so the next statement fails. DO NOTHING never raises, so this is safe
// inside or outside a transaction, and needs no savepoint.
//
// The insert is raw SQL, so Prisma does not fill defaults. Prisma-side defaults
// (not present in the database) MUST be set here: id (cuid) and updatedAt
// (@updatedAt). isFavorite and createdAt have database defaults and are left to
// them. capper-find-or-create-acceptance-test.ts checks this list against
// Prisma's DMMF so a newly added required column fails CI.
import { Prisma, type PrismaClient, type Source, type Capper } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeName } from "@/lib/fuzzy-match";

type Db = PrismaClient | Prisma.TransactionClient;

export type NewCapperData = {
  source: Source;
  customSource?: string;
  photoUrl?: string;
  notes?: string;
  sportSpecialization?: string;
  colorTag?: string;
};

// Columns written by the raw INSERT. Keep in step with the Capper model; the
// acceptance test enforces it.
export const CAPPER_INSERT_COLUMNS = [
  "id",
  "userId",
  "name",
  "photoUrl",
  "source",
  "customSource",
  "notes",
  "sportSpecialization",
  "colorTag",
  "updatedAt",
] as const;

type InsertColumn = (typeof CAPPER_INSERT_COLUMNS)[number];

export type FindOrCreateCapperResult = { capper: Capper; created: boolean };

async function readByIndexKey(db: Db, userId: string, name: string): Promise<Capper | null> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM cappers WHERE "userId" = ${userId} AND lower(btrim(name)) = lower(btrim(${name})) LIMIT 1`;
  if (rows.length === 0) return null;
  return db.capper.findUnique({ where: { id: rows[0].id } });
}

export async function findOrCreateCapper(
  userId: string,
  name: string,
  data: NewCapperData = { source: "OTHER", customSource: "Catalog import" },
  db: Db = prisma
): Promise<FindOrCreateCapperResult> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Capper name is required.");

  const normalized = normalizeName(trimmed);
  if (normalized !== "") {
    const existing = await db.capper.findMany({ where: { userId } });
    const match = existing.find((c) => normalizeName(c.name) === normalized);
    if (match) return { capper: match, created: false };
  }

  const values: Record<InsertColumn, unknown> = {
    id: globalThis.crypto.randomUUID(),
    userId,
    name: trimmed,
    photoUrl: data.photoUrl ?? null,
    source: data.source,
    customSource: data.customSource ?? null,
    notes: data.notes ?? null,
    sportSpecialization: data.sportSpecialization ?? null,
    colorTag: data.colorTag ?? null,
    updatedAt: new Date(),
  };
  const cols = Prisma.join(CAPPER_INSERT_COLUMNS.map((c) => Prisma.raw(`"${c}"`)));
  const vals = Prisma.join(
    CAPPER_INSERT_COLUMNS.map((c) => (c === "source" ? Prisma.sql`${values[c]}::"Source"` : Prisma.sql`${values[c]}`))
  );
  const inserted = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO cappers (${cols}) VALUES (${vals})
    ON CONFLICT ("userId", lower(btrim(name))) DO NOTHING
    RETURNING id`;

  if (inserted.length > 0) {
    const capper = await db.capper.findUniqueOrThrow({ where: { id: inserted[0].id } });
    return { capper, created: true };
  }
  // Lost the race (or the index rule matched something normalizeName did not).
  const winner = await readByIndexKey(db, userId, trimmed);
  if (!winner) throw new Error("Could not create or find capper \"" + trimmed + "\".");
  return { capper: winner, created: false };
}

// True if `name` collides with one of this user's OTHER cappers under the same
// rules as creation (strict normalizeName match, then the index expression).
export async function findCapperNameCollision(
  userId: string,
  name: string,
  excludeCapperId: string,
  db: Db = prisma
): Promise<boolean> {
  const trimmed = name.trim();
  const normalized = normalizeName(trimmed);
  const others = await db.capper.findMany({ where: { userId, id: { not: excludeCapperId } }, select: { name: true } });
  const lowered = trimmed.toLowerCase();
  return others.some(
    (c) => (normalized !== "" && normalizeName(c.name) === normalized) || c.name.trim().toLowerCase() === lowered
  );
}
