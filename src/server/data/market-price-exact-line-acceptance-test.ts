// A pick's feed price is the price of the bet it actually is, or nothing.
//
// findMarketPrice used to match an outcome by name alone - "Over", or the
// team - and take the first bookmaker listing the market. So "Over 35.5" was
// stored at the 47.5 main total's price, an alternate spread at the main
// spread's, a 1H pick at the full-game price, and a pick whose side couldn't
// be told apart at whichever team came out of a fallback. Each was then marked
// oddsSource MARKET.
//
// This drives the REAL preview action (the same resolveGameAndOdds the import
// stores from) over one small snapshot and checks which lines get a feed price.
// A line with no entry in the result keeps what it had: the capper's own price
// when stated, else the -110 placeholder marked DEFAULTED (resolvePickPrice).
//
// No database and no network: prisma.oddsSnapshot.findUnique and
// prisma.user.findUnique are swapped for stubs, and global fetch returns an
// empty score feed, so every line is matched and priced off the odds snapshot.
//
// Run with:
//   npx tsx src/server/data/market-price-exact-line-acceptance-test.ts
// The clock is frozen on a day NFL and NCAAF are both in season.
import { prisma } from "@/lib/prisma";
import { resolvePickPrice } from "@/lib/odds-source";
import type { OddsGame } from "./odds";

const env = process.env as Record<string, string | undefined>;
env.NODE_ENV = "development";
env.DEV_AUTH_BYPASS = "true";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`}`);
  if (!pass) failures++;
}

// ---- frozen clock ----
const base = Date.parse("2026-10-06T16:00:00Z");
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

// ---- the snapshot ----
// Buccaneers @ Cowboys. The two books hang different numbers, so a line can
// exist at the second book only: spread 3.5 vs 3, total 47.5 vs 48.
const HOME = "Dallas Cowboys";
const AWAY = "Tampa Bay Buccaneers";
const NFL = "americanfootball_nfl";
const NCAAF = "americanfootball_ncaaf";

const FIXTURE: Record<string, OddsGame[]> = {
  [NFL]: [
    {
      id: "nfl-tb-dal",
      sportKey: NFL,
      homeTeam: HOME,
      awayTeam: AWAY,
      commenceTime: at(26),
      bookmakers: [
        {
          key: "bookA",
          title: "Book A",
          markets: [
            { key: "h2h", outcomes: [{ name: HOME, price: -150 }, { name: AWAY, price: 130 }] },
            { key: "spreads", outcomes: [{ name: HOME, price: -108, point: -3.5 }, { name: AWAY, price: -112, point: 3.5 }] },
            { key: "totals", outcomes: [{ name: "Over", price: -105, point: 47.5 }, { name: "Under", price: -115, point: 47.5 }] },
          ],
        },
        {
          key: "bookB",
          title: "Book B",
          markets: [
            { key: "h2h", outcomes: [{ name: HOME, price: -155 }, { name: AWAY, price: 135 }] },
            { key: "spreads", outcomes: [{ name: HOME, price: -120, point: -3 }, { name: AWAY, price: 100, point: 3 }] },
            { key: "totals", outcomes: [{ name: "Over", price: -102, point: 48 }, { name: "Under", price: -118, point: 48 }] },
          ],
        },
      ],
    },
  ],
  // Same mascot on both sides: "Tigers" alone can't say which team.
  [NCAAF]: [
    {
      id: "cfb-lsu-clem",
      sportKey: NCAAF,
      homeTeam: "Clemson Tigers",
      awayTeam: "LSU Tigers",
      commenceTime: at(28),
      bookmakers: [
        {
          key: "bookA",
          title: "Book A",
          markets: [
            { key: "h2h", outcomes: [{ name: "Clemson Tigers", price: -140 }, { name: "LSU Tigers", price: 120 }] },
            { key: "spreads", outcomes: [{ name: "Clemson Tigers", price: -105, point: -2.5 }, { name: "LSU Tigers", price: -115, point: 2.5 }] },
          ],
        },
      ],
    },
  ],
};

