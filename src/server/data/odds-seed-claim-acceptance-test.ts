// Proof for the missing-snapshot seed claim (odds-seed-claim.ts): when today's
// OddsSnapshot row does not exist, at most one request per sport per claim
// window fetches from the Odds API, instead of every concurrent request.
//
// Covers: a present row never claims or seeds; N concurrent callers on one
// instance -> one claim, one seed; a lost claim -> no seed and `empty`; the
// per-instance negative window (no read, no claim while it lasts) and the retry
// after it; a seed that did not write the row (null) is not served as games; a
// seed that throws propagates and is retried by the next caller; the full read
// and the ticker read share one attempt; a non-missing read error is rethrown
// untouched; and - by source inspection - that odds.ts's two cached reads can no
// longer reach the Odds API fetch.
//
// Pure: no database, no network, no Next context. Run with:
//   npx tsx src/server/data/odds-seed-claim-acceptance-test.ts
// Exits non-zero on any failed assertion.
import { readFileSync } from "node:fs";
import {
  ODDS_SEED_CLAIM_WINDOW_SECONDS,
  ODDS_SEED_RETRY_MS,
  OddsSnapshotMissingError,
  __clearOddsSeedAttempts,
  isOddsSnapshotMissing,
  readSnapshotOrSeed,
  type OddsSeedDeps,
} from "@/server/data/odds-seed-claim";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

type Game = { id: string };
const MLB = "baseball_mlb";
const NFL = "americanfootball_nfl";
const DAY = "2026-10-07";

// A fake fleet: `row` is the database row (shared by every instance), `leases`
// the shared Data Cache claim entries. One world per scenario.
function makeWorld(opts: { seedResult?: "write" | "null" | "throw"; claim?: "lease" | boolean } = {}) {
  const world = {
    clock: Date.UTC(2026, 9, 7, 4, 0, 30),
    row: null as Game[] | null,
    reads: 0,
    claims: 0,
    seeds: 0,
    leases: new Set<string>(),
    seedResult: opts.seedResult ?? "write",
  };
  const deps: OddsSeedDeps<Game> = {
    now: () => world.clock,
    claimWindow: async (sportKey, fetchDate, bucket) => {
      world.claims++;
      if (typeof opts.claim === "boolean") return opts.claim;
      const k = `${sportKey}:${fetchDate}:${bucket}`;
      if (world.leases.has(k)) return false;
      world.leases.add(k);
      return true;
    },
    seed: async () => {
      world.seeds++;
      await Promise.resolve();
      if (world.seedResult === "throw") throw new Error("upsert failed");
      if (world.seedResult === "null") return null;
      world.row = [{ id: "g1" }, { id: "g2" }];
      return world.row;
    },
  };
  const read = async (): Promise<Game[]> => {
    world.reads++;
    await Promise.resolve();
    if (!world.row) throw new OddsSnapshotMissingError(MLB, DAY);
    return world.row;
  };
  const call = (sportKey = MLB) =>
    readSnapshotOrSeed<Game, Game[]>({ sportKey, fetchDate: DAY, read, fromSeeded: (g) => g, empty: [], deps });
  return { world, deps, read, call };
}

