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
