// Proof that a pick on a game that has already started is priced the way a pregame import just before tip would have
// been: from the newest retained fresh listing fetched before the game's start, when that listing is newer than the
// row the game is found in (today's snapshot, or its game day's snapshot since #445), and otherwise exactly as before.
//
// The case (2026-11-11): Thunder @ Trail Blazers, odds start 04:10Z. Imported live at 06:06Z after ET midnight.
// #445 priced it from the 2026-11-10 snapshot (written 05:00:01Z that morning): FanDuel -124. The last listing this
// app read before tip was the 03:12:21Z fresh listing: FanDuel -126 - the price a 03:50Z pregame import would have
// stored. Prod sizing (11-03..11-11): 86 of 87 post-tip imports had such a listing retained; 81 within 2 h of tip.
//
// Pinned here:
//   1. preferPreTipListing: started + fetched before start + newer than the row = listing; anything else = the row.
//   2. the Thunder pick through the real findMarketPricePoint: -126 from the 03:12Z listing, oddsCapturedAt = that
//      listing's fetchedAt; one event read, never a purchase; plain load (other games) unchanged.
//   3. a same-day post-tip pick moves off the morning snapshot price to the pre-tip listing (the intended change).
//   4. fallbacks: no listing retained, a listing older than the row, a failing read, no read dependency at all -
//      every one prices from the row, as #445 does.
//   5. a game that has not started is untouched: forGame hands back load's games and reads nothing.
//   6. source checks: the default read selects one event (not a listing), LIMIT 1, by event id, pre-start only, and
//      the import prices through forGame.
//
// No DB, no network. Run with:
//   npx tsx src/server/data/odds-started-game-pretip-acceptance-test.ts
// Exits non-zero on any failed assertion.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequestOddsLoader, findMarketPricePoint, type OddsGame, type OddsLoader } from "./odds";
import { createPricingOddsLoader, preferPreTipListing, FRESH_RETAIN_MS, type FreshOddsDeps, type PreTipEvent } from "./fresh-odds";
import { postedOddsCapture } from "@/lib/odds-source";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!pass) failures++;
}

const NBA = "basketball_nba";
const FULL = "FULL_GAME";
const ML = { line: null, period: FULL } as const;

type Book = OddsGame["bookmakers"][number];
const h2h = (key: string, away: number, home: number): Book =>
  ({ key, title: key, markets: [{ key: "h2h", outcomes: [{ name: "Oklahoma City Thunder", price: away }, { name: "Portland Trail Blazers", price: home }] }] }) as unknown as Book;
const thunder = (commenceTime: string, books: Book[]): OddsGame =>
  ({ id: "f5477c781c94e09e85374bbf9149c0f1", sportKey: NBA, homeTeam: "Portland Trail Blazers", awayTeam: "Oklahoma City Thunder", commenceTime, bookmakers: books }) as unknown as OddsGame;

// Real prices: the 2026-11-10 snapshot row (FanDuel first, -124/+106) and the 2026-11-11 03:12:21.987Z fresh listing
// (FanDuel first, -126/+108), both from prod.
const ODDS_START = "2026-11-11T04:10:00Z";
const NOV10_ROW_AT = new Date("2026-11-10T05:00:01.983Z");
const LISTING_AT = new Date("2026-11-11T03:12:21.987Z");
const ROW_EVENT = thunder(ODDS_START, [h2h("fanduel", -124, 106), h2h("betonlineag", -130, 110)]);
const LISTING_EVENT = thunder(ODDS_START, [h2h("fanduel", -126, 108), h2h("betonlineag", -128, 108)]);
const PICK_GAME = { homeTeam: "Portland Trail Blazers", awayTeam: "Oklahoma City Thunder", commenceTime: "2026-11-11T04:00:00Z" };
const IMPORTED_AT = new Date("2026-11-11T06:06:47.680Z");

