// The import's freshness path (server/data/fresh-odds.ts): when it buys, what it never touches, and that every shortfall
// falls back to the snapshot. Pure - the loader's I/O is injected, no database or network.
//   npx tsx src/server/data/fresh-odds-acceptance-test.ts
import {
  FRESH_CALL_CREDITS,
  FRESH_CLAIM_EXPIRY_MS,
  FRESH_DAILY_CREDIT_CAP,
  FRESH_WINDOW_MS,
  buyFreshWith,
  claimExpired,
  createPricingOddsLoader,
  freshBucket,
  freshPurchaseAllowed,
  mergeFreshOverSnapshot,
  shouldFetchFresh,
  type BuyFreshDeps,
  type FreshListing,
  type FreshOddsDeps,
} from "@/server/data/fresh-odds";
import type { OddsGame } from "@/server/data/odds";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

const NOW = new Date("2026-11-03T22:00:00Z");
const HOUR = 3600_000;
const game = (id: string, startsInH: number, price: number): OddsGame => ({
  id,
  sportKey: "basketball_nba",
  homeTeam: "H" + id,
  awayTeam: "A" + id,
  commenceTime: new Date(NOW.getTime() + startsInH * HOUR).toISOString(),
  bookmakers: [{ key: "fanduel", title: "FanDuel", markets: [{ key: "h2h", outcomes: [{ name: "H" + id, price }] }] }] as unknown as OddsGame["bookmakers"],
});

