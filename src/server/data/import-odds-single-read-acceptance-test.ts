// Catalog import: one OddsSnapshot read per sport per request.
//
// On 2026-10-04 three /picks/import POSTs read the full NFL OddsSnapshot row
// from Postgres 84, 127 and 126 times - once per pasted line. Every line is
// resolved concurrently (Promise.all over resolveGameAndOdds), each line calls
// getOddsForSport up to three times (game match, pricing, props), and nothing
// collapsed concurrent cache misses. This drives the REAL preview action over a
// multi-sport paste and counts prisma.oddsSnapshot.findUnique calls.
//
// No database and no network: prisma.oddsSnapshot.findUnique and
// prisma.user.findUnique are swapped for spies, and global fetch returns an
// empty score feed for every sport, so every line falls through to the odds
// feed (the path that reads the snapshot for both matching and pricing).
//
// Outside a Next request context cachedByTag has no Data Cache and runs its
// callback directly, so this measures the worst case: a cold key on every call.
//
// Run with:
//   npx tsx src/server/data/import-odds-single-read-acceptance-test.ts
// The clock is frozen on a day when all four sports are in season
// (getOddsForSport never reads the table for an out-of-season sport), so the
// run does not depend on the calendar.
//
// Env (used to prove resolution output did not change - run this same file
// against the code before the change and diff the two outputs):
//   IMPORT_ODDS_OUT       write the resolved output as JSON to this path
//   IMPORT_ODDS_BASELINE  "1" = report read counts without asserting on them
import { writeFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import type { OddsGame } from "./odds";

const env = process.env as Record<string, string | undefined>;
env.NODE_ENV = "development";
env.DEV_AUTH_BYPASS = "true";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

const BASELINE = env.IMPORT_ODDS_BASELINE === "1";

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

type Book = OddsGame["bookmakers"][number];

function lines(key: string, title: string, home: string, away: string, n: number, withTotals: boolean): Book {
  const markets: Book["markets"] = [
    { key: "h2h", outcomes: [{ name: home, price: -150 - n }, { name: away, price: 130 + n }] },
    { key: "spreads", outcomes: [{ name: home, price: -110 - n, point: -3.5 }, { name: away, price: -108 + n, point: 3.5 }] },
  ];
  if (withTotals) {
    markets.push({ key: "totals", outcomes: [{ name: "Over", price: -112 - n, point: 44.5 + n }, { name: "Under", price: -106 + n, point: 44.5 + n }] });
  }
  return { key, title, markets };
}

function game(sportKey: string, id: string, home: string, away: string, hours: number, n: number): OddsGame {
  return {
    id,
    sportKey,
    homeTeam: home,
    awayTeam: away,
    commenceTime: at(hours),
    // The first book has no totals market on odd games, so a TOTAL lookup has
    // to fall through to the second book.
    bookmakers: [lines("bookA", "Book A", home, away, n, n % 2 === 0), lines("bookB", "Book B", home, away, n + 3, true)],
  };
}

const NFL = "americanfootball_nfl";
const nflGames = [
  game(NFL, "nfl1", "Kansas City Chiefs", "Buffalo Bills", 26, 0),
  game(NFL, "nfl2", "Philadelphia Eagles", "Dallas Cowboys", 27, 1),
  game(NFL, "nfl3", "Chicago Bears", "Green Bay Packers", 29, 2),
];
nflGames[0].bookmakers[0].markets.push(
  {
    key: "player_reception_yds",
    outcomes: [
      { name: "Over", description: "Travis Kelce", price: -115, point: 42.5 },
      { name: "Under", description: "Travis Kelce", price: -105, point: 42.5 },
    ],
  } as Book["markets"][number],
  {
    key: "player_anytime_td",
    outcomes: [{ name: "Yes", description: "Travis Kelce", price: 120 }],
  } as Book["markets"][number]
);

const FIXTURE: Record<string, OddsGame[]> = {
  [NFL]: nflGames,
  icehockey_nhl: [
    game("icehockey_nhl", "nhl1", "Boston Bruins", "Toronto Maple Leafs", 25, 0),
    game("icehockey_nhl", "nhl2", "New York Rangers", "New Jersey Devils", 26, 1),
  ],
  baseball_mlb: [
    game("baseball_mlb", "mlb1", "Los Angeles Dodgers", "Chicago Cubs", 24, 0),
    game("baseball_mlb", "mlb2", "New York Yankees", "Boston Red Sox", 25, 1),
  ],
  americanfootball_ncaaf: [
    game("americanfootball_ncaaf", "cfb1", "Alabama Crimson Tide", "Georgia Bulldogs", 28, 0),
    game("americanfootball_ncaaf", "cfb2", "Ohio State Buckeyes", "Michigan Wolverines", 30, 1),
  ],
};

// ---- spies ----
const reads: Record<string, number> = {};
const delegate = prisma.oddsSnapshot as unknown as { findUnique: (args: unknown) => Promise<unknown> };
delegate.findUnique = async (args: unknown) => {
  const { sportKey, fetchDate } = (args as { where: { sportKey_fetchDate: { sportKey: string; fetchDate: string } } }).where
    .sportKey_fetchDate;
  reads[sportKey] = (reads[sportKey] ?? 0) + 1;
  // A real read takes time; without this the calls would not overlap.
  await new Promise((resolve) => setTimeout(resolve, 25));
  const data = FIXTURE[sportKey];
  return data ? { id: "snap-" + sportKey, sportKey, fetchDate, data, createdAt: new Date(base), updatedAt: new Date(base) } : null;
};
(prisma.user as unknown as { findUnique: (args: unknown) => Promise<unknown> }).findUnique = async () => ({
  id: "user-import-odds-test",
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

// ---- the paste ----
type Item = {
  sportName: string;
  betType: "MONEYLINE" | "SPREAD" | "TOTAL" | "TEAM_TOTAL" | "PLAYER_PROP";
  hasExplicitOdds: boolean;
  odds: number;
  totalSide?: "over" | "under";
  teamNicknames: string[];
  description: string;
  gameNumber: 1 | 2 | null;
};

const TEAMS: Record<string, [string, string][]> = {
  NFL: [["chiefs", "bills"], ["eagles", "cowboys"], ["bears", "packers"]],
  NHL: [["bruins", "maple leafs"], ["rangers", "devils"]],
  MLB: [["dodgers", "cubs"], ["yankees", "red sox"]],
  NCAAF: [["crimson tide", "bulldogs"], ["buckeyes", "wolverines"]],
};

const items: Item[] = [];
const add = (item: Omit<Item, "hasExplicitOdds" | "odds" | "gameNumber">) =>
  items.push({ hasExplicitOdds: false, odds: -110, gameNumber: null, ...item });
for (let round = 0; round < 3; round++) {
  for (const [sportName, pairs] of Object.entries(TEAMS)) {
    for (const [home, away] of pairs) {
      add({ sportName, betType: "MONEYLINE", teamNicknames: [home], description: `${home} ML` });
      add({ sportName, betType: "MONEYLINE", teamNicknames: [away], description: `${away} ML` });
      add({ sportName, betType: "SPREAD", teamNicknames: [away], description: `${away} +3.5` });
      add({ sportName, betType: "TOTAL", totalSide: "over", teamNicknames: [home, away], description: `${home} ${away} over 44.5` });
      add({ sportName, betType: "TOTAL", totalSide: "under", teamNicknames: [away], description: `${away} under 44.5` });
      add({ sportName, betType: "TEAM_TOTAL", totalSide: "over", teamNicknames: [home], description: `${home} team total over 21.5` });
    }
  }
  add({ sportName: "NFL", betType: "PLAYER_PROP", teamNicknames: ["chiefs"], description: "Chiefs Travis Kelce Over 42.5 Receiving Yards" });
  add({ sportName: "NFL", betType: "PLAYER_PROP", teamNicknames: ["chiefs"], description: "Chiefs Travis Kelce Anytime TD" });
  add({ sportName: "NFL", betType: "PLAYER_PROP", teamNicknames: ["bills"], description: "Bills Nobody Real Over 9.5 Receptions" });
}
// Lines that match nothing (each takes the 1 s retry), one with the capper's
// own odds (never resolved), and a sport with no score source at all.
add({ sportName: "NFL", betType: "MONEYLINE", teamNicknames: ["unicorns"], description: "unicorns ML" });
add({ sportName: "NHL", betType: "SPREAD", teamNicknames: ["unicorns"], description: "unicorns -1.5" });
items.push({ sportName: "MLB", betType: "MONEYLINE", hasExplicitOdds: true, odds: 145, teamNicknames: ["cubs"], description: "cubs ML +145", gameNumber: null });
add({ sportName: "Cricket", betType: "MONEYLINE", teamNicknames: ["kiwis"], description: "kiwis ML" });

const SPORTS_IN_PASTE = Object.keys(FIXTURE).length;
const total = () => Object.values(reads).reduce((a, b) => a + b, 0);
const reset = () => {
  for (const k of Object.keys(reads)) delete reads[k];
};

async function main() {
  // The action module pulls in server/auth.ts, which wraps getCurrentUser in
  // React's server-only cache(); plain Node's React has none, so shim it (identity).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const react = require("react") as { cache?: unknown };
  react.cache ??= <T,>(fn: T) => fn;
  const { previewBulkImportMatches, previewMissingTotalLines } = await import("@/server/actions/bulk-picks");
  const odds = await import("./odds");
  const { resolvePropOdds } = await import("./nfl-prop-odds");

  // ---- 1. the real preview action over the whole paste ----
  reset();
  const preview = await previewBulkImportMatches(items as never);
  const previewReads = { ...reads };
  const previewTotal = total();
  console.log(`preview: ${items.length} lines, ${SPORTS_IN_PASTE} sports -> ${previewTotal} snapshot reads`, JSON.stringify(previewReads));

  // ---- 2. a second action in a separate request ----
  reset();
  const noNumber = items.filter((i) => i.betType === "TOTAL").map((i) => ({ ...i, description: i.description.replace(/ [0-9.]+$/, "") }));
  const missingTotals = await previewMissingTotalLines(noNumber as never);
  const missingReads = { ...reads };
  const missingTotal = total();
  console.log(`missing-total preview: ${noNumber.length} lines -> ${missingTotal} snapshot reads`, JSON.stringify(missingReads));

  check("the paste resolved real games", Object.keys(preview.games).length > 60, `(${Object.keys(preview.games).length} matched)`);
  check("market prices were looked up", Object.keys(preview.odds).length > 30, `(${Object.keys(preview.odds).length} enriched)`);
  check("the Odds API was never called", oddsApiCalls === 0, `(${oddsApiCalls} calls)`);

  if (!BASELINE) {
    for (const sportKey of Object.keys(FIXTURE)) {
      check(`preview reads ${sportKey} at most once`, (previewReads[sportKey] ?? 0) <= 1, `(${previewReads[sportKey] ?? 0})`);
      check(`missing-total preview reads ${sportKey} at most once`, (missingReads[sportKey] ?? 0) <= 1, `(${missingReads[sportKey] ?? 0})`);
    }
    check("preview reads <= distinct sports in the paste", previewTotal <= SPORTS_IN_PASTE, `(${previewTotal} <= ${SPORTS_IN_PASTE})`);
  }

  // ---- 3. every odds-backed resolver, called directly (resolution output) ----
  const direct: Record<string, unknown> = {};
  for (const [sportKey, games] of Object.entries(FIXTURE)) {
    for (const g of games) {
      const ref = { homeTeam: g.homeTeam, awayTeam: g.awayTeam, commenceTime: g.commenceTime };
      const home = g.homeTeam.toLowerCase().split(" ").pop()!;
      const away = g.awayTeam.toLowerCase().split(" ").pop()!;
      direct[g.id] = {
        byNickname: await odds.resolveGameForNickname(sportKey, home),
        byTeams: await odds.resolveGameForTeams(sportKey, home, away),
        oddsGameId: (await odds.resolveOddsGame(sportKey, ref))?.id ?? null,
        favored: await odds.findFavoredSide(sportKey, ref),
        mlHome: await odds.findMarketPrice(sportKey, ref, "MONEYLINE", "home"),
        spreadAway: await odds.findMarketPrice(sportKey, ref, "SPREAD", "away"),
        totalOver: await odds.findMarketPrice(sportKey, ref, "TOTAL", "over"),
        spreadLine: await odds.findMarketSpreadLine(sportKey, ref, "home"),
        totalLine: await odds.findMarketTotalLine(sportKey, ref, "under"),
      };
    }
  }
  const kelce = { homeTeam: nflGames[0].homeTeam, awayTeam: nflGames[0].awayTeam, commenceTime: nflGames[0].commenceTime };
  direct.props = {
    recYds: await resolvePropOdds(NFL, kelce, { playerName: "Travis Kelce", propMarket: "REC_YDS", side: "Over", point: 42.5 } as never),
    td: await resolvePropOdds(NFL, kelce, { playerName: "Travis Kelce", propMarket: "TD" } as never),
    nobody: await resolvePropOdds(NFL, kelce, { playerName: "Nobody Real", propMarket: "RECEPTIONS", side: "Over", point: 9.5 } as never),
  };
  check("a prop price resolved from the snapshot", (direct.props as { recYds: unknown }).recYds === -115, `(${(direct.props as { recYds: unknown }).recYds})`);

  if (env.IMPORT_ODDS_OUT) {
    writeFileSync(env.IMPORT_ODDS_OUT, JSON.stringify({ preview, missingTotals, direct }, null, 1));
    console.log("resolved output written to", env.IMPORT_ODDS_OUT);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
