// The engine behind scripts/backfill-pick-category.ts (see that file for usage):
// stamps Pick.category / Pick.categoryVersion by calling the real pickCategory().
// Lives here, not in the script, so it can be tested against a disposable
// database. `scope` narrows which picks are considered (the CLI passes none - it
// covers every pick; tests pass their own fixture rows).
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { pickCategory, PICK_CATEGORY_VERSION } from "@/server/data/stats";

export type BackfillOptions = {
  apply: boolean;
  batchSize: number;
  scope?: Prisma.PickWhereInput;
  log?: (line: string) => void;
};

export type BackfillResult = {
  total: number;
  toStamp: number;
  read: number;
  written: number;
  remaining: number;
  tally: Map<string, number>;
};

export async function backfillPickCategory(opts: BackfillOptions): Promise<BackfillResult> {
  const log = opts.log ?? (() => {});
  const scope: Prisma.PickWhereInput = opts.scope ?? {};
  const stale: Prisma.PickWhereInput = { ...scope, categoryVersion: { lt: PICK_CATEGORY_VERSION } };
  const [total, toStamp] = await Promise.all([prisma.pick.count({ where: scope }), prisma.pick.count({ where: stale })]);
  log(`Picks total:       ${total}`);
  log(`Picks to stamp:    ${toStamp}`);

  const tally = new Map<string, number>(); // category ("(null)" for none) -> rows
  let read = 0;
  let written = 0;
  // Keyset paging: each batch is "eligible rows with id > the last id seen".
  // Do NOT page with `cursor: { id }, skip: 1` over the eligibility filter: in
  // apply mode the cursor row has just been stamped, so it no longer matches
  // `stale` and `skip: 1` skips a real unstamped row at every batch boundary
  // (a production run over 6,901 rows at batch 500 stamped 6,888 and left 13).
  // An id comparison doesn't care whether the previous row still matches. Both
  // the comparison and the ordering happen in Postgres, so they share a collation.
  let lastId: string | undefined;

  for (;;) {
    const rows = await prisma.pick.findMany({
      where: lastId ? { AND: [stale, { id: { gt: lastId } }] } : stale,
      orderBy: { id: "asc" },
      take: opts.batchSize,
      select: {
        id: true,
        betType: true,
        period: true,
        betDetail: true,
        odds: true,
        line: true,
        pickedSide: true,
        mlFavoredSide: true,
        propMarket: true,
        sport: { select: { name: true } },
      },
    });
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1].id;
    read += rows.length;

    const idsByCategory = new Map<string | null, string[]>();
    for (const row of rows) {
      const category = pickCategory({ ...row, sportName: row.sport.name });
      const ids = idsByCategory.get(category);
      if (ids) ids.push(row.id);
      else idsByCategory.set(category, [row.id]);
      const label = category ?? "(null)";
      tally.set(label, (tally.get(label) ?? 0) + 1);
    }

    if (opts.apply) {
      for (const [category, ids] of idsByCategory) {
        const { count } = await prisma.pick.updateMany({
          where: { id: { in: ids }, ...stale },
          data: { category, categoryVersion: PICK_CATEGORY_VERSION },
        });
        written += count;
      }
    }
    log(`  ...read ${read}/${toStamp}${opts.apply ? `, wrote ${written}` : ""}`);
  }

  log("\nBy category:");
  for (const [category, n] of Array.from(tally.entries()).sort((a, b) => b[1] - a[1])) {
    log(`  ${category.padEnd(22)} ${n}`);
  }
  const remaining = await prisma.pick.count({ where: stale });
  log(`\nRead ${read} pick(s); ${opts.apply ? `wrote ${written}` : "would write " + read}.`);
  log(`Picks still below version ${PICK_CATEGORY_VERSION}: ${remaining}${opts.apply ? "" : " (dry run - unchanged)"}`);
  return { total, toStamp, read, written, remaining, tally };
}

