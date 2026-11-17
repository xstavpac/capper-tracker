// Writes Pick.uniqueKey for rows that already exist (lib/pick-unique-key.ts explains the column):
//   - restampUniqueKeys(ids): after an update that changed a key field (the category / ML-side backfills), re-read
//     those rows IN FULL and store the key of what is now there.
//   - backfillUniqueKeys(): every pick, keyset batches by id (scripts/backfill-unique-key.ts).
// Each write is `UPDATE picks SET "uniqueKey" = $k WHERE id = $id AND "uniqueKey" IS DISTINCT FROM $k`: scoped to one
// id, idempotent (a re-run writes nothing), and raw on purpose so it doesn't bump updatedAt.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { computeUniqueKey } from "@/lib/pick-unique-key";

type Db = Prisma.TransactionClient | typeof prisma;

// Exactly the columns computeUniqueKey reads (UNIQUE_KEY_FIELDS) plus id and the stored key.
export const UNIQUE_KEY_SELECT = {
  id: true,
  homeTeam: true,
  awayTeam: true,
  gameTime: true,
  gameNumber: true,
  period: true,
  betType: true,
  betDetail: true,
  pickedSide: true,
  category: true,
  line: true,
  propMarket: true,
  playerName: true,
  uniqueKey: true,
} satisfies Prisma.PickSelect;

const ID_CHUNK = 500;

async function writeKey(db: Db, id: string, key: string): Promise<number> {
  return db.$executeRaw`UPDATE picks SET "uniqueKey" = ${key} WHERE id = ${id} AND "uniqueKey" IS DISTINCT FROM ${key}`;
}

// Recompute and store the key of each listed pick from its full current row. Returns how many rows changed.
export async function restampUniqueKeys(ids: string[], db: Db = prisma): Promise<number> {
  let written = 0;
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const rows = await db.pick.findMany({ where: { id: { in: ids.slice(i, i + ID_CHUNK) } }, select: UNIQUE_KEY_SELECT });
    for (const r of rows) {
      const key = computeUniqueKey(r);
      if (r.uniqueKey !== key) written += await writeKey(db, r.id, key);
    }
  }
  return written;
}

// --verify: READ-ONLY drift check (runs in a SET TRANSACTION READ ONLY transaction, like verifyPickCategory). Counts
// NULL keys over every pick, then recomputes the key for a random sample stratified by betType - `perType` rows per
// type, `perTextType` for PLAYER_PROP and TEAM_TOTAL, whose keys depend most on text parsing - and compares it with
// the stored value. Rows are re-read through the same Prisma select the backfill uses, so dates decode identically.
export type UniqueKeyVerifyResult = {
  nullKeys: number;
  sampled: number;
  sampledByType: Record<string, number>;
  mismatches: { id: string; betType: string; stored: string | null; computed: string }[];
};

export async function verifyUniqueKeys(opts: { perType?: number; perTextType?: number } = {}): Promise<UniqueKeyVerifyResult> {
  const perType = opts.perType ?? 400;
  const perTextType = opts.perTextType ?? 1500;
  const { runReadOnly } = await import("@/server/data/backfill-pick-category");
  return runReadOnly(async (tx) => {
    const [{ n }] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM picks WHERE "uniqueKey" IS NULL`;
    const sample = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM (
        SELECT id, "betType", row_number() OVER (PARTITION BY "betType" ORDER BY random()) AS rn FROM picks
      ) s
      WHERE rn <= CASE WHEN "betType" IN ('PLAYER_PROP', 'TEAM_TOTAL') THEN ${perTextType}::int ELSE ${perType}::int END`;
    const out: UniqueKeyVerifyResult = { nullKeys: n, sampled: 0, sampledByType: {}, mismatches: [] };
    const ids = sample.map((r) => r.id);
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const rows = await tx.pick.findMany({ where: { id: { in: ids.slice(i, i + ID_CHUNK) } }, select: UNIQUE_KEY_SELECT });
      for (const r of rows) {
        out.sampled++;
        out.sampledByType[r.betType] = (out.sampledByType[r.betType] ?? 0) + 1;
        const computed = computeUniqueKey(r);
        if (r.uniqueKey !== computed) out.mismatches.push({ id: r.id, betType: r.betType, stored: r.uniqueKey, computed });
      }
    }
    return out;
  });
}

export type UniqueKeyBackfillResult = { total: number; read: number; written: number; unchanged: number };

// textOnly: only picks whose STORED key came from the text fallback (contains "||TEXT:"), for a change to that
// fallback alone (unique-picks.ts textSide / teamSide). Keys built from structured fields can't move then.
export const TEXT_KEY_SCOPE = { uniqueKey: { contains: "||TEXT:" } } satisfies Prisma.PickWhereInput;

export async function backfillUniqueKeys(opts: {
  apply: boolean;
  batchSize?: number;
  textOnly?: boolean;
  log?: (line: string) => void;
}): Promise<UniqueKeyBackfillResult> {
  const batchSize = opts.batchSize ?? 1000;
  const log = opts.log ?? console.log;
  const scope: Prisma.PickWhereInput = opts.textOnly ? TEXT_KEY_SCOPE : {};
  const total = await prisma.pick.count({ where: scope });
  log(`[unique-key] ${opts.apply ? "APPLY" : "DRY RUN"}: ${total} picks${opts.textOnly ? " with a TEXT: key" : ""}, batches of ${batchSize}`);
  const result: UniqueKeyBackfillResult = { total, read: 0, written: 0, unchanged: 0 };
  let cursor: string | null = null;
  let batch = 0;
  for (;;) {
    const rows: Prisma.PickGetPayload<{ select: typeof UNIQUE_KEY_SELECT }>[] = await prisma.pick.findMany({
      // Keyset on id, not on the scope: a row re-keyed out of TEXT: in apply mode doesn't shift the next batch.
      where: cursor ? { AND: [scope, { id: { gt: cursor } }] } : scope,
      orderBy: { id: "asc" },
      take: batchSize,
      select: UNIQUE_KEY_SELECT,
    });
    if (rows.length === 0) break;
    batch++;
    let toWrite = 0;
    let wrote = 0;
    for (const r of rows) {
      const key = computeUniqueKey(r);
      if (r.uniqueKey === key) {
        result.unchanged++;
        continue;
      }
      toWrite++;
      if (opts.apply) wrote += await writeKey(prisma, r.id, key);
    }
    result.read += rows.length;
    result.written += wrote;
    cursor = rows[rows.length - 1].id;
    log(`[unique-key] batch ${batch}: read ${result.read}/${total}, ${opts.apply ? `wrote ${wrote}` : `would write ${toWrite}`}, unchanged so far ${result.unchanged}`);
  }
  log(`[unique-key] done: read ${result.read}, ${opts.apply ? "wrote" : "would write"} ${opts.apply ? result.written : result.read - result.unchanged}, unchanged ${result.unchanged}`);
  return result;
}