// ---- stubs ----
(prisma.oddsSnapshot as unknown as { findUnique: (args: unknown) => Promise<unknown> }).findUnique = async (args: unknown) => {
  const { sportKey, fetchDate } = (args as { where: { sportKey_fetchDate: { sportKey: string; fetchDate: string } } }).where
    .sportKey_fetchDate;
  const data = FIXTURE[sportKey];
  return data ? { id: "snap-" + sportKey, sportKey, fetchDate, data, createdAt: new Date(base), updatedAt: new Date(base) } : null;
};
(prisma.user as unknown as { findUnique: (args: unknown) => Promise<unknown> }).findUnique = async () => ({
  id: "user-exact-line-test",
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

// ---- the lines ----
type Item = {
  sportName: string;
  betType: "MONEYLINE" | "SPREAD" | "TOTAL";
  hasExplicitOdds: boolean;
  odds: number;
  totalSide?: "over" | "under";
  teamNicknames: string[];
  description: string;
  gameNumber: null;
  period?: string;
};

// [label, the line, the feed price it must get - null = none].
const cases: [string, Omit<Item, "hasExplicitOdds" | "odds" | "gameNumber" | "sportName"> & { sportName?: string }, number | null][] = [
  // -- totals --
  [
    "Over 35.5 against a 47.5 / 48 snapshot: no feed price",
    { betType: "TOTAL", totalSide: "over", teamNicknames: ["buccaneers", "cowboys"], description: "Buccaneers Cowboys Over 35.5", period: "FULL_GAME" },
    null,
  ],
  [
    "Over 47.5, the first book's own line: that book's Over price",
    { betType: "TOTAL", totalSide: "over", teamNicknames: ["buccaneers", "cowboys"], description: "Buccaneers Cowboys Over 47.5", period: "FULL_GAME" },
    -105,
  ],
  [
    "Under 47.5: the Under price, not the Over's",
    { betType: "TOTAL", totalSide: "under", teamNicknames: ["buccaneers", "cowboys"], description: "Buccaneers Cowboys Under 47.5", period: "FULL_GAME" },
    -115,
  ],
  [
    "Under 48, hung by the second book only: the second book's price",
    { betType: "TOTAL", totalSide: "under", teamNicknames: ["buccaneers", "cowboys"], description: "Buccaneers Cowboys Under 48", period: "FULL_GAME" },
    -118,
  ],
  [
    "1H Over 47.5: not the full-game total's price",
    { betType: "TOTAL", totalSide: "over", teamNicknames: ["buccaneers", "cowboys"], description: "Buccaneers Cowboys 1H Over 47.5", period: "FIRST_HALF" },
    null,
  ],
  [
    "a total with no number in its text: no feed price",
    { betType: "TOTAL", totalSide: "over", teamNicknames: ["buccaneers", "cowboys"], description: "Buccaneers Cowboys Over", period: "FULL_GAME" },
    null,
  ],
  // -- spreads --
  ["Cowboys -3.5, the first book's line", { betType: "SPREAD", teamNicknames: ["cowboys"], description: "Cowboys -3.5", period: "FULL_GAME" }, -108],
  ["Buccaneers +3.5: the away side's price", { betType: "SPREAD", teamNicknames: ["buccaneers"], description: "Buccaneers +3.5", period: "FULL_GAME" }, -112],
  ["Cowboys -3, hung by the second book only", { betType: "SPREAD", teamNicknames: ["cowboys"], description: "Cowboys -3", period: "FULL_GAME" }, -120],
  ["Cowboys -7.5, an alternate spread: no feed price", { betType: "SPREAD", teamNicknames: ["cowboys"], description: "Cowboys -7.5", period: "FULL_GAME" }, null],
  ["Cowboys +3.5, the other side's number: no feed price", { betType: "SPREAD", teamNicknames: ["cowboys"], description: "Cowboys +3.5", period: "FULL_GAME" }, null],
  ["Cowboys 1H -3.5: not the full-game spread's price", { betType: "SPREAD", teamNicknames: ["cowboys"], description: "Cowboys 1H -3.5", period: "FIRST_HALF" }, null],
  // -- moneyline --
  ["Cowboys ML: the home price", { betType: "MONEYLINE", teamNicknames: ["cowboys"], description: "Cowboys ML", period: "FULL_GAME" }, -150],
  ["Buccaneers ML: the away price", { betType: "MONEYLINE", teamNicknames: ["buccaneers"], description: "Buccaneers ML", period: "FULL_GAME" }, 130],
  ["Cowboys 1H ML: not the full-game moneyline", { betType: "MONEYLINE", teamNicknames: ["cowboys"], description: "Cowboys 1H ML", period: "FIRST_HALF" }, null],
  // -- no period sent at all (a browser still running the previous build) --
  ["no period on the request: no feed price", { betType: "MONEYLINE", teamNicknames: ["cowboys"], description: "Cowboys ML" }, null],
  // -- side can't be determined --
  [
    "same-mascot spread (Tigers -2.5, Clemson Tigers v LSU Tigers): no feed price",
    { sportName: "NCAAF", betType: "SPREAD", teamNicknames: ["tigers"], description: "Tigers -2.5", period: "FULL_GAME" },
    null,
  ],
  [
    "same-mascot spread at the away side's number (Tigers +2.5): no feed price",
    { sportName: "NCAAF", betType: "SPREAD", teamNicknames: ["tigers"], description: "Tigers +2.5", period: "FULL_GAME" },
    null,
  ],
  [
    "same-mascot moneyline: no feed price",
    { sportName: "NCAAF", betType: "MONEYLINE", teamNicknames: ["tigers"], description: "Tigers ML", period: "FULL_GAME" },
    null,
  ],
  [
    "a moneyline naming both teams: no feed price (it was the first-listed team's)",
    { betType: "MONEYLINE", teamNicknames: ["buccaneers", "cowboys"], description: "Cowboys ML vs Buccaneers", period: "FULL_GAME" },
    null,
  ],
];

const items: Item[] = cases.map(([, item]) => ({ sportName: "NFL", hasExplicitOdds: false, odds: -110, gameNumber: null, ...item }));

async function main() {
  // The action module pulls in server/auth.ts, which wraps getCurrentUser in
  // React's server-only cache(); plain Node's React has none, so shim it (identity).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const react = require("react") as { cache?: unknown };
  react.cache ??= <T,>(fn: T) => fn;
  const { previewBulkImportMatches } = await import("@/server/actions/bulk-picks");

  // A capper's own price rides along: never resolved, never replaced.
  const stated: Item = {
    sportName: "NFL",
    betType: "TOTAL",
    totalSide: "over",
    hasExplicitOdds: true,
    odds: -125,
    teamNicknames: ["buccaneers", "cowboys"],
    description: "Buccaneers Cowboys Over 35.5 -125",
    gameNumber: null,
    period: "FULL_GAME",
  };
  const preview = await previewBulkImportMatches([...items, stated] as never);

  cases.forEach(([label, , expected], i) => {
    check("every line matched its game: " + items[i].description, preview.games[i] !== undefined, true);
    check(label, preview.odds[i] ?? null, expected);
  });

  // What a line with no feed price is stored as (the import hands the same
  // null to resolvePickPrice): the capper's price if there is one, else the
  // placeholder marked DEFAULTED - never MARKET.
  const altTotal = items[0];
  check("the alternate total is DEFAULTED, not MARKET", resolvePickPrice(altTotal, preview.odds[0] ?? null), { odds: -110, oddsSource: "DEFAULTED" });
  check("the same alternate total with the capper's own price keeps it", preview.odds[items.length] ?? null, null);
  check("...and is STATED", resolvePickPrice(stated, null), { odds: -125, oddsSource: "STATED" });
  check("the exact main line is MARKET at the feed price", resolvePickPrice(items[1], preview.odds[1] ?? null), { odds: -105, oddsSource: "MARKET" });

  check("the Odds API was never called", oddsApiCalls, 0);

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
