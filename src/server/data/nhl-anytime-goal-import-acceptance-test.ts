// Import-time price for an NHL Anytime Goal Scorer pick.
//
// Drives the REAL preview action (previewBulkImportMatches - the same
// resolveGameAndOdds the import itself stores from) over NHL and NFL lines,
// against an NHL snapshot that carries player_goal_scorer_anytime. Before this
// market was priced every one of these NHL lines came out at the -110
// placeholder; this file imports nothing that didn't exist then, so it runs
// (and fails) against that code too.
//
// The goal-scorer market data is __fixtures__/odds-api-event-nhl-goal-scorer-sample.json:
// HAND-BUILT in the Odds API's event-odds shape, not a captured response.
//
// No database and no network: prisma.oddsSnapshot.findUnique / prisma.user.findUnique
// are swapped for stubs, and global fetch returns an empty score feed, so each
// line resolves its game from the odds snapshot. Listed in
// PURE_DESPITE_PRISMA_IMPORT in scripts/run-tests.mjs. Run with:
//   npx tsx src/server/data/nhl-anytime-goal-import-acceptance-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { resolvePickPrice } from "@/lib/odds-source";
import { parseCatalog } from "@/lib/parse-catalog";
import type { OddsGame } from "./odds";

const env = process.env as Record<string, string | undefined>;
env.NODE_ENV = "development";
env.DEV_AUTH_BYPASS = "true";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

// Frozen on a day when NHL and NFL are both in season (getOddsForSport never
// reads the table for an out-of-season sport).
const base = Date.parse("2026-10-13T16:00:00Z");
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(base);
    else super(...(args as [string]));
  }
  static now() {
    return base;
  }
}
(globalThis as { Date: unknown }).Date = FakeDate;
const at = (hours: number) => new RealDate(base + hours * 3600000).toISOString();

type Book = OddsGame["bookmakers"][number];
const h2h = (key: string, title: string, home: string, away: string): Book => ({
  key,
  title,
  markets: [{ key: "h2h", outcomes: [{ name: home, price: -150 }, { name: away, price: 130 }] }],
});

const raw = JSON.parse(readFileSync(join(__dirname, "__fixtures__", "odds-api-event-nhl-goal-scorer-sample.json"), "utf8"));
// The day's game-lines row with the event response's markets added per book -
// the shape the snapshot has once the goal-scorer step has run.
const oilers: OddsGame = {
  id: raw.id,
  sportKey: raw.sport_key,
  homeTeam: raw.home_team,
  awayTeam: raw.away_team,
  commenceTime: at(9),
  bookmakers: (raw.bookmakers as Book[]).map((b) => ({
    ...b,
    markets: [...h2h(b.key, b.title, raw.home_team, raw.away_team).markets, ...b.markets],
  })),
};
// A second NHL game the feed has no goal-scorer market for at all.
const bruins: OddsGame = {
  id: "nhlNoProps",
  sportKey: "icehockey_nhl",
  homeTeam: "Boston Bruins",
  awayTeam: "Toronto Maple Leafs",
  commenceTime: at(8),
  bookmakers: [h2h("draftkings", "DraftKings", "Boston Bruins", "Toronto Maple Leafs")],
};

const chiefsBook = h2h("draftkings", "DraftKings", "Kansas City Chiefs", "Buffalo Bills");
const chiefs: OddsGame = {
  id: "nfl1",
  sportKey: "americanfootball_nfl",
  homeTeam: "Kansas City Chiefs",
  awayTeam: "Buffalo Bills",
  commenceTime: at(26),
  bookmakers: [
    {
      ...chiefsBook,
      markets: [
        ...chiefsBook.markets,
        {
          key: "player_reception_yds",
          outcomes: [
            { name: "Over", description: "Travis Kelce", price: -115, point: 42.5 },
            { name: "Under", description: "Travis Kelce", price: -105, point: 42.5 },
          ],
        },
        { key: "player_anytime_td", outcomes: [{ name: "Yes", description: "Travis Kelce", price: 120 }] },
      ],
    },
  ],
};

const SNAPSHOTS: Record<string, OddsGame[]> = {
  icehockey_nhl: [oilers, bruins],
  americanfootball_nfl: [chiefs],
};

(prisma.oddsSnapshot as unknown as { findUnique: (args: unknown) => Promise<unknown> }).findUnique = async (args: unknown) => {
  const { sportKey, fetchDate } = (args as { where: { sportKey_fetchDate: { sportKey: string; fetchDate: string } } }).where
    .sportKey_fetchDate;
  const data = SNAPSHOTS[sportKey];
  return data ? { id: "snap-" + sportKey, sportKey, fetchDate, data, createdAt: new Date(base), updatedAt: new Date(base) } : null;
};
(prisma.user as unknown as { findUnique: (args: unknown) => Promise<unknown> }).findUnique = async () => ({
  id: "user-nhl-goal-test",
  supabaseId: "dev-local-bypass",
  email: "dev-local@bettingview.test",
  name: "Local Dev Test User",
});