async function main() {
  // 1. Row already there: a plain read, nothing else.
  {
    __clearOddsSeedAttempts();
    const { world, call } = makeWorld();
    world.row = [{ id: "g9" }];
    expect("1 present row is returned", await call(), [{ id: "g9" }]);
    expect("1 present row: no claim, no seed", [world.claims, world.seeds], [0, 0]);
  }

  // 2. Missing row, 50 concurrent callers on one instance: one claim, one seed.
  {
    __clearOddsSeedAttempts();
    const { world, call } = makeWorld();
    const results = await Promise.all(Array.from({ length: 50 }, () => call()));
    expect("2 exactly one seed for 50 concurrent callers", world.seeds, 1);
    expect("2 exactly one claim for 50 concurrent callers", world.claims, 1);
    expect("2 every caller got the seeded games", results.every((r) => r.length === 2), true);
    const readsAfterBurst = world.reads;
    expect("2 a later call just reads the row", await call(), [{ id: "g1" }, { id: "g2" }]);
    expect("2 later call: still one seed, one more read", [world.seeds, world.reads - readsAfterBurst], [1, 1]);
  }

  // 3. Another instance holds the claim: this one does not fetch.
  {
    __clearOddsSeedAttempts();
    const { world, call } = makeWorld({ claim: false });
    expect("3 lost claim returns empty", await call(), []);
    expect("3 lost claim: no seed", world.seeds, 0);

    // Negative window: no read and no claim check while it lasts.
    const before = [world.reads, world.claims];
    world.clock += ODDS_SEED_RETRY_MS - 1;
    expect("3 inside the retry window: empty", await call(), []);
    expect("3 inside the retry window: no read, no claim", [world.reads, world.claims], before);

    // The other instance's seed landed. After the window this instance reads it.
    world.row = [{ id: "g1" }];
    world.clock += 2;
    expect("3 after the retry window the row is read", await call(), [{ id: "g1" }]);
    expect("3 still never seeded here", world.seeds, 0);
  }

  // 4. Two instances, one shared claim lease: one fetch between them. The
  //    per-instance memo is module state, so "instance B" is simulated by
  //    clearing it while keeping the same world (row + leases).
  {
    __clearOddsSeedAttempts();
    const { world, call } = makeWorld({ seedResult: "null" });
    expect("4 instance A: fetch failed -> empty", await call(), []);
    __clearOddsSeedAttempts();
    expect("4 instance B: claim already taken -> empty", await call(), []);
    expect("4 one fetch attempt across both instances", world.seeds, 1);

    // Same bucket, later: still nobody refetches.
    __clearOddsSeedAttempts();
    world.clock += 20_000;
    await call();
    expect("4 same claim window: still one fetch attempt", world.seeds, 1);

    // Next claim window: one retry.
    __clearOddsSeedAttempts();
    world.clock += ODDS_SEED_CLAIM_WINDOW_SECONDS * 1000;
    world.seedResult = "write";
    expect("4 next claim window retries and seeds", (await call()).length, 2);
    expect("4 two fetch attempts in total", world.seeds, 2);
  }

  // 5. A seed that did not write the row is never served as games, and is not
  //    retried on every request.
  {
    __clearOddsSeedAttempts();
    const { world, call } = makeWorld({ seedResult: "null", claim: true });
    expect("5 failed fetch returns empty", await call(), []);
    await Promise.all(Array.from({ length: 20 }, () => call()));
    expect("5 20 more requests inside the window: no further fetch", world.seeds, 1);
    world.clock += ODDS_SEED_RETRY_MS + 1;
    await call();
    expect("5 after the window, one more attempt", world.seeds, 2);
  }

  // 6. A seed that throws propagates (as the uncached path always did) and is
  //    not remembered as a verdict.
  {
    __clearOddsSeedAttempts();
    const { world, call } = makeWorld({ seedResult: "throw", claim: true });
    let threw = "";
    try {
      await call();
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    expect("6 seed error propagates", threw, "upsert failed");
    world.seedResult = "write";
    expect("6 next caller retries immediately", (await call()).length, 2);
    expect("6 two seed calls", world.seeds, 2);
  }

  // 7. The full read and the ticker read share one attempt per sport; another
  //    sport is independent.
  {
    __clearOddsSeedAttempts();
    const { world, deps, read } = makeWorld();
    const full = readSnapshotOrSeed<Game, Game[]>({ sportKey: MLB, fetchDate: DAY, read, fromSeeded: (g) => g, empty: [], deps });
    const ticker = readSnapshotOrSeed<Game, string[]>({
      sportKey: MLB,
      fetchDate: DAY,
      read: async () => (await read()).map((g) => g.id),
      fromSeeded: (g) => g.map((x) => x.id),
      empty: [],
      deps,
    });
    const [f, t] = await Promise.all([full, ticker]);
    expect("7 full read got games", f, [{ id: "g1" }, { id: "g2" }]);
    expect("7 ticker read got its own shape", t, ["g1", "g2"]);
    expect("7 one seed for both shapes", world.seeds, 1);

    world.row = null;
    await readSnapshotOrSeed<Game, Game[]>({ sportKey: NFL, fetchDate: DAY, read, fromSeeded: (g) => g, empty: [], deps });
    expect("7 a different sport seeds on its own", world.seeds, 2);
  }

  // 8. A new day replaces the previous day's remembered attempt.
  {
    __clearOddsSeedAttempts();
    const { world, deps, read } = makeWorld({ claim: false });
    await readSnapshotOrSeed<Game, Game[]>({ sportKey: MLB, fetchDate: DAY, read, fromSeeded: (g) => g, empty: [], deps });
    const readsBefore = world.reads;
    await readSnapshotOrSeed<Game, Game[]>({ sportKey: MLB, fetchDate: "2026-10-08", read, fromSeeded: (g) => g, empty: [], deps });
    expect("8 next day is not shadowed by yesterday's negative verdict", world.reads - readsBefore, 1);
  }

  // 9. Only the missing-row error is handled.
  {
    __clearOddsSeedAttempts();
    const { world, deps } = makeWorld();
    let threw = "";
    try {
      await readSnapshotOrSeed<Game, Game[]>({
        sportKey: MLB,
        fetchDate: DAY,
        read: async () => {
          throw new Error("connection reset");
        },
        fromSeeded: (g) => g,
        empty: [],
        deps,
      });
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    expect("9 other read errors are rethrown", threw, "connection reset");
    expect("9 other read errors never claim or seed", [world.claims, world.seeds], [0, 0]);
    expect("9 isOddsSnapshotMissing matches by name", isOddsSnapshotMissing(new OddsSnapshotMissingError(MLB, DAY)), true);
    expect("9 isOddsSnapshotMissing rejects other errors", isOddsSnapshotMissing(new Error("x")), false);
  }

  // 10. Source inspection: neither cached read in odds.ts can reach the fetch.
  {
    const src = readFileSync("src/server/data/odds.ts", "utf8");
    const tickerBody = src.slice(src.indexOf("async function getTickerOddsUncached"), src.indexOf("export async function getTickerOddsForSport"));
    expect("10 ticker cached read no longer calls the fetch path", tickerBody.includes("getOddsForSportUncached("), false);
    expect("10 ticker cached read throws for a missing row", tickerBody.includes("throw new OddsSnapshotMissingError"), true);
    const fullBody = src.slice(src.indexOf("export async function getOddsForSport("), src.indexOf("async function claimOddsSeedViaDataCache"));
    expect("10 full cached read runs with fetchIfMissing: false", fullBody.includes("getOddsForSportUncached(sportKey, { fetchIfMissing: false })"), true);
    const uncached = src.slice(src.indexOf("async function getOddsForSportUncached("));
    const guard = uncached.indexOf("if (!fetchIfMissing) throw new OddsSnapshotMissingError");
    const fetchCall = uncached.indexOf("fetchMergedOddsListing(");
    expect("10 the missing-row guard sits before the Odds API fetch", guard > 0 && guard < fetchCall, true);
    const seedFn = src.slice(src.indexOf("export async function seedOddsSnapshot("), src.indexOf("const BULK_MARKET_KEYS"));
    expect("10 the cron seed still calls the full fetch path directly", seedFn.includes("await getOddsForSportUncached(sportKey)"), true);
  }

  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nAll passed");
}

main();
