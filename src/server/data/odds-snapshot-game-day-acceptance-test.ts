// Proof that a pick entered after Eastern midnight on a game that tipped before it is priced from that game's own
// day's odds snapshot, and that nothing else about snapshot selection changed.
//
// The bug (2026-11-11): Matt Severance "thunder moneyline", Thunder @ Trail Blazers, tip 04:00Z (11:00 pm ET on
// 11-10), imported 06:06Z (1:06 am ET on 11-11). getOddsForSport read the snapshot for easternDateKey(now) =
// "2026-11-11", written 05:00Z with 12 NBA games and not this one (every snapshot write keeps only games that have
// not started). The game is only in the "2026-11-10" row. So the pick was stored at -110, DEFAULTED/game_started,
// with no mlFavoredSide and so no category. 30-day prod check: every cross-midnight pick defaulted, none priced -
// 1 live cross-midnight pick (this one) and 5 next-day imports (capper posted pregame, imported 20-25 h after tip,
// game already final). All of them are priced from their game day's row now.
//
// The fix (odds.ts pastSnapshotDateFor + resolveOddsGame): read the row for min(game's ET day, today's ET day).
//
// Pinned here:
//   1. pastSnapshotDateFor: a past-ET-day game gets its own day; a game today (started or not) or later gets
//      undefined = today's row, as before; EDT and EST boundaries.
//   2. the Thunder pick, through the real findMarketPricePoint / findFavoredSide / pickCategory / posted-odds code,
//      with the real event from the prod 2026-11-10 snapshot: priced from the market (-124, FanDuel - that row's
//      first book; the -134 other cappers got came from a 20:14Z fresh listing, which this PR does not use for a
//      started game), favored side AWAY, category FAV_ML, oddsCapturedAt = that row's createdAt, no fresh listing
//      read or bought, and a same-teams game in today's row is never matched instead.
//   3. a future game still reads today's row (the loader is called with no date), and the request loader still
//      reads today's row once however many lookups ask.
//   4. a missing previous-day row: [] (not cached), so the pick stays DEFAULTED / game_started with no category, and
//      the past-day read has no seed path at all (structural check on the source).
//
// No DB, no network. Run with:
//   npx tsx src/server/data/odds-snapshot-game-day-acceptance-test.ts
// Exits non-zero on any failed assertion.
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  createRequestOddsLoader,
  findFavoredSide,
  findMarketPricePoint,
  getPastDayOddsForSport,
  pastSnapshotDateFor,
  resolveOddsGame,
  type OddsGame,
  type OddsLoader,
  type PastDayOddsDeps,
} from "./odds";
import { createPricingOddsLoader, type FreshOddsDeps } from "./fresh-odds";
import { pickCategory } from "./stats";
import { postedOddsCapture, resolvePickPrice, unpricedReasonFor } from "@/lib/odds-source";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!pass) failures++;
}

const NBA = "basketball_nba";
const FULL = "FULL_GAME";

// The real event from the prod basketball_nba 2026-11-10 snapshot (row createdAt 2026-11-10 05:00:01.983Z), first
// three of its ten books, unchanged.
const NOV10_ROW_CREATED_AT = new Date("2026-11-10T05:00:01.983Z");
const THUNDER_EVENT: OddsGame = {
  id: "f5477c781c94e09e85374bbf9149c0f1",
  sportKey: NBA,
  homeTeam: "Portland Trail Blazers",
  awayTeam: "Oklahoma City Thunder",
  commenceTime: "2026-11-11T04:10:00Z",
  bookmakers: [
    {
      key: "fanduel",
      title: "FanDuel",
      markets: [
        { key: "h2h", outcomes: [{ name: "Oklahoma City Thunder", price: -124 }, { name: "Portland Trail Blazers", price: 106 }] },
        { key: "spreads", outcomes: [{ name: "Oklahoma City Thunder", point: -1.5, price: -114 }, { name: "Portland Trail Blazers", point: 1.5, price: -106 }] },
        { key: "totals", outcomes: [{ name: "Over", point: 225.5, price: -118 }, { name: "Under", point: 225.5, price: -104 }] },
      ],
    },
    {
      key: "betonlineag",
      title: "BetOnline.ag",
      markets: [
        { key: "h2h", outcomes: [{ name: "Oklahoma City Thunder", price: -130 }, { name: "Portland Trail Blazers", price: 110 }] },
        { key: "spreads", outcomes: [{ name: "Oklahoma City Thunder", point: -2, price: -110 }, { name: "Portland Trail Blazers", point: 2, price: -110 }] },
        { key: "totals", outcomes: [{ name: "Over", point: 227, price: -115 }, { name: "Under", point: 227, price: -105 }] },
      ],
    },
    {
      key: "williamhill_us",
      title: "Caesars",
      markets: [
        { key: "h2h", outcomes: [{ name: "Oklahoma City Thunder", price: -130 }, { name: "Portland Trail Blazers", price: 110 }] },
        { key: "spreads", outcomes: [{ name: "Oklahoma City Thunder", point: -2, price: -110 }, { name: "Portland Trail Blazers", point: 2, price: -110 }] },
        { key: "totals", outcomes: [{ name: "Over", point: 226.5, price: -110 }, { name: "Under", point: 226.5, price: -110 }] },
      ],
    },
  ],
} as unknown as OddsGame;