// ---------------------------------------------------------------------------
// --verify: a strictly READ-ONLY comparison of every stored category stamp with
// what pickCategory() computes for the same row today. The backfill's dry run
// only looks at rows below the current version, so once production is fully
// stamped it can no longer say whether the stamps are RIGHT - this can.
//
// "Read-only" is enforced by the database, not by convention: the whole pass runs
// inside one transaction that begins with SET TRANSACTION READ ONLY, so Postgres
// itself rejects any INSERT / UPDATE / DELETE issued through it (error 25006).
// The transaction then reads transaction_read_only back and refuses to continue
// unless it is 'on', so a pooler that swallowed the SET fails closed instead of
// silently allowing writes. Nothing in the verify path holds a handle that isn't
// this transaction's client.
// ---------------------------------------------------------------------------

// Runs `fn` in a transaction the database will not let write. Exported so the
// test can prove that a write attempted through it is rejected.
export async function runReadOnly<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const [{ ro }] = await tx.$queryRaw<{ ro: string }[]>`SELECT current_setting('transaction_read_only') AS ro`;
      if (ro !== "on") throw new Error("Refusing to verify: the transaction is not read-only (transaction_read_only = " + ro + ").");
      return fn(tx);
    },
    // One pass over every pick can outlast Prisma's 5s interactive-transaction default.
    { maxWait: 60_000, timeout: 30 * 60_000 }
  );
}

export type VerifyOptions = {
  batchSize: number;
  scope?: Prisma.PickWhereInput;
  // How many sample mismatches to keep (the CLI shows 20).
  maxSamples?: number;
  log?: (line: string) => void;
};

export type VerifyMismatch = { id: string; stored: string | null; storedVersion: number; computed: string | null };

export type VerifyResult = {
  total: number; // rows in scope
  read: number; // rows the paging actually visited (must equal total)
  unstamped: number; // categoryVersion < PICK_CATEGORY_VERSION
  aheadOfCurrent: number; // categoryVersion > PICK_CATEGORY_VERSION (informational)
  mismatches: number; // stamped rows (version >= current) whose stored category != pickCategory(row)
  samples: VerifyMismatch[];
  // "stored -> computed" for every mismatch, so a systematic drift shows up as one big line.
  mismatchPairs: Map<string, number>;
};

export async function verifyPickCategory(opts: VerifyOptions): Promise<VerifyResult> {
  const log = opts.log ?? (() => {});
  const maxSamples = opts.maxSamples ?? 20;
  const scope: Prisma.PickWhereInput = opts.scope ?? {};

  return runReadOnly(async (tx) => {
    const total = await tx.pick.count({ where: scope });
    log(`Picks total:       ${total}`);

    const result: VerifyResult = { total, read: 0, unstamped: 0, aheadOfCurrent: 0, mismatches: 0, samples: [], mismatchPairs: new Map() };

    // Keyset paging over ALL picks (not just below-current-version ones), exactly
    // as the backfill does since #124: `id > lastId`, ordered by id, so it never
    // depends on a cursor row still matching a filter.
    let lastId: string | undefined;
    for (;;) {
      const rows = await tx.pick.findMany({
        where: lastId ? { AND: [scope, { id: { gt: lastId } }] } : scope,
        orderBy: { id: "asc" },
        take: opts.batchSize,
        select: {
          id: true,
          betType: true,
          period: true,
          betDetail: true,
          odds: true,
          line: true,
          pickedSide: true,
          mlFavoredSide: true,
          propMarket: true,
          category: true,
          categoryVersion: true,
          sport: { select: { name: true } },
        },
      });
      if (rows.length === 0) break;
      lastId = rows[rows.length - 1].id;
      result.read += rows.length;

      for (const row of rows) {
        if (row.categoryVersion < PICK_CATEGORY_VERSION) {
          result.unstamped++;
          continue;
        }
        if (row.categoryVersion > PICK_CATEGORY_VERSION) result.aheadOfCurrent++;
        const computed = pickCategory({ ...row, sportName: row.sport.name });
        if (computed !== row.category) {
          result.mismatches++;
          const pair = `${row.category ?? "(null)"} -> ${computed ?? "(null)"}`;
          result.mismatchPairs.set(pair, (result.mismatchPairs.get(pair) ?? 0) + 1);
          if (result.samples.length < maxSamples) {
            result.samples.push({ id: row.id, stored: row.category, storedVersion: row.categoryVersion, computed });
          }
        }
      }
      log(`  ...read ${result.read}/${total}`);
    }
    return result;
  });
}
