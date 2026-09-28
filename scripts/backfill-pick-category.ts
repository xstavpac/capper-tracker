// One-time backfill of Pick.category / Pick.categoryVersion for picks that
// predate the stored-category columns (categoryVersion = 0), or that were
// stamped by an older PICK_CATEGORY_VERSION.
//
//   npx tsx scripts/backfill-pick-category.ts            # DRY RUN (default): reads, reports, writes nothing
//   npx tsx scripts/backfill-pick-category.ts --apply    # actually writes
//   options: --batch=500   rows read per batch (default 500)
//
// It calls the real pickCategory() from stats.ts - there is no second copy of
// the classification logic - and only ever writes rows by exact id (an `id IN
// (...)` list of the rows it just read, further guarded by categoryVersion <
// current, so re-running is idempotent and never overwrites a current stamp).
// It never changes any column other than category / categoryVersion. The paging
// engine is backfillPickCategory in src/server/data/backfill-pick-category.ts.
//
// Run it against the database named by DATABASE_URL; it prints the host (never
// the credentials) and the row counts before doing anything so you can confirm
// the target. A dry run first is the intended workflow.
import { prisma } from "@/lib/prisma";
import { PICK_CATEGORY_VERSION } from "@/server/data/stats";
import { backfillPickCategory } from "@/server/data/backfill-pick-category";

const apply = process.argv.includes("--apply");
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

  console.log(`Target:            ${targetHost()}`);
  console.log(`Mode:              ${apply ? "APPLY (writes)" : "DRY RUN (no writes)"}`);
  console.log(`PICK_CATEGORY_VERSION: ${PICK_CATEGORY_VERSION}`);
  await backfillPickCategory({ apply, batchSize, log: (line) => console.log(line) });
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
