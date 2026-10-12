// Hockey 3-way (regulation-time) moneyline, end to end: the wording is parsed
// as its own market, priced only from h2h_3_way, and graded on the regulation
// score.
//
//   1. Parsing (parseCatalog): each wording -> MONEYLINE + period REGULATION on
//      an NHL pick; plain "Oilers ML" and everything else unchanged.
//   2. Pricing: the same parsed lines through the REAL preview action
//      (previewBulkImportMatches - the resolveGameAndOdds the import stores
//      from), against the h2h_3_way response captured live 2026-10-12
//      (__fixtures__/odds-api-event-nhl-3way-response.json). A game with only
//      the 2-way h2h market gives a 3-way pick no price at all.
//   3. Grading (resolveOutcome) on real ESPN linescores: a regulation win, an
//      overtime win (the 3-way bet loses), and a game level after regulation
//      (the draw wins, both teams lose).
//
// Imports nothing this change added, so it runs against the code from before
// it and fails there: the wordings come back as full-game moneylines, are
// priced off the 2-way market, and nothing grades a REGULATION pick.
//
// No database and no network: prisma.oddsSnapshot.findUnique / prisma.user.findUnique
// are swapped for stubs, and global fetch returns an empty score feed. Listed
// in PURE_DESPITE_PRISMA_IMPORT in scripts/run-tests.mjs. Run with:
//   npx tsx src/server/data/nhl-three-way-moneyline-acceptance-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { resolvePickPrice } from "@/lib/odds-source";
import { parseCatalog } from "@/lib/parse-catalog";
import { resolveOutcome } from "@/server/data/grading";
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

// Frozen on a day when NHL, NBA and NFL are all in season.
const base = Date.parse("2026-11-10T16:00:00Z");
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

const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, "__fixtures__", name), "utf8"));

function parse(lines: string[]) {
  return parseCatalog("Some Capper\n" + lines.join("\n"), ["Some Capper"]).picks;
}
const shape = (lines: string[]) => parse(lines).map((p) => [p.description, p.sportName, p.betType, p.period]);

// =====================================================================
// 1. Parsing
// =====================================================================
expect(
  "parse: every 3-way wording on an NHL pick is a REGULATION moneyline",
  shape([
    "Oilers 3-way ML",
    "Oilers 3 way ML",
    "Oilers 3way",
    "Oilers three-way",
    "Oilers regulation ML",
    "Oilers reg ML",
    "Oilers reg",
    "Oilers in regulation",
    "Oilers 60 min ML",
    "Oilers 60 minute ML",
    "Oilers ML (regulation)",
    "Oilers Flames draw",
    "Oilers/Flames tie",
    "Draw Oilers Flames",
  ]).map((r) => [r[1], r[2], r[3]]),
  Array.from({ length: 14 }, () => ["NHL", "MONEYLINE", "REGULATION"])
);
expect(
  "parse: wording in a parenthetical stays in the stored text",
  shape(["Oilers ML (regulation)", "Oilers Flames (draw)"]).map((r) => r[0]),
  ["Oilers ML regulation", "Oilers Flames draw"]
);
expect(
  "parse: a stated price is still read off a 3-way line",
  parse(["Oilers 3-way +115", "Oilers/Flames tie +320", "Oilers 60 minute ML -105"]).map((p) => [p.period, p.odds, p.hasExplicitOdds]),
  [
    ["REGULATION", 115, true],
    ["REGULATION", 320, true],
    ["REGULATION", -105, true],
  ]
);
expect(
  "parse: plain NHL moneylines are unchanged",
  shape(["Oilers ML", "Oilers", "Oilers moneyline -130", "Oilers ML 1st period"]).map((r) => [r[1], r[2], r[3]]),
  [
    ["NHL", "MONEYLINE", "FULL_GAME"],
    ["NHL", "MONEYLINE", "FULL_GAME"],
    ["NHL", "MONEYLINE", "FULL_GAME"],
    ["NHL", "MONEYLINE", "FIRST_PERIOD"],
  ]
);
expect(
  "parse: 2-way markets that mention a draw are not 3-way (draw no bet, double chance)",
  shape(["Oilers draw no bet", "Oilers DNB", "Oilers or draw"]).map((r) => r[3]),
  ["FULL_GAME", "FULL_GAME", "FULL_GAME"]
);
expect(
  "parse: NHL spreads and totals keep their period - only a moneyline is 3-way",
  shape(["Oilers -1.5 reg", "Oilers Flames over 6.5 regulation"]).map((r) => [r[2], r[3]]),
  [
    ["SPREAD", "FULL_GAME"],
    ["TOTAL", "FULL_GAME"],
  ]
);
expect(
  "parse: the same words on another sport's pick change nothing",
  shape(["Lakers ML reg", "Chiefs regulation ML", "Yankees 3-way ML"]).map((r) => [r[1], r[2], r[3]]),
  [
    ["NBA", "MONEYLINE", "FULL_GAME"],
    ["NFL", "MONEYLINE", "FULL_GAME"],
    ["MLB", "MONEYLINE", "FULL_GAME"],
  ]
);

