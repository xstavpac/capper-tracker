// getSportIdByName (sport-ids.ts): the same id the grading paths' old
// `sport.findUnique({ where: { name } })` returned, read once per process, a
// miss never cached.
//
// Real-database test (creates sports with a unique test name, removes them by id):
//   node --require ./scripts/server-only-stub.cjs --import tsx src/server/data/sport-ids-acceptance-test.ts
//
//  1. A hit returns the old lookup's id; repeat calls don't query.
//  2. A miss returns null (the old `if (!sport)` branch) and is not cached: once
//     the sport is created, the next call returns its id.
//  3. A cold instance (memo cleared) reads again - once.
//  4. A query error is rethrown, not cached and not turned into null.
import { prisma } from "@/lib/prisma";
import { getSportIdByName } from "@/server/data/sport-ids";
import { __clearTtlMemo } from "@/server/data/ttl-memo";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

const TAG = `sid-${Date.now()}`;
let reads = 0;
let failNext = false;
const delegate = prisma.sport as unknown as { findUnique: (...a: unknown[]) => Promise<unknown> };
const realFindUnique = delegate.findUnique.bind(delegate);
delegate.findUnique = (...a: unknown[]) => {
  reads++;
  if (failNext) {
    failNext = false;
    return Promise.reject(new Error("connection reset"));
  }
  return realFindUnique(...a);
};

async function main() {
  const created: string[] = [];
  try {
    const hit = await prisma.sport.create({ data: { name: `${TAG} Hit` } });
    created.push(hit.id);
    __clearTtlMemo();

    // 1
    reads = 0;
    const old = (await realFindUnique({ where: { name: `${TAG} Hit` } })) as { id: string } | null;
    check("a hit returns the id the old findUnique returned", await getSportIdByName(`${TAG} Hit`), old?.id);
    for (let i = 0; i < 4; i++) await getSportIdByName(`${TAG} Hit`);
    check("five lookups of one sport: one query", reads, 1);

    // 2
    reads = 0;
    check("a miss returns null", await getSportIdByName(`${TAG} Later`), null);
    check("a repeat miss is not cached: it queries again", [await getSportIdByName(`${TAG} Later`), reads], [null, 2]);
    const later = await prisma.sport.create({ data: { name: `${TAG} Later` } });
    created.push(later.id);
    check("once the sport exists, the next lookup returns its id", await getSportIdByName(`${TAG} Later`), later.id);

    // 3
    __clearTtlMemo();
    reads = 0;
    await getSportIdByName(`${TAG} Hit`);
    await getSportIdByName(`${TAG} Hit`);
    check("a cold instance reads once, then serves from the memo", reads, 1);

    // 4
    __clearTtlMemo();
    reads = 0;
    failNext = true;
    let thrown = "";
    try {
      await getSportIdByName(`${TAG} Hit`);
    } catch (e) {
      thrown = e instanceof Error ? e.message : String(e);
    }
    check("a query error is rethrown (not read as a missing sport)", thrown, "connection reset");
    check("...and not cached: the next lookup queries and succeeds", [await getSportIdByName(`${TAG} Hit`), reads], [hit.id, 2]);
  } finally {
    delegate.findUnique = realFindUnique;
    await prisma.sport.deleteMany({ where: { id: { in: created } } });
  }
}

main()
  .catch((err) => {
    console.error("FAIL: unexpected error", err);
    failures++;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(failures ? 1 : 0);
  });