// What the import holds for the pick: the score feed's game (ESPN start time, 10 minutes before the odds listing).
const THUNDER_PICK_GAME = { homeTeam: "Portland Trail Blazers", awayTeam: "Oklahoma City Thunder", commenceTime: "2026-11-11T04:00:00Z" };

// A same-teams game sitting in today's row, priced very differently. Old-style "read today's row" matching would
// have nothing else for these teams; the past-day pick must never land on it.
const DECOY_FUTURE_REMATCH: OddsGame = {
  id: "decoy-thunder-blazers-rematch",
  sportKey: NBA,
  homeTeam: "Portland Trail Blazers",
  awayTeam: "Oklahoma City Thunder",
  commenceTime: new Date(Date.now() + 2 * 86400000).toISOString(),
  bookmakers: [{ key: "fanduel", title: "FanDuel", markets: [{ key: "h2h", outcomes: [{ name: "Oklahoma City Thunder", price: -400 }, { name: "Portland Trail Blazers", price: 300 }] }] }],
} as unknown as OddsGame;

// A loader serving one row per ET day, recording every call's arguments.
function dayLoader(rows: { today: OddsGame[]; byPastDay: Record<string, OddsGame[]> }) {
  const calls: Array<{ sportKey: string; pastFetchDate: string | undefined; argc: number }> = [];
  const load: OddsLoader = async (...args: [string, string?]) => {
    const [sportKey, pastFetchDate] = args;
    calls.push({ sportKey, pastFetchDate, argc: args.length });
    if (pastFetchDate === undefined) return rows.today.filter((g) => g.sportKey === sportKey);
    return (rows.byPastDay[pastFetchDate] ?? []).filter((g) => g.sportKey === sportKey);
  };
  return { load, calls };
}

function freshDeps(snapshotAtByDay: Record<string, Date>, todaySnapshotAt: Date) {
  const calls = { readSnapshotAt: [] as Array<[string, string | undefined]>, readFresh: 0, buyFresh: 0 };
  const deps: FreshOddsDeps = {
    now: () => new Date(),
    readSnapshotAt: async (sportKey, pastFetchDate) => {
      calls.readSnapshotAt.push([sportKey, pastFetchDate]);
      return pastFetchDate === undefined ? todaySnapshotAt : snapshotAtByDay[pastFetchDate] ?? null;
    },
    readFresh: async () => {
      calls.readFresh++;
      return null;
    },
    buyFresh: async () => {
      calls.buyFresh++;
      return null;
    },
  };
  return { deps, calls };
}