// =====================================================================
// 2. Pricing - the real preview action over parsed lines
// =====================================================================
type Book = OddsGame["bookmakers"][number];
const live = fixture("odds-api-event-nhl-3way-response.json"); // Vegas Golden Knights @ Minnesota Wild
// The 2-way market every game carries, at prices that match no 3-way price.
const twoWay = (home: string, away: string): Book["markets"][number] => ({
  key: "h2h",
  outcomes: [
    { name: home, price: -125 },
    { name: away, price: 105 },
  ],
});
const wild: OddsGame = {
  id: live.id,
  sportKey: live.sport_key,
  homeTeam: live.home_team,
  awayTeam: live.away_team,
  commenceTime: at(9),
  bookmakers: (live.bookmakers as Book[]).map((b) => ({ ...b, markets: [twoWay(live.home_team, live.away_team), ...b.markets] })),
};
// A game the feed has no 3-way market for - only the ordinary moneyline.
const bruins: OddsGame = {
  id: "nhlTwoWayOnly",
  sportKey: "icehockey_nhl",
  homeTeam: "Boston Bruins",
  awayTeam: "Washington Capitals",
  commenceTime: at(8),
  bookmakers: [{ key: "draftkings", title: "DraftKings", markets: [twoWay("Boston Bruins", "Washington Capitals")] }],
};

