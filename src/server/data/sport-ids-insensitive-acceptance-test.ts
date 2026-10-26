// getSportIdByNameInsensitive (sport-ids.ts): the id the board's old
// `sport.findFirst({ where: { name: { equals, mode: "insensitive" } } })` returned,
// read once per process per sport whatever the casing, a miss never cached.
// prisma.sport.findFirst is replaced by an in-memory stub, so this makes no
// database query (it imports @/lib/prisma but never connects).
// Run: npx tsx src/server/data/sport-ids-insensitive-acceptance-test.ts
// Exits non-zero if any assertion fails.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { getSportIdByNameInsensitive } from "@/server/data/sport-ids";
import { __clearTtlMemo } from "@/server/data/ttl-memo";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

const table: { id: string; name: string }[] = [
  { id: "sport-mlb", name: "MLB" },
  { id: "sport-nfl", name: "NFL" },
];
let reads = 0;
let failNext = false;
const delegate = prisma.sport as unknown as { findFirst: (...a: unknown[]) => Promise<unknown> };
const realFindFirst = delegate.findFirst.bind(delegate);
delegate.findFirst = async (args: unknown) => {
  reads++;
  if (failNext) {
    failNext = false;
    throw new Error("connection reset");
  }
  const equals = (args as { where: { name: { equals: string; mode: string } } }).where.name;
  if (equals.mode !== "insensitive") throw new Error("expected an insensitive match");
  return table.find((s) => s.name.toLowerCase() === equals.equals.toLowerCase()) ?? null;
};

async function main() {
  try {
    __clearTtlMemo();

    // Casing
    reads = 0;
    const ids = [
      await getSportIdByNameInsensitive("MLB"),
      await getSportIdByNameInsensitive("mlb"),
      await getSportIdByNameInsensitive("Mlb"),
      await getSportIdByNameInsensitive("MLB"),
    ];
    check("MLB, mlb and Mlb resolve to the same id (the one the stored row has)", ids, ["sport-mlb", "sport-mlb", "sport-mlb", "sport-mlb"]);
    check("four lookups of one sport in mixed case: one query", reads, 1);
    check("another sport has its own entry and id", [await getSportIdByNameInsensitive("nfl"), reads], ["sport-nfl", 2]);

    // Miss
    reads = 0;
    check("a miss returns null (the old `if (!sport)` branch)", await getSportIdByNameInsensitive("Curling"), null);
    check("a repeat miss is not cached: it queries again", [await getSportIdByNameInsensitive("curling"), reads], [null, 2]);
    table.push({ id: "sport-curling", name: "Curling" });
    check("once the sport exists, the next lookup returns its id", await getSportIdByNameInsensitive("CURLING"), "sport-curling");

    // Cold instance
    __clearTtlMemo();
    reads = 0;
    await getSportIdByNameInsensitive("MLB");
    await getSportIdByNameInsensitive("mlb");
    check("a cold instance reads once, then serves from the memo", reads, 1);

    // Errors
    __clearTtlMemo();
    reads = 0;
    failNext = true;
    let thrown = "";
    try {
      await getSportIdByNameInsensitive("MLB");
    } catch (e) {
      thrown = e instanceof Error ? e.message : String(e);
    }
    check("a query error is rethrown (not read as a missing sport)", thrown, "connection reset");
    check("...and not cached: the next lookup queries and succeeds", [await getSportIdByNameInsensitive("MLB"), reads], ["sport-mlb", 2]);

    // Wiring: the board and game-detail reads go through the memo, and only they do.
    const picksSrc = readFileSync(join(__dirname, "picks.ts"), "utf8");
    check("picks.ts no longer reads sports directly with findFirst", /sport\.findFirst/.test(picksSrc), false);
    check(
      "getPicksForGame and getPicksForGames both use the memo",
      (picksSrc.match(/await getSportIdByNameInsensitive\(/g) ?? []).length,
      2
    );
  } finally {
    delegate.findFirst = realFindFirst;
  }
}

main()
  .catch((err) => {
    console.error("FAIL: unexpected error", err);
    failures++;
  })
  .finally(() => {
    process.exit(failures ? 1 : 0);
  });