let oddsApiCalls = 0;
globalThis.fetch = (async (input: unknown) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("the-odds-api.com")) oddsApiCalls++;
  // Empty ESPN scoreboard ({ events }) and empty MLB schedule ({ dates }).
  return new Response(JSON.stringify({ events: [], dates: [] }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

type Item = {
  sportName: string;
  betType: "PLAYER_PROP";
  hasExplicitOdds: boolean;
  odds: number;
  teamNicknames: string[];
  description: string;
  gameNumber: null;
  period: "FULL_GAME";
};
const items: Item[] = [];
// Returns the line's index in `items`.
function add(sportName: string, nickname: string, description: string, stated?: number): number {
  items.push({
    sportName,
    betType: "PLAYER_PROP",
    hasExplicitOdds: stated !== undefined,
    odds: stated ?? -110,
    teamNicknames: [nickname],
    description,
    gameNumber: null,
    period: "FULL_GAME",
  });
  return items.length - 1;
}

const mcdavid = add("NHL", "oilers", "Connor McDavid anytime goal scorer");
const draisaitl = add("NHL", "oilers", "Oilers Leon Draisaitl Anytime Goal");
const typo = add("NHL", "oilers", "Conor McDavid ATG");
const secondBook = add("NHL", "oilers", "Ryan Nugent-Hopkins anytime goal scorer");
const notInFeed = add("NHL", "oilers", "Nobody Realname anytime goal scorer");
const noSide = add("NHL", "oilers", "Connor McDavid No Goal Scorer");
const onlyNoListed = add("NHL", "oilers", "Evan Bouchard anytime goal scorer");
const firstGoal = add("NHL", "oilers", "Connor McDavid first goal scorer");
const noMarket = add("NHL", "bruins", "David Pastrnak anytime goal scorer");
const stated = add("NHL", "oilers", "Connor McDavid anytime goal scorer +140", 140);
const kelceTd = add("NFL", "chiefs", "Chiefs Travis Kelce Anytime TD");
const kelceYds = add("NFL", "chiefs", "Chiefs Travis Kelce Over 42.5 Receiving Yards");
const nflFirstTd = add("NFL", "chiefs", "Chiefs Travis Kelce First TD");

async function main() {
  // The action module pulls in server/auth.ts, which wraps getCurrentUser in
  // React's server-only cache(); plain Node's React has none, so shim it (identity).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const react = require("react") as { cache?: unknown };
  react.cache ??= <T,>(fn: T) => fn;
  const { previewBulkImportMatches } = await import("@/server/actions/bulk-picks");

  const preview = await previewBulkImportMatches(items as never);
  // What the import stores for a line: resolvePickPrice over the line's own
  // price and the feed price the resolver found (null when it found none - the
  // preview only lists a row whose price moved off the line's own).
  const storedAs = (i: number) => resolvePickPrice(items[i], preview.odds[i] ?? null);

  // Every line found its game, so a missing price below is a pricing miss and
  // not a game-matching one.
  expect("every line without a stated price matched its game", items.filter((it, i) => !it.hasExplicitOdds && !preview.games[i]).length, 0);

  // ---- 1. the real price from the feed ----
  expect("McDavid anytime goal scorer -> first book's Yes price", storedAs(mcdavid), { odds: 105, oddsSource: "MARKET" });
  expect("team name in the line is stripped before matching ('Oilers Leon Draisaitl')", storedAs(draisaitl), { odds: 120, oddsSource: "MARKET" });
  expect("a one-letter typo and the ATG abbreviation still match", storedAs(typo), { odds: 105, oddsSource: "MARKET" });
  expect("a player only the second book lists is priced from it", storedAs(secondBook), { odds: 240, oddsSource: "MARKET" });

  // ---- 2. no match: never an invented price ----
  expect("player not in the feed stays DEFAULTED", storedAs(notInFeed), { odds: -110, oddsSource: "DEFAULTED" });
  expect("game with no goal-scorer market stays DEFAULTED", storedAs(noMarket), { odds: -110, oddsSource: "DEFAULTED" });
  expect("'No Goal Scorer' is not given the Yes price", storedAs(noSide), { odds: -110, oddsSource: "DEFAULTED" });
  expect("a player listed only on the No side is not priced from it", storedAs(onlyNoListed), { odds: -110, oddsSource: "DEFAULTED" });
  expect("first goal scorer is a different market - not priced", storedAs(firstGoal), { odds: -110, oddsSource: "DEFAULTED" });

  // ---- 3. the capper's own price is kept ----
  expect("a stated price is never sent to the feed lookup", preview.odds[stated], undefined);
  expect("stated +140 is kept over the feed's +105", resolvePickPrice(items[stated], 105), { odds: 140, oddsSource: "STATED" });
  const { picks } = parseCatalog("Some Capper\nNHL Connor McDavid anytime goal scorer +140", ["Some Capper"]);
  expect("parseCatalog reads that line's price as the capper's own", [picks.length, picks[0]?.odds, picks[0]?.hasExplicitOdds], [1, 140, true]);

  // ---- 4. NFL unchanged ----
  expect("NFL anytime TD still priced from player_anytime_td", storedAs(kelceTd), { odds: 120, oddsSource: "MARKET" });
  expect("NFL receiving yards still priced at its exact line", storedAs(kelceYds), { odds: -115, oddsSource: "MARKET" });
  expect("NFL first TD still not priced as anytime", storedAs(nflFirstTd), { odds: -110, oddsSource: "DEFAULTED" });

  expect("the Odds API was never called by an import", oddsApiCalls, 0);

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