async function main() {
  // ---- 1. pastSnapshotDateFor ----------------------------------------------------------------------------------
  const at = (iso: string) => new Date(iso);
  expect("Thunder tip 04:00Z, import 06:06Z (1:06 am ET 11-11): the 11-10 row", pastSnapshotDateFor("2026-11-11T04:00:00Z", at("2026-11-11T06:06:47Z")), "2026-11-10");
  expect("same game imported pregame at 03:50Z (10:50 pm ET 11-10): today's row (undefined)", pastSnapshotDateFor("2026-11-11T04:00:00Z", at("2026-11-11T03:50:00Z")), undefined);
  expect("same game imported live at 04:40Z, still 11-10 ET: today's row, as before", pastSnapshotDateFor("2026-11-11T04:00:00Z", at("2026-11-11T04:40:00Z")), undefined);
  expect("a game today that already started (1 pm ET tip, 3 pm ET import): today's row", pastSnapshotDateFor("2026-11-11T18:00:00Z", at("2026-11-11T20:00:00Z")), undefined);
  expect("a game two days ahead: today's row (its own day's row does not exist yet)", pastSnapshotDateFor("2026-11-13T00:00:00Z", at("2026-11-11T06:06:47Z")), undefined);
  expect("EDT: 11:30 pm ET tip (03:30Z), import 00:30 am ET (04:30Z): the earlier day", pastSnapshotDateFor("2026-07-01T03:30:00Z", at("2026-07-01T04:30:00Z")), "2026-06-30");
  expect("EDT: 00:30 am ET tip (04:30Z) is that same new day: today's row", pastSnapshotDateFor("2026-07-01T04:30:00Z", at("2026-07-01T05:00:00Z")), undefined);
  expect("a game two days back: its own day's row", pastSnapshotDateFor("2026-11-09T00:00:00Z", at("2026-11-11T06:06:47Z")), "2026-11-08");
  expect("an unreadable start time: today's row (no guess)", pastSnapshotDateFor("not a date", at("2026-11-11T06:06:47Z")), undefined);

  // ---- 2. the Thunder pick, priced from its game day's row -----------------------------------------------------
  // Today's row as prod had it at 06:06Z: no Thunder game from last night, plus (here) a same-teams decoy later on.
  const prod = dayLoader({ today: [DECOY_FUTURE_REMATCH], byPastDay: { "2026-11-10": [THUNDER_EVENT] } });
  const request = createRequestOddsLoader(prod.load);
  const fresh = freshDeps({ "2026-11-10": NOV10_ROW_CREATED_AT }, new Date("2026-11-11T05:00:01.854Z"));
  const pricing = createPricingOddsLoader(request, fresh.deps);

  expect("today's row really has no event for last night's game (why it was -110)", (await request(NBA)).some((g) => g.id === THUNDER_EVENT.id), false);

  const resolved = await resolveOddsGame(NBA, THUNDER_PICK_GAME, request);
  expect("resolves to the 11-10 row's event, not today's same-teams rematch", resolved?.id, THUNDER_EVENT.id);

  const point = await findMarketPricePoint(NBA, THUNDER_PICK_GAME, "MONEYLINE", "away", { line: null, period: FULL }, pricing.load);
  expect("thunder moneyline: priced from the market at -124 (FanDuel, the row's first book)", point, { price: -124, book: "fanduel", eventId: THUNDER_EVENT.id });

  const mlFavoredSide = await findFavoredSide(NBA, THUNDER_PICK_GAME, request);
  expect("favored side from the h2h market: AWAY (the Thunder)", mlFavoredSide, "AWAY");

  const price = resolvePickPrice({ odds: -110, hasExplicitOdds: false }, point?.price ?? null);
  expect("stored price and source: -124 MARKET (was -110 DEFAULTED)", price, { odds: -124, oddsSource: "MARKET" });

  const category = pickCategory({
    betType: "MONEYLINE",
    period: FULL,
    betDetail: "thunder moneyline",
    odds: price.odds,
    line: null,
    sportName: "NBA",
    pickedSide: "AWAY",
    mlFavoredSide,
    oddsSource: price.oddsSource,
  });
  expect("category FAV_ML (was null)", category, "FAV_ML");

  const capturedAt = pricing.capturedAt(NBA, THUNDER_EVENT.id);
  expect("capturedAt = the 11-10 row's createdAt", capturedAt?.toISOString(), NOV10_ROW_CREATED_AT.toISOString());
  const posted = postedOddsCapture({ oddsSource: price.oddsSource, importedAt: new Date("2026-11-11T06:06:47.680Z"), line: null, priced: { capturedAt, book: point?.book ?? null }, unpricedReason: null });
  expect("posted capture: oddsCapturedAt is the 11-10 snapshot time, book fanduel, no null reason", { at: posted.oddsCapturedAt?.toISOString(), book: posted.oddsBook, reason: posted.oddsNullReason }, { at: NOV10_ROW_CREATED_AT.toISOString(), book: "fanduel", reason: null });
  expect("snapshotAt for the past day (the alt-line / prop stamp) is that same row's time", (await pricing.snapshotAt(NBA, "2026-11-10"))?.toISOString(), NOV10_ROW_CREATED_AT.toISOString());
  expect("the past-day pricing read asked for the 11-10 row's time, by date", fresh.calls.readSnapshotAt, [[NBA, "2026-11-10"]]);
  expect("no fresh listing read or bought for a started game's past day", { readFresh: fresh.calls.readFresh, buyFresh: fresh.calls.buyFresh }, { readFresh: 0, buyFresh: 0 });

  // Every price path asked the loader for the 11-10 row, once each per (sport, day), however many lookups ran.
  await findFavoredSide(NBA, THUNDER_PICK_GAME, request);
  await findMarketPricePoint(NBA, THUNDER_PICK_GAME, "SPREAD", "away", { line: -1.5, period: FULL }, pricing.load);
  expect(
    "underlying loader reads: today's row once (no date) + the 11-10 row once",
    prod.calls.map((c) => [c.pastFetchDate ?? "today", c.argc]),
    [["today", 1], ["2026-11-10", 2]]
  );
  expect("Thunder -1.5 off the same row: -114 (exact-line rule unchanged)", (await findMarketPricePoint(NBA, THUNDER_PICK_GAME, "SPREAD", "away", { line: -1.5, period: FULL }, pricing.load))?.price, -114);
  expect("Thunder -3.5 (not hung there): still no price, never a neighbour's", await findMarketPricePoint(NBA, THUNDER_PICK_GAME, "SPREAD", "away", { line: -3.5, period: FULL }, pricing.load), null);

  // ---- 3. a game today or later still reads today's row, exactly as before -------------------------------------
  const future = dayLoader({ today: [DECOY_FUTURE_REMATCH], byPastDay: { "2026-11-10": [THUNDER_EVENT] } });
  const futureGame = { homeTeam: "Portland Trail Blazers", awayTeam: "Oklahoma City Thunder", commenceTime: DECOY_FUTURE_REMATCH.commenceTime };
  expect("future game resolves from today's row", (await resolveOddsGame(NBA, futureGame, future.load))?.id, DECOY_FUTURE_REMATCH.id);
  expect("future game: the loader is called with the sport only (no date argument at all)", future.calls.map((c) => c.argc), [1]);
  const futurePricing = createPricingOddsLoader(createRequestOddsLoader(future.load), freshDeps({}, new Date(Date.now() - 30 * 60_000)).deps);
  expect("future game price comes from today's row", (await findMarketPricePoint(NBA, futureGame, "MONEYLINE", "away", { line: null, period: FULL }, futurePricing.load))?.price, -400);
  expect("loader never asked for a past day for a future game", future.calls.every((c) => c.pastFetchDate === undefined), true);

  let todayReads = 0;
  const countingRequest = createRequestOddsLoader(async () => {
    todayReads++;
    return [DECOY_FUTURE_REMATCH];
  });
  await Promise.all([countingRequest(NBA), countingRequest(NBA), resolveOddsGame(NBA, futureGame, countingRequest), findFavoredSide(NBA, futureGame, countingRequest)]);
  expect("request loader: today's row read once for any number of today-row lookups", todayReads, 1);

  // ---- 4. a missing previous-day row -------------------------------------------------------------------------
  const cachedCalls: Array<{ key: string; ttl: number; tags: string[] }> = [];
  let rowReads = 0;
  const missingDeps: PastDayOddsDeps = {
    readRow: async () => {
      rowReads++;
      return null;
    },
    cached: async (key, ttl, fn, tags) => {
      cachedCalls.push({ key, ttl, tags });
      return fn();
    },
  };
  expect("missing previous-day row: [] (not an error)", await getPastDayOddsForSport(NBA, "2026-11-10", missingDeps), []);
  expect("read under its own key, tagged with the day's odds tag (write paths invalidate it)", cachedCalls[0] && { key: cachedCalls[0].key, tags: cachedCalls[0].tags }, { key: "past-day-odds:basketball_nba:2026-11-10", tags: ["odds:basketball_nba:2026-11-10"] });
  expect("one row read for it", rowReads, 1);

  let missedFromCache = false;
  await getPastDayOddsForSport(NBA, "2026-11-10", {
    readRow: async () => null,
    cached: async (_key, _ttl, fn) => {
      try {
        return await fn();
      } catch (err) {
        missedFromCache = true; // the miss reaches the cache as a rejection, which unstable_cache never stores
        throw err;
      }
    },
  });
  expect("the miss is a rejection inside the cached read, so it is never stored", missedFromCache, true);

  let dbErrorSurfaced = false;
  try {
    await getPastDayOddsForSport(NBA, "2026-11-10", { readRow: async () => Promise.reject(new Error("db down")), cached: async (_k, _t, fn) => fn() });
  } catch {
    dbErrorSurfaced = true;
  }
  expect("a real read error is not swallowed as 'no row'", dbErrorSurfaced, true);

  const missingLoader: OddsLoader = (sportKey, pastFetchDate) =>
    pastFetchDate === undefined ? Promise.resolve([]) : getPastDayOddsForSport(sportKey, pastFetchDate, missingDeps);
  const missingPricing = createPricingOddsLoader(createRequestOddsLoader(missingLoader), freshDeps({}, new Date("2026-11-11T05:00:01.854Z")).deps);
  const noPoint = await findMarketPricePoint(NBA, THUNDER_PICK_GAME, "MONEYLINE", "away", { line: null, period: FULL }, missingPricing.load);
  const noSide = await findFavoredSide(NBA, THUNDER_PICK_GAME, missingLoader);
  const defaulted = resolvePickPrice({ odds: -110, hasExplicitOdds: false }, noPoint?.price ?? null);
  expect("no row: no price, no favored side", { noPoint, noSide }, { noPoint: null, noSide: null });
  expect("no row: stored -110 DEFAULTED, as before", defaulted, { odds: -110, oddsSource: "DEFAULTED" });
  expect("no row: null reason game_started, as before", unpricedReasonFor({ betType: "MONEYLINE", gameTime: new Date(THUNDER_PICK_GAME.commenceTime), importedAt: new Date("2026-11-11T06:06:47.680Z") }), "game_started");
  expect(
    "no row: category stays null",
    pickCategory({ betType: "MONEYLINE", period: FULL, betDetail: "thunder moneyline", odds: -110, line: null, sportName: "NBA", pickedSide: "AWAY", mlFavoredSide: noSide, oddsSource: "DEFAULTED" }),
    null
  );

  // No seed path: the past-day read never reaches the seed claim, the Odds API or any write.
  const src = readFileSync(path.join(__dirname, "odds.ts"), "utf8").replace(/\r\n/g, "\n");
  const pastStart = src.indexOf("export async function getPastDayOddsForSport(");
  const pastBody = src.slice(pastStart, src.indexOf("\n}\n", pastStart));
  const depsStart = src.indexOf("const pastDayOddsDeps: PastDayOddsDeps = {");
  const depsBody = src.slice(depsStart, src.indexOf("\n};", depsStart));
  expect("found both source blocks", pastStart > 0 && depsStart > 0 && pastBody.length > 100 && depsBody.length > 100, true);
  const forbidden = ["readSnapshotOrSeed", "getOddsForSportUncached", "oddsSeedDeps", "fetchMergedOddsListing", "fetch(", ".create(", ".upsert(", ".update(", "$executeRaw"];
  expect("getPastDayOddsForSport body: no seed / fetch / write", forbidden.filter((f) => pastBody.includes(f)), []);
  expect("its default deps: one findUnique, no seed / fetch / write", { findUnique: depsBody.includes("oddsSnapshot.findUnique("), bad: forbidden.filter((f) => depsBody.includes(f)) }, { findUnique: true, bad: [] });
  const getOdds = src.slice(src.indexOf("export async function getOddsForSport("));
  expect(
    "getOddsForSport hands a past date to the read-only path before the seed-capable read",
    getOdds.indexOf("return getPastDayOddsForSport(sportKey, pastFetchDate)") > 0 && getOdds.indexOf("return getPastDayOddsForSport(sportKey, pastFetchDate)") < getOdds.indexOf("readSnapshotOrSeed"),
    true
  );

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll odds-snapshot game-day checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