(prisma.oddsSnapshot as unknown as { findUnique: (args: unknown) => Promise<unknown> }).findUnique = async (args: unknown) => {
  const { sportKey, fetchDate } = (args as { where: { sportKey_fetchDate: { sportKey: string; fetchDate: string } } }).where
    .sportKey_fetchDate;
  const data = sportKey === "icehockey_nhl" ? [wild, bruins] : null;
  return data ? { id: "snap-" + sportKey, sportKey, fetchDate, data, createdAt: new Date(base), updatedAt: new Date(base) } : null;
};
(prisma.user as unknown as { findUnique: (args: unknown) => Promise<unknown> }).findUnique = async () => ({
  id: "user-nhl-3way-test",
  supabaseId: "dev-local-bypass",
  email: "dev-local@bettingview.test",
  name: "Local Dev Test User",
});
let oddsApiCalls = 0;
globalThis.fetch = (async (input: unknown) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("the-odds-api.com")) oddsApiCalls++;
  return new Response(JSON.stringify({ events: [], dates: [] }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const PRICED_LINES = [
  "Wild 3-way ML", // home
  "Golden Knights regulation ML", // away
  "Wild Golden Knights draw", // draw
  "Wild 60 min ML", // home, another wording
  "Wild ML", // plain 2-way
  "Bruins regulation ML", // no 3-way market on this game
  "Bruins Capitals draw", // no 3-way market on this game
  "Bruins ML", // plain 2-way
  "Wild 3-way ML +155", // capper's own price
];

// GameResult rows for grading, built from saved ESPN summary responses the
// same way parseEspnLinescores does (per-period displayValue, overtime and
// shootout entries left on the end).
function espnGame(name: string) {
  const competitors = fixture(name).header.competitions[0].competitors as {
    homeAway: string;
    score: string;
    team: { displayName: string };
    linescores: { displayValue: string }[];
  }[];
  const home = competitors.find((c) => c.homeAway === "home")!;
  const away = competitors.find((c) => c.homeAway === "away")!;
  return {
    homeTeam: home.team.displayName,
    awayTeam: away.team.displayName,
    homeScore: parseInt(home.score, 10),
    awayScore: parseInt(away.score, 10),
    firstFiveHomeScore: null,
    firstFiveAwayScore: null,
    firstInningHomeScore: null,
    firstInningAwayScore: null,
    linescoreJson: home.linescores.map((l, i) => ({ home: parseFloat(l.displayValue), away: parseFloat(away.linescores[i].displayValue) })),
  };
}
type Game = ReturnType<typeof espnGame>;
type Side = "HOME" | "AWAY" | "DRAW" | null;
function grade(game: Game, betDetail: string, period: string, pickedSide: Side) {
  return resolveOutcome({ betType: "MONEYLINE", period, betDetail, homeTeam: game.homeTeam, line: null, pickedSide: pickedSide as never }, game as never);
}

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const react = require("react") as { cache?: unknown };
  react.cache ??= <T,>(fn: T) => fn;
  const { previewBulkImportMatches } = await import("@/server/actions/bulk-picks");

  const items = parse(PRICED_LINES);
  expect("pricing: all nine lines parsed", items.length, PRICED_LINES.length);
  const preview = await previewBulkImportMatches(items as never);
  const storedAs = (i: number) => resolvePickPrice(items[i], preview.odds[i] ?? null);
  expect("pricing: every line without a stated price matched its game", items.filter((it, i) => !it.hasExplicitOdds && !preview.games[i]).length, 0);

  expect("pricing: 3-way home -> the h2h_3_way home price, not the 2-way -125", storedAs(0), { odds: 140, oddsSource: "MARKET" });
  expect("pricing: 3-way away -> the h2h_3_way away price, not the 2-way +105", storedAs(1), { odds: 140, oddsSource: "MARKET" });
  expect("pricing: draw -> the h2h_3_way Draw price", storedAs(2), { odds: 300, oddsSource: "MARKET" });
  expect("pricing: '60 min' wording prices the same way", storedAs(3), { odds: 140, oddsSource: "MARKET" });
  expect("pricing: plain 'Wild ML' is still the 2-way price", storedAs(4), { odds: -125, oddsSource: "MARKET" });
  expect("pricing: no h2h_3_way on the game -> DEFAULTED, never the 2-way price", storedAs(5), { odds: -110, oddsSource: "DEFAULTED" });
  expect("pricing: a draw with no h2h_3_way on the game -> DEFAULTED", storedAs(6), { odds: -110, oddsSource: "DEFAULTED" });
  expect("pricing: plain 'Bruins ML' on that same game is still the 2-way price", storedAs(7), { odds: -125, oddsSource: "MARKET" });
  expect("pricing: a stated price is never sent to the feed lookup", preview.odds[8], undefined);
  expect("pricing: stated +155 is kept over the feed's +140", resolvePickPrice(items[8], 140), { odds: 155, oddsSource: "STATED" });
  expect("pricing: the Odds API was never called by an import", oddsApiCalls, 0);

  // =====================================================================
  // 3. Grading
  // =====================================================================
  // 3a. Regulation win: Pittsburgh 3 @ Buffalo 1, decided in 60 minutes.
  const regWin = espnGame("nhl-boxscore-401879457-pit-buf.json");
  expect("regulation win: the game (away won 3-1, three periods)", [regWin.homeScore, regWin.awayScore, regWin.linescoreJson.length], [1, 3, 3]);
  expect("regulation win: 3-way on the winner wins", grade(regWin, "Penguins 3-way ML", "REGULATION", "AWAY"), "WIN");
  expect("regulation win: 3-way on the loser loses", grade(regWin, "Sabres regulation ML", "REGULATION", "HOME"), "LOSS");
  expect("regulation win: the draw loses", grade(regWin, "Penguins Sabres draw", "REGULATION", "DRAW"), "LOSS");

  // 3b. Overtime win: level 2-2 after three periods, home scores in OT (3-2).
  const otWin: Game = {
    ...regWin,
    homeScore: 3,
    awayScore: 2,
    linescoreJson: [
      { home: 1, away: 0 },
      { home: 0, away: 1 },
      { home: 1, away: 1 },
      { home: 1, away: 0 },
    ],
  };
  expect("OT win: the plain 2-way moneyline on the OT winner still wins", grade(otWin, "Sabres ML", "FULL_GAME", "HOME"), "WIN");
  expect("OT win: the 3-way bet on that same team LOSES", grade(otWin, "Sabres 3-way ML", "REGULATION", "HOME"), "LOSS");
  expect("OT win: the 3-way bet on the other team loses too", grade(otWin, "Penguins reg ML", "REGULATION", "AWAY"), "LOSS");
  expect("OT win: the draw wins", grade(otWin, "Penguins Sabres draw", "REGULATION", "DRAW"), "WIN");

  // 3c. Level after regulation, decided in a shootout: real Washington @
  //     Boston final (2-2 after three, Boston 3-2 in the shootout).
  const shootout = espnGame("nhl-boxscore-401879358-wsh-bos-shootout.json");
  expect("tie after regulation: the game (home 3-2 final, five linescore entries)", [shootout.homeScore, shootout.awayScore, shootout.linescoreJson.length], [3, 2, 5]);
  expect("tie after regulation: the draw wins", grade(shootout, "Bruins Capitals draw", "REGULATION", "DRAW"), "WIN");
  expect("tie after regulation: the shootout winner's 3-way bet loses", grade(shootout, "Bruins 60 min ML", "REGULATION", "HOME"), "LOSS");
  expect("tie after regulation: the other team's 3-way bet loses", grade(shootout, "Capitals regulation ML", "REGULATION", "AWAY"), "LOSS");
  expect("tie after regulation: the plain 2-way moneyline still grades on the final score", grade(shootout, "Bruins ML", "FULL_GAME", "HOME"), "WIN");

  // 3d. A row with no stored side (a parlay leg has none) is read from its text.
  expect("no stored side: a draw leg is read from its wording", grade(shootout, "Bruins Capitals draw", "REGULATION", null), "WIN");
  expect("no stored side: a team leg resolves its team from the text", [grade(regWin, "Penguins 3-way ML", "REGULATION", null), grade(otWin, "Sabres 3-way ML", "REGULATION", null)], ["WIN", "LOSS"]);

  // 3e. No regulation score -> stays PENDING, never graded off the final.
  expect("no linescore: stays PENDING", grade({ ...regWin, linescoreJson: null as never }, "Penguins 3-way ML", "REGULATION", "AWAY"), null);
  expect("two periods only: stays PENDING", grade({ ...regWin, linescoreJson: regWin.linescoreJson.slice(0, 2) }, "Penguins 3-way ML", "REGULATION", "AWAY"), null);

  // 3f. An existing row - 3-way wording stored as a full-game moneyline before
  //     this change - is graded exactly as it was.
  expect("existing FULL_GAME row with 3-way wording: unchanged (graded on the final score)", grade(otWin, "Sabres 3-way ML", "FULL_GAME", "HOME"), "WIN");

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
