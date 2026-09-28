// Backfill / verify Pick.category + Pick.categoryVersion.
//
//   npx tsx scripts/backfill-pick-category.ts            # DRY RUN (default): reads, reports, writes nothing
//   npx tsx scripts/backfill-pick-category.ts --apply    # actually writes
//   npx tsx scripts/backfill-pick-category.ts --verify   # READ-ONLY audit of every stored stamp (see below)
//   options: --batch=500   rows read per batch (default 500)
//
// BACKFILL (default / --apply): stamps picks that predate the stored-category
// columns (categoryVersion = 0), or that were stamped by an older
// PICK_CATEGORY_VERSION. It calls the real pickCategory() from stats.ts - there
// is no second copy of the classification logic - and only ever writes rows by
// exact id (an `id IN (...)` list of the rows it just read, further guarded by
// categoryVersion < current, so re-running is idempotent and never overwrites a
// current stamp). It never changes any column other than category /
// categoryVersion. The paging engine is backfillPickCategory in
// src/server/data/backfill-pick-category.ts.
//
// VERIFY (--verify): pages through EVERY pick (not just stale ones), recomputes
// pickCategory(row) and compares it with the stored category. Prints total rows,
// unstamped rows (categoryVersion < current), mismatches, and up to 20 sample
// mismatches (id, stored, computed). It performs ZERO writes, and that is enforced
// by Postgres: the pass runs in a SET TRANSACTION READ ONLY transaction (see
// verifyPickCategory). Exits 1 if any mismatch or unstamped row is found, so it
// can gate a rollout. Cannot be combined with --apply.
//
// Run it against the database named by DATABASE_URL; it prints the host (never
// the credentials) and the row counts before doing anything so you can confirm
// the target. A dry run first is the intended workflow for the backfill.
import { prisma } from "@/lib/prisma";
import { PICK_CATEGORY_VERSION } from "@/server/data/stats";
import { backfillPickCategory, verifyPickCategory } from "@/server/data/backfill-pick-category";

const apply = process.argv.includes("--apply");
const verify = process.argv.includes("--verify");
const batchArg = process.argv.find((a) => a.startsWith("--batch="));
const batchSize = batchArg ? Math.max(1, parseInt(batchArg.slice("--batch=".length), 10) || 500) : 500;

function targetHost(): string {
  try {
    const u = new URL(process.env.DATABASE_URL ?? "");
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set.");
  if (verify && apply) throw new Error("--verify is read-only and cannot be combined with --apply.");

  console.log(`Target:            ${targetHost()}`);
  console.log(`Mode:              ${verify ? "VERIFY (read-only, enforced by the database)" : apply ? "APPLY (writes)" : "DRY RUN (no writes)"}`);
  console.log(`PICK_CATEGORY_VERSION: ${PICK_CATEGORY_VERSION}`);

  if (verify) {
    const r = await verifyPickCategory({ batchSize, maxSamples: 20, log: (line) => console.log(line) });
    console.log("");
    console.log(`Total rows:        ${r.total}`);
    console.log(`Rows visited:      ${r.read}${r.read === r.total ? "" : "   <-- DOES NOT MATCH TOTAL (rows changed during the run, or a paging bug)"}`);
    console.log(`Unstamped rows:    ${r.unstamped}   (categoryVersion < ${PICK_CATEGORY_VERSION})`);
    console.log(`Mismatches:        ${r.mismatches}   (stamped rows whose stored category != pickCategory(row))`);
    if (r.aheadOfCurrent > 0) console.log(`Ahead of current:  ${r.aheadOfCurrent}   (categoryVersion > ${PICK_CATEGORY_VERSION}; compared like the rest)`);
    if (r.samples.length > 0) {
      console.log(`\nSample mismatches (up to 20):`);
      for (const s of r.samples) console.log(`  ${s.id}  stored=${s.stored ?? "(null)"} (v${s.storedVersion})  computed=${s.computed ?? "(null)"}`);
      console.log(`\nMismatch breakdown (stored -> computed):`);
      for (const [pair, n] of Array.from(r.mismatchPairs.entries()).sort((a, b) => b[1] - a[1])) console.log(`  ${pair.padEnd(40)} ${n}`);
    }
    const ok = r.mismatches === 0 && r.unstamped === 0 && r.read === r.total;
    console.log(`\nRESULT: ${ok ? "OK - every stored category equals pickCategory(row)" : "FAILED - see above"}`);
    if (!ok) process.exitCode = 1;
    return;
  }

  await backfillPickCategory({ apply, batchSize, log: (line) => console.log(line) });
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
