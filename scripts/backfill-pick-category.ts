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
// It never changes any column other than category / categoryVersion.
//
// Run it against the database named by DATABASE_URL; it prints the host (never
// the credentials) and the row counts before doing anything so you can confirm
// the target. A dry run first is the intended workflow.
import { prisma } from "@/lib/prisma";
import { pickCategory, PICK_CATEGORY_VERSION } from "@/server/data/stats";

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

  const stale = { categoryVersion: { lt: PICK_CATEGORY_VERSION } };
  const [total, toStamp] = await Promise.all([prisma.pick.count(), prisma.pick.count({ where: stale })]);
  console.log(`Target:            ${targetHost()}`);
  console.log(`Mode:              ${apply ? "APPLY (writes)" : "DRY RUN (no writes)"}`);
  console.log(`PICK_CATEGORY_VERSION: ${PICK_CATEGORY_VERSION}`);
  console.log(`Picks total:       ${total}`);
  console.log(`Picks to stamp:    ${toStamp}`);

  const tally = new Map<string, number>(); // category ("(null)" for none) -> rows
  let read = 0;
  let written = 0;
  let cursor: string | undefined;

  for (;;) {
    const rows = await prisma.pick.findMany({
      where: stale,
      orderBy: { id: "asc" },
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
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
    cursor = rows[rows.length - 1].id;
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

    if (apply) {
      for (const [category, ids] of idsByCategory) {
        const { count } = await prisma.pick.updateMany({
          where: { id: { in: ids }, ...stale },
          data: { category, categoryVersion: PICK_CATEGORY_VERSION },
        });
        written += count;
      }
    }
    console.log(`  ...read ${read}/${toStamp}${apply ? `, wrote ${written}` : ""}`);
  }

  console.log("\nBy category:");
  for (const [category, n] of Array.from(tally.entries()).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${category.padEnd(22)} ${n}`);
  }
  const remaining = await prisma.pick.count({ where: stale });
  console.log(`\nRead ${read} pick(s); ${apply ? `wrote ${written}` : "would write " + read}.`);
  console.log(`Picks still below version ${PICK_CATEGORY_VERSION}: ${remaining}${apply ? "" : " (dry run - unchanged)"}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