async function main() {
// --- the decision -----------------------------------------------------------
const snapGames = [game("a", 2, -150), game("b", 3, +120)];
const seededAt = new Date(NOW.getTime() - 17 * HOUR);
check("a 17h-old snapshot with upcoming games: buy", shouldFetchFresh({ snapshotAt: seededAt, snapshotGames: snapGames, now: NOW }), true);
check("a snapshot under the window: use it", shouldFetchFresh({ snapshotAt: new Date(NOW.getTime() - FRESH_WINDOW_MS + 1), snapshotGames: snapGames, now: NOW }), false);
check("a snapshot exactly at the window: buy", shouldFetchFresh({ snapshotAt: new Date(NOW.getTime() - FRESH_WINDOW_MS), snapshotGames: snapGames, now: NOW }), true);
check("no snapshot row: nothing to refresh", shouldFetchFresh({ snapshotAt: null, snapshotGames: snapGames, now: NOW }), false);
check("every cached game already started: nothing to buy", shouldFetchFresh({ snapshotAt: seededAt, snapshotGames: [game("x", -1, -110)], now: NOW }), false);
check("an empty snapshot: nothing to buy", shouldFetchFresh({ snapshotAt: seededAt, snapshotGames: [], now: NOW }), false);

// --- the merge --------------------------------------------------------------
const freshAt = new Date(NOW.getTime() - 60_000);
const fresh: FreshListing = { games: [game("a", 2, -165), game("c", 5, +200)], fetchedAt: freshAt };
const snapshotBefore = JSON.stringify(snapGames);
const merged = mergeFreshOverSnapshot(snapGames, seededAt, fresh);
check("the snapshot input is not changed by a merge", JSON.stringify(snapGames), snapshotBefore);
check("merge: ids, snapshot-only first then fresh", merged.games.map((g) => g.id), ["b", "a", "c"]);
check("merge: a game in the fresh listing is priced from it", merged.games.find((g) => g.id === "a")!.bookmakers[0].markets[0].outcomes[0].price, -165);
check("merge: a game only the snapshot has keeps its snapshot price", merged.games.find((g) => g.id === "b")!.bookmakers[0].markets[0].outcomes[0].price, 120);
check(
  "merge: each game is stamped with the data that priced it",
  ["a", "b", "c"].map((id) => merged.capturedAt.get(id)?.toISOString()),
  [freshAt.toISOString(), seededAt.toISOString(), freshAt.toISOString()]
);
check("merge with no fresh listing: the snapshot as-is, stamped with its time", [mergeFreshOverSnapshot(snapGames, seededAt, null).games === snapGames, mergeFreshOverSnapshot(snapGames, seededAt, null).capturedAt.get("a")?.toISOString()], [true, seededAt.toISOString()]);

// --- purchase gates ---------------------------------------------------------
check("below 95% and under the cap: allowed", freshPurchaseAllowed({ level: "alert", callsToday: 0 }), true);
check("at 95%+: not allowed", freshPurchaseAllowed({ level: "stop_lower_priority", callsToday: 0 }), false);
const callsAtCap = FRESH_DAILY_CREDIT_CAP / FRESH_CALL_CREDITS;
check("the call that would pass the daily cap is refused", [freshPurchaseAllowed({ level: "ok", callsToday: callsAtCap - 1 }), freshPurchaseAllowed({ level: "ok", callsToday: callsAtCap })], [true, false]);
check("the cap is 60 credits = 20 calls", [FRESH_DAILY_CREDIT_CAP, callsAtCap], [60, 20]);
check("the claim bucket is stable within a window and moves across it", [freshBucket(new Date(0)) === freshBucket(new Date(FRESH_WINDOW_MS - 1)), freshBucket(new Date(FRESH_WINDOW_MS)) - freshBucket(new Date(0))], [true, 1]);

// --- the loader -------------------------------------------------------------
function deps(over: Partial<FreshOddsDeps> & { calls?: Record<string, number> } = {}): { d: FreshOddsDeps; calls: Record<string, number> } {
  const calls = over.calls ?? { snap: 0, read: 0, buy: 0 };
  const d: FreshOddsDeps = {
    now: () => NOW,
    readSnapshotAt: async () => {
      calls.snap++;
      return seededAt;
    },
    readFresh: async () => {
      calls.read++;
      return null;
    },
    buyFresh: async () => {
      calls.buy++;
      return fresh;
    },
    ...over,
  };
  return { d, calls };
}
const snapshotLoader = async () => snapGames;

{
  const { d, calls } = deps();
  const l = createPricingOddsLoader(snapshotLoader, d);
  const games = await l.load("basketball_nba");
  await l.load("basketball_nba");
  check("stale snapshot: priced from the fresh listing", games.map((g) => g.id), ["b", "a", "c"]);
  check("...bought once for a sport, however many lines ask", calls, { snap: 1, read: 1, buy: 1 });
  check("...a fresh game's time is the fetch", l.capturedAt("basketball_nba", "a")?.toISOString(), freshAt.toISOString());
  check("...a snapshot-only game's time is the snapshot's", l.capturedAt("basketball_nba", "b")?.toISOString(), seededAt.toISOString());
  check("...an unknown event has no time", l.capturedAt("basketball_nba", "zzz"), null);
}
{
  const { d, calls } = deps({ readSnapshotAt: async () => new Date(NOW.getTime() - 30 * 60_000) });
  const l = createPricingOddsLoader(snapshotLoader, d);
  const games = await l.load("basketball_nba");
  check("a fresh-enough snapshot: no read of the fresh table, no purchase", [games === snapGames, calls.read, calls.buy], [true, 0, 0]);
}
{
  const { d, calls } = deps({ readFresh: async () => fresh });
  const l = createPricingOddsLoader(snapshotLoader, d);
  await l.load("basketball_nba");
  check("a stored listing inside the window is reused: no purchase", calls.buy, 0);
}
{
  const { d } = deps({ buyFresh: async () => null });
  const l = createPricingOddsLoader(snapshotLoader, d);
  const games = await l.load("basketball_nba");
  check("gate / cap / lost claim: the snapshot, stamped with its own time", [games === snapGames, l.capturedAt("basketball_nba", "a")?.toISOString()], [true, seededAt.toISOString()]);
}
{
  const { d } = deps({
    buyFresh: async () => {
      throw new Error("api down");
    },
  });
  const l = createPricingOddsLoader(snapshotLoader, d);
  const games = await l.load("basketball_nba");
  check("a purchase that throws never fails the import: the snapshot", games === snapGames, true);
}
{
  const { d } = deps({
    readSnapshotAt: async () => {
      throw new Error("db blip");
    },
  });
  const l = createPricingOddsLoader(snapshotLoader, d);
  const games = await l.load("basketball_nba");
  check("an unreadable snapshot time: the snapshot, no time, no purchase", [games === snapGames, l.capturedAt("basketball_nba", "a")], [true, null]);
  check("...snapshotAt reports null", await l.snapshotAt("basketball_nba"), null);
}
{
  const { d, calls } = deps();
  const l = createPricingOddsLoader(snapshotLoader, d);
  const at = await l.snapshotAt("basketball_nba");
  check("snapshotAt alone never buys or reads the fresh table", [at?.toISOString(), calls.read, calls.buy], [seededAt.toISOString(), 0, 0]);
}

// --- stuck claims: expiry and takeover ---------------------------------------
const MIN = 60_000;
check("a claim is 5 minutes", FRESH_CLAIM_EXPIRY_MS, 5 * MIN);
check(
  "claimExpired: under 5 min is live, at 5 min is expired, a completed claim never is",
  [
    claimExpired({ createdAt: new Date(NOW.getTime() - 4 * MIN - 59_000), fetchedAt: null }, NOW),
    claimExpired({ createdAt: new Date(NOW.getTime() - 5 * MIN), fetchedAt: null }, NOW),
    claimExpired({ createdAt: new Date(NOW.getTime() - 60 * MIN), fetchedAt: new Date(NOW.getTime() - 59 * MIN) }, NOW),
  ],
  [false, true, false]
);

type Claim = { id: string; createdAt: Date; fetchedAt: Date | null } | null;
function buyRig(over: Partial<BuyFreshDeps> & { existing?: Claim } = {}) {
  const log: string[] = [];
  const { existing = null, ...rest } = over;
  const deps: BuyFreshDeps = {
    apiKey: "key",
    inSeason: () => true,
    creditLevel: async () => "ok",
    callsToday: async () => 0,
    createClaim: async () => {
      log.push("create");
      return existing ? null : "new-claim";
    },
    readClaim: async () => {
      log.push("read");
      return existing;
    },
    retakeClaim: async (id, expiredBefore) => {
      log.push("retake:" + id + ":" + (expiredBefore.getTime() === NOW.getTime() - FRESH_CLAIM_EXPIRY_MS));
      return true;
    },
    releaseClaim: async (id) => {
      log.push("release:" + id);
    },
    fetchListing: async () => {
      log.push("fetch");
      return fresh;
    },
    store: async (id) => {
      log.push("store:" + id);
    },
    ...rest,
  };
  return { deps, log };
}
const stuck = (ageMin: number): Claim => ({ id: "stuck", createdAt: new Date(NOW.getTime() - ageMin * MIN), fetchedAt: null });

{
  const { deps, log } = buyRig();
  const got = await buyFreshWith(deps, "basketball_nba", NOW);
  check("no claim yet: create, fetch, store", [got === fresh, log], [true, ["create", "fetch", "store:new-claim"]]);
}
{
  const { deps, log } = buyRig({ existing: stuck(2) });
  const got = await buyFreshWith(deps, "basketball_nba", NOW);
  check("a live claim (2 min old): no takeover, no fetch", [got, log], [null, ["create", "read"]]);
}
{
  const { deps, log } = buyRig({ existing: stuck(6) });
  const got = await buyFreshWith(deps, "basketball_nba", NOW);
  check("an expired claim (6 min old): taken over by id, then fetched and stored on it", [got === fresh, log], [true, ["create", "read", "retake:stuck:true", "fetch", "store:stuck"]]);
}
{
  const { deps, log } = buyRig({ existing: stuck(5) });
  const got = await buyFreshWith(deps, "basketball_nba", NOW);
  check("a claim exactly 5 min old is expired", [got === fresh, log.includes("fetch")], [true, true]);
}
{
  const { deps, log } = buyRig({ existing: stuck(6), retakeClaim: async () => false });
  const got = await buyFreshWith(deps, "basketball_nba", NOW);
  check("an expired claim another instance took first: no fetch", [got, log.includes("fetch")], [null, false]);
}
{
  const done: Claim = { id: "done", createdAt: new Date(NOW.getTime() - 90 * MIN), fetchedAt: new Date(NOW.getTime() - 89 * MIN) };
  const { deps, log } = buyRig({ existing: done });
  const got = await buyFreshWith(deps, "basketball_nba", NOW);
  check("a completed claim is never taken over, however old", [got, log.includes("retake:done:true"), log.includes("fetch")], [null, false, false]);
}
{
  const { deps, log } = buyRig({ existing: stuck(10), callsToday: async () => callsAtCap });
  const got = await buyFreshWith(deps, "basketball_nba", NOW);
  check("an expired claim still respects the 60-credit daily cap: nothing claimed or fetched", [got, log], [null, []]);
}
{
  const { deps, log } = buyRig({ existing: stuck(10), creditLevel: async () => "stop_lower_priority" });
  const got = await buyFreshWith(deps, "basketball_nba", NOW);
  check("an expired claim still respects the 95% gate: nothing claimed or fetched", [got, log], [null, []]);
}
{
  const { deps, log } = buyRig({ existing: stuck(10), callsToday: async () => callsAtCap - 1 });
  const got = await buyFreshWith(deps, "basketball_nba", NOW);
  check("one call under the cap: the takeover goes ahead", [got === fresh, log.includes("fetch")], [true, true]);
}
{
  const { deps, log } = buyRig({ existing: stuck(6), fetchListing: async () => null });
  const got = await buyFreshWith(deps, "basketball_nba", NOW);
  check("a takeover whose API call fails releases the claim by id", [got, log.slice(-1)], [null, ["release:stuck"]]);
}
{
  const { deps, log } = buyRig({
    fetchListing: async () => {
      throw new Error("boom");
    },
  });
  let threw = false;
  try {
    await buyFreshWith(deps, "basketball_nba", NOW);
  } catch {
    threw = true;
  }
  check("a fetch that throws releases the claim and rethrows", [threw, log.slice(-1)], [true, ["release:new-claim"]]);
}
{
  const { deps, log } = buyRig({ apiKey: undefined });
  check("no API key: nothing claimed", [await buyFreshWith(deps, "basketball_nba", NOW), log], [null, []]);
}
{
  const { deps, log } = buyRig({ inSeason: () => false });
  check("out of season: nothing claimed", [await buyFreshWith(deps, "basketball_wnba", NOW), log], [null, []]);
}

}

main().then(() => {
  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nall passed");
});