// Another game in the same rows, to show load() is untouched.
const OTHER = { id: "other-event", sportKey: NBA, homeTeam: "Phoenix Suns", awayTeam: "LA Clippers", commenceTime: "2026-11-11T02:10:00Z", bookmakers: [h2h("fanduel", 999, -999)] } as unknown as OddsGame;

function harness(opts: {
  now: Date;
  today?: OddsGame[];
  byPastDay?: Record<string, OddsGame[]>;
  snapshotAt: (pastFetchDate?: string) => Date | null;
  preTip?: ((sportKey: string, eventId: string, since: Date) => Promise<PreTipEvent | null>) | null;
}) {
  const calls = { preTip: [] as Array<[string, string, string]>, readFresh: 0, buyFresh: 0 };
  const rows: OddsLoader = async (sportKey, pastFetchDate) =>
    (pastFetchDate === undefined ? opts.today ?? [] : opts.byPastDay?.[pastFetchDate] ?? []).filter((g) => g.sportKey === sportKey);
  const deps: FreshOddsDeps = {
    now: () => opts.now,
    readSnapshotAt: async (_s, pastFetchDate) => opts.snapshotAt(pastFetchDate),
    readFresh: async () => {
      calls.readFresh++;
      return null;
    },
    buyFresh: async () => {
      calls.buyFresh++;
      return null;
    },
  };
  if (opts.preTip !== null) {
    const impl = opts.preTip ?? (async () => null);
    deps.readPreTipEvent = async (sportKey, eventId, since) => {
      calls.preTip.push([sportKey, eventId, since.toISOString()]);
      return impl(sportKey, eventId, since);
    };
  }
  const pricing = createPricingOddsLoader(createRequestOddsLoader(rows), deps);
  return { pricing, calls };
}

