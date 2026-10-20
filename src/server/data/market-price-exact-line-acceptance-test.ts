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
// Parlay legs go through the real parlay import action. A leg's line is the
// live market line, not the number in its text (see resolveLegAndOdds), so its
// price has to be read at that live line.
//
// No database and no network: prisma.oddsSnapshot.findUnique and
// prisma.user.findUnique are swapped for stubs, and global fetch returns an
// empty score feed, so every line is matched and priced off the odds snapshot.
// The parlay section also stubs the capper / sport reads and captures
// prisma.parlayBet.create instead of writing.
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
    // Bills @ Chiefs: the first book hangs no spread at all, so the live spread
    // line is the second book's.
    {
      id: "nfl-buf-kc",
      sportKey: NFL,
      homeTeam: "Kansas City Chiefs",
      awayTeam: "Buffalo Bills",
      commenceTime: at(27),
      bookmakers: [
        {
          key: "bookA",
          title: "Book A",
          markets: [{ key: "h2h", outcomes: [{ name: "Kansas City Chiefs", price: -135 }, { name: "Buffalo Bills", price: 115 }] }],
        },
        {
          key: "bookB",
          title: "Book B",
          markets: [
            { key: "spreads", outcomes: [{ name: "Kansas City Chiefs", price: -122, point: -2.5 }, { name: "Buffalo Bills", price: 102, point: 2.5 }] },
          ],
        },
      ],
    },
    // Packers @ Bears: moneyline only - no spread anywhere on the feed.
    {
      id: "nfl-gb-chi",
      sportKey: NFL,
      homeTeam: "Chicago Bears",
      awayTeam: "Green Bay Packers",
      commenceTime: at(29),
      bookmakers: [
        {
          key: "bookA",
          title: "Book A",
          markets: [{ key: "h2h", outcomes: [{ name: "Chicago Bears", price: -125 }, { name: "Green Bay Packers", price: 105 }] }],
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
  const { previewBulkImportMatches, bulkImportParlaysAction } = await import("@/server/actions/bulk-picks");

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

  // ---- parlay legs ----
  type CreatedLeg = { betDetail: string; odds: number; line: number | null };
  const created: CreatedLeg[][] = [];
  const db = prisma as unknown as Record<string, Record<string, unknown>>;
  // The roster read: what it asked for, answered with the only columns it may use.
  const capperReads: unknown[] = [];
  db.capper.findMany = async (args: unknown) => {
    capperReads.push(args);
    return [{ id: "capper-leg-test", name: "Leg Tester" }];
  };
  db.capper.findFirst = async () => ({ id: "capper-leg-test" });
  db.sport.findFirst = async () => ({ id: "sport-nfl" });
  const parlayCappers: unknown[] = [];
  db.parlayBet.create = async (args: unknown) => {
    const data = (args as { data: { capperId?: unknown; capper?: unknown; legs: { create: CreatedLeg[] } } }).data;
    parlayCappers.push(data.capperId ?? data.capper);
    created.push(data.legs.create);
    return { id: "parlay-" + created.length };
  };

  const leg = (
    description: string,
    betType: Item["betType"],
    teamNicknames: string[],
    extra: Partial<Item> = {}
  ): Item => ({ sportName: "NFL", betType, hasExplicitOdds: false, odds: -110, teamNicknames, description, gameNumber: null, period: "FULL_GAME", ...extra });

  const parlays = [
    {
      capperName: "Leg Tester",
      units: 1,
      legs: [
        // The number in a leg's text is a label; the live line is -3.5 / 47.5.
        leg("Cowboys -9", "SPREAD", ["cowboys"]),
        leg("Buccaneers Cowboys Over 40", "TOTAL", ["buccaneers", "cowboys"], { totalSide: "over" }),
      ],
    },
    {
      capperName: "Leg Tester",
      units: 1,
      legs: [
        leg("Chiefs -1", "SPREAD", ["chiefs"]),
        leg("Cowboys 1H -3.5", "SPREAD", ["cowboys"], { period: "FIRST_HALF" }),
        leg("Buccaneers +3.5 +105", "SPREAD", ["buccaneers"], { hasExplicitOdds: true, odds: 105 }),
      ],
    },
    // A spread leg on a game with no spread on the feed: no line, no parlay.
    { capperName: "Leg Tester", units: 1, legs: [leg("Bears -3", "SPREAD", ["bears"]), leg("Cowboys ML", "MONEYLINE", ["cowboys"])] },
  ];
  let parlayResult: unknown;
  try {
    parlayResult = await bulkImportParlaysAction(parlays as never);
  } catch (err) {
    // revalidateTag / revalidatePath have no Next request to run in here; they
    // are the action's last step, after every parlay has been resolved.
    parlayResult = err instanceof Error ? err.message : String(err);
  }
  const legOf = (detail: string) => {
    const found = created.flat().find((l) => l.betDetail === detail);
    return found ? { line: found.line, odds: found.odds } : null;
  };
  if (created.length !== 2) console.log("parlay import result:", JSON.stringify(parlayResult));
  check("two of the three parlays were created", created.length, 2);
  check("leg at the main line (first book's -3.5): priced there, whatever its text says", legOf("Cowboys -9"), { line: -3.5, odds: -108 });
  check("total leg at the main line (47.5): the Over price", legOf("Buccaneers Cowboys Over 40"), { line: 47.5, odds: -105 });
  check("leg whose spread only the second book hangs (-2.5): the second book's price", legOf("Chiefs -1"), { line: -2.5, odds: -122 });
  check("1H leg: no full-game price, stays at the placeholder", legOf("Cowboys 1H -3.5"), { line: -3.5, odds: -110 });
  check("leg with the capper's own price keeps it", legOf("Buccaneers +3.5 +105"), { line: 3.5, odds: 105 });
  check("leg with no line on the feed: the whole parlay is rejected, nothing priced", legOf("Bears -3"), null);

  check("the parlay import reads the roster's id and name only", capperReads.map((a) => (a as { select?: unknown }).select ?? "every column"), [{ id: true, name: true }]);
  check("both parlays attach to the existing capper (matched by name)", JSON.stringify(parlayCappers).split("capper-leg-test").length - 1, 2);
  check("the Odds API was never called", oddsApiCalls, 0);

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
