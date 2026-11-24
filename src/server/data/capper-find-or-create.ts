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
  db: Db = prisma,
  // The caller's own read of this user's cappers, taken in the same action (the bulk
  // imports read the roster once and keep it current as they create). Given one, the
  // scan below uses it instead of reading the roster again for every new capper. The
  // insert's ON CONFLICT still stops an exact duplicate raised since that read.
  knownCappers?: readonly { id: string; name: string }[]
): Promise<FindOrCreateCapperResult> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Capper name is required.");

  const normalized = normalizeName(trimmed);
  if (normalized !== "") {
    // The scan needs only names; the full row is read for the one match. A
    // match deleted in between falls through to the insert below.
    const existing = knownCappers ?? (await db.capper.findMany({ where: { userId }, select: { id: true, name: true } }));
    const match = existing.find((c) => normalizeName(c.name) === normalized);
    const capper = match ? await db.capper.findUnique({ where: { id: match.id } }) : null;
    if (capper) return { capper, created: false };
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

// The user's cappers whose normalizeName is one of `names`' normalized forms -
// the targeted twin of reading the whole roster. Exhaustive for those keys, so a
// caller that only ever looks up these names (insertPicksDeduped, and the
// resolveImportRefs / findOrCreateCapper scans it hands the result to) sees
// exactly what a full roster read would have shown it. Names whose normalized
// form is empty are skipped: no rule matches them by normalized name.
//
// The SQL mirrors normalizeName (JS toLowerCase, then strip [^a-z0-9]). The only
// characters JS lowercases INTO ASCII are U+0130 (I with dot, -> "i" + a
// combining dot the strip removes) and U+212A (Kelvin sign, -> "k"); translate()
// maps both first so Postgres' collation-dependent lower() can't disagree. The
// rows are re-checked with normalizeName in JS, so the SQL can only widen, never
// decide, a match.
export async function readCappersByNormalizedNames(
  db: Db,
  userId: string,
  names: readonly string[]
): Promise<{ id: string; name: string }[]> {
  const keys = Array.from(new Set(names.map(normalizeName).filter((k) => k !== "")));
  if (keys.length === 0) return [];
  const rows = await db.$queryRaw<{ id: string; name: string }[]>`
    SELECT id, name FROM cappers
    WHERE "userId" = ${userId}
      AND regexp_replace(lower(translate(name, ${"İK"}, 'ik')), '[^a-z0-9]', '', 'g') = ANY(${keys}::text[])`;
  const wanted = new Set(keys);
  return rows.filter((c) => wanted.has(normalizeName(c.name)));
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