async function main() {
  // ---- 1. the pure decision -------------------------------------------------------------------------------------
  const now = IMPORTED_AT;
  const listing: PreTipEvent = { game: LISTING_EVENT, fetchedAt: LISTING_AT };
  expect("started, listing before start and newer than the row: the listing", preferPreTipListing({ event: ROW_EVENT, baseCapturedAt: NOV10_ROW_AT, listing, now }), true);
  expect("row time unknown: the listing", preferPreTipListing({ event: ROW_EVENT, baseCapturedAt: null, listing, now }), true);
  expect("no listing: the row", preferPreTipListing({ event: ROW_EVENT, baseCapturedAt: NOV10_ROW_AT, listing: null, now }), false);
  expect("not started yet: the row (pregame pricing is unchanged)", preferPreTipListing({ event: ROW_EVENT, baseCapturedAt: NOV10_ROW_AT, listing, now: new Date("2026-11-11T04:00:00Z") }), false);
  expect("listing fetched at/after start: never (it could not hold a pregame price)", preferPreTipListing({ event: ROW_EVENT, baseCapturedAt: NOV10_ROW_AT, listing: { game: LISTING_EVENT, fetchedAt: new Date(ODDS_START) }, now }), false);
  expect("listing older than the row: the row", preferPreTipListing({ event: ROW_EVENT, baseCapturedAt: new Date("2026-11-11T03:30:00Z"), listing, now }), false);
  expect("listing exactly as old as the row (same data): the row", preferPreTipListing({ event: ROW_EVENT, baseCapturedAt: LISTING_AT, listing, now }), false);

  // ---- 2. the Thunder pick, imported after ET midnight -----------------------------------------------------------
  {
    const { pricing, calls } = harness({
      now: IMPORTED_AT,
      today: [],
      byPastDay: { "2026-11-10": [ROW_EVENT, OTHER] },
      snapshotAt: (d) => (d === "2026-11-10" ? NOV10_ROW_AT : new Date("2026-11-11T05:00:01.854Z")),
      preTip: async (_s, eventId) => (eventId === ROW_EVENT.id ? listing : null),
    });
    const point = await findMarketPricePoint(NBA, PICK_GAME, "MONEYLINE", "away", ML, pricing.forGame(PICK_GAME));
    expect("Thunder ML: -126 FanDuel from the 03:12Z pre-tip listing (was -124 from the morning row)", point, { price: -126, book: "fanduel", eventId: ROW_EVENT.id });
    expect("Blazers ML off the same listing: +108", (await findMarketPricePoint(NBA, PICK_GAME, "MONEYLINE", "home", ML, pricing.forGame(PICK_GAME)))?.price, 108);
    const capturedAt = pricing.capturedAt(NBA, ROW_EVENT.id);
    expect("capturedAt = the listing's fetchedAt", capturedAt?.toISOString(), LISTING_AT.toISOString());
    const posted = postedOddsCapture({ oddsSource: "MARKET", importedAt: IMPORTED_AT, line: null, priced: { capturedAt, book: point?.book ?? null }, unpricedReason: null });
    expect("posted capture: oddsCapturedAt 03:12:21.987Z, book fanduel", { at: posted.oddsCapturedAt?.toISOString(), book: posted.oddsBook }, { at: LISTING_AT.toISOString(), book: "fanduel" });
    expect("one pre-tip read for the event, however many lookups, since = now - 24 h", calls.preTip, [[NBA, ROW_EVENT.id, new Date(IMPORTED_AT.getTime() - FRESH_RETAIN_MS).toISOString()]]);
    expect("never a purchase, never a whole-listing read", { buyFresh: calls.buyFresh, readFresh: calls.readFresh }, { buyFresh: 0, readFresh: 0 });
    const plain = await pricing.load(NBA, "2026-11-10");
    expect("plain load still hands back the row's own events (nothing shared was edited)", plain.map((g) => [g.id, g.bookmakers[0].markets[0].outcomes[0].price]), [[ROW_EVENT.id, -124], ["other-event", 999]]);
    expect("ROW_EVENT object itself untouched", ROW_EVENT.bookmakers[0].markets[0].outcomes[0].price, -124);
  }

  // ---- 3. a same-day post-tip pick: off the morning snapshot, onto the pre-tip listing ------------------------
  {
    const tipToday = "2026-11-12T00:10:00Z";
    const morningAt = new Date("2026-11-11T05:00:01Z");
    const listingAt = new Date("2026-11-11T22:41:48Z");
    const rowEvent = thunder(tipToday, [h2h("fanduel", -120, 100)]);
    const listingEvent = thunder(tipToday, [h2h("fanduel", -131, 110)]);
    const game = { homeTeam: "Portland Trail Blazers", awayTeam: "Oklahoma City Thunder", commenceTime: "2026-11-12T00:00:00Z" };
    // Same ET day as the tip (2026-11-11, 7:10 pm ET tip; import 7:40 pm ET): today's row, not a past day.
    // The same row is served as "today" and as its own ET day: resolveOddsGame picks between them by the REAL clock,
    // and this check must not depend on when the suite runs.
    const { pricing, calls } = harness({
      now: new Date("2026-11-12T00:40:00Z"),
      today: [rowEvent],
      byPastDay: { "2026-11-11": [rowEvent] },
      snapshotAt: () => morningAt,
      preTip: async () => ({ game: listingEvent, fetchedAt: listingAt }),
    });
    const point = await findMarketPricePoint(NBA, game, "MONEYLINE", "away", ML, pricing.forGame(game));
    expect("same-day post-tip ML: -131 from the 22:41Z pre-tip listing, not -120 from the 05:00Z snapshot", point?.price, -131);
    expect("same-day: capturedAt = listing time", pricing.capturedAt(NBA, rowEvent.id)?.toISOString(), listingAt.toISOString());
    expect("same-day: no purchase", calls.buyFresh, 0);
  }

  // ---- 4. fallbacks: every one prices from the row, as #445 does ------------------------------------------------
  const rowPrice = async (preTip: Parameters<typeof harness>[0]["preTip"], label: string) => {
    const { pricing, calls } = harness({ now: IMPORTED_AT, byPastDay: { "2026-11-10": [ROW_EVENT] }, snapshotAt: () => NOV10_ROW_AT, preTip });
    const point = await findMarketPricePoint(NBA, PICK_GAME, "MONEYLINE", "away", ML, pricing.forGame(PICK_GAME));
    expect(`${label}: -124 from the game-day row`, point?.price, -124);
    expect(`${label}: capturedAt = the row's time`, pricing.capturedAt(NBA, ROW_EVENT.id)?.toISOString(), NOV10_ROW_AT.toISOString());
    expect(`${label}: no purchase`, calls.buyFresh, 0);
  };
  await rowPrice(async () => null, "no listing retained (pruned after 24 h, or none bought that day)");
  await rowPrice(async () => ({ game: LISTING_EVENT, fetchedAt: new Date("2026-11-10T04:00:00Z") }), "only a listing older than the row");
  await rowPrice(async () => Promise.reject(new Error("db down")), "the pre-tip read fails (pricing never fails the import)");
  await rowPrice(null, "no pre-tip read wired at all");

  // ---- 5. a game that has not started: untouched ----------------------------------------------------------------
  {
    const futureStart = new Date(Date.now() + 3 * 86400000).toISOString();
    const futureEvent = thunder(futureStart, [h2h("fanduel", -140, 120)]);
    const futureGame = { homeTeam: "Portland Trail Blazers", awayTeam: "Oklahoma City Thunder", commenceTime: futureStart };
    const { pricing, calls } = harness({ now: new Date(), today: [futureEvent], snapshotAt: () => new Date(Date.now() - 30 * 60_000), preTip: async () => listing });
    const viaForGame = await pricing.forGame(futureGame)(NBA);
    const viaLoad = await pricing.load(NBA);
    expect("pregame: forGame hands back exactly load's games", viaForGame === viaLoad || JSON.stringify(viaForGame) === JSON.stringify(viaLoad), true);
    expect("pregame: price unchanged (-140)", (await findMarketPricePoint(NBA, futureGame, "MONEYLINE", "away", ML, pricing.forGame(futureGame)))?.price, -140);
    expect("pregame: no pre-tip read at all", calls.preTip.length, 0);
  }

  // ---- 6. source checks -------------------------------------------------------------------------------------------
  const fresh = readFileSync(path.join(__dirname, "fresh-odds.ts"), "utf8").replace(/\r\n/g, "\n");
  const start = fresh.indexOf("async function readPreTipEvent(");
  const sql = fresh.slice(start, fresh.indexOf("\n}\n", start));
  expect("default read found", start > 0 && sql.length > 200, true);
  expect("selects one element and its listing time - not the listing blob", sql.includes("SELECT e.ev, f.\"fetchedAt\"") && !/SELECT[^]*f\.data\s*,/.test(sql.split("FROM")[0]), true);
  expect("by event id, pre-start only, newest first, LIMIT 1", ["e.ev->>'id' = ${eventId}", "f.\"fetchedAt\" < ((e.ev->>'commenceTime')::timestamptz AT TIME ZONE 'UTC')", "ORDER BY f.\"fetchedAt\" DESC", "LIMIT 1"].every((s) => sql.includes(s)), true);
  expect("no purchase / write in the read", ["buyFresh", "fetchListing", ".create(", ".update(", "$executeRaw"].filter((s) => sql.includes(s)), []);
  const forGameStart = fresh.indexOf("const forGame: PricingOddsLoader[\"forGame\"]");
  const forGameBody = fresh.slice(forGameStart, fresh.indexOf("\n  };\n", forGameStart));
  expect("forGame never buys or reads a whole listing", ["buyFresh", "readFresh"].filter((s) => forGameBody.includes(s)), []);
  const core = readFileSync(path.join(__dirname, "bulk-import-core.ts"), "utf8");
  expect("the import prices each pick through pricing.forGame(game)", core.includes("pricing ? pricing.forGame(game) : getOdds"), true);

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll started-game pre-tip listing checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
