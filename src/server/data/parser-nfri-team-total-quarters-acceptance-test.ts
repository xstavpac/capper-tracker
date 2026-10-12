// NRFI typos, team totals and first-quarter picks, import through grading -
// run with:
//   npx tsx src/server/data/parser-nfri-team-total-quarters-acceptance-test.ts
//
// No test framework in this repo (see grading-correctness-acceptance-test.ts).
// console.logs PASS/FAIL, exits non-zero on any failure.
//
// Three production picks that were stored and graded as the wrong bet:
//   1. "Marlins Royals NFRI" - a transposed NRFI, stored as a MONEYLINE.
//   2. "Astros team total over 3.5" - stored as the game TOTAL.
//   3. "UNLV vs Hawaii over 13.5 first quarter" and "Louisville vs Ole Miss
//      Over 12.5 First Quarter" - stored FULL_GAME, graded on the final score.
// (2) and (3) were already read correctly by the importer when this file was
// written (Team Total and quarter grading both landed after those rows); they
// are pinned here, and the forms around them that were still wrong are fixed:
// "team-total" / "team totals" / "TTO 3.5", "1st Q" / "1QTR" / "1st quater",
// and the unknown-team recovery path, which stored every pick as a full-game
// TOTAL.

import { resolveOutcome } from "./grading";
import { parseCatalog, parsePickText } from "@/lib/parse-catalog";
import { recoverUnresolvedLines } from "@/lib/recover-unresolved-lines";
import { parseFallbackBetText } from "@/lib/live-team-fallback";
import { betScope, extractLine, nrfiSide, totalSideFromText } from "@/lib/bet-line";
import type { GameResult } from "@prisma/client";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

// One catalog line under a known capper, as [sport, betType, period, stored
// text, teams, line] - exactly one pick expected.
function imported(line: string): unknown[] {
  const out = parseCatalog("Test Capper\n" + line, ["Test Capper"]);
  if (out.picks.length !== 1 || out.unresolved.length > 0 || out.parlays.length > 0) {
    return ["NOT ONE PICK", out.picks.length, out.unresolved, out.parlays.length];
  }
  const p = out.picks[0];
  return [p.sportName, p.betType, p.period, p.description, p.teamNicknames, extractLine(p.betType, p.description)];
}

// The same line, graded against a finished game the way the grader would
// grade the row the importer stores.
function gradeImported(line: string, game: GameResult, pickedSide: "HOME" | "AWAY" | null = null) {
  const p = parseCatalog("Test Capper\n" + line, ["Test Capper"]).picks[0];
  return resolveOutcome(
    { betType: p.betType, period: p.period, betDetail: p.description, homeTeam: game.homeTeam, line: null, pickedSide },
    game
  );
}

// ============================================================
// PART 1 - NRFI / YRFI typos
// ============================================================
console.log("\n########## PART 1: NRFI / YRFI typos ##########");

check("production: 'Marlins Royals NFRI' is an NRFI pick, stored spelled NRFI", imported("Marlins Royals NFRI"), [
  "MLB",
  "NRFI",
  "FULL_GAME",
  "Marlins Royals NRFI",
  ["marlins", "royals"],
  null,
]);
for (const [typed, stored] of [
  ["NRIF", "NRFI"],
  ["NFIR", "NRFI"],
  ["nfri", "NRFI"],
  ["YFRI", "YRFI"],
  ["YRIF", "YRFI"],
  ["YFIR", "YRFI"],
]) {
  check(`'Marlins Royals ${typed}' -> NRFI bet type, stored as ${stored}`, imported(`Marlins Royals ${typed}`), [
    "MLB",
    "NRFI",
    "FULL_GAME",
    `Marlins Royals ${stored}`,
    ["marlins", "royals"],
    null,
  ]);
}
check("one team, typo, a price: 'Marlins NFRI -120'", imported("Marlins NFRI -120"), ["MLB", "NRFI", "FULL_GAME", "Marlins NRFI", ["marlins"], null]);
check("typo first: 'NFRI Marlins Royals'", imported("NFRI Marlins Royals"), ["MLB", "NRFI", "FULL_GAME", "NRFI Marlins Royals", ["marlins", "royals"], null]);
check("parsePickText alone reads the typo too", [parsePickText("Marlins Royals NFRI").betType, parsePickText("Marlins Royals YFRI").cleanDescription], [
  "NRFI",
  "Marlins Royals YRFI",
]);

// The side is re-read from the text at grading time.
check("nrfiSide: typo text names its side", [nrfiSide("Marlins Royals NFRI"), nrfiSide("Marlins Royals NRIF"), nrfiSide("Marlins Royals YFRI"), nrfiSide("Marlins Royals YFIR")], [
  "NO_RUN",
  "NO_RUN",
  "YES_RUN",
  "YES_RUN",
]);

// Royals (home) 5, Marlins (away) 2; a scoreless first inning.
const MARLINS_ROYALS = {
  homeTeam: "Kansas City Royals",
  awayTeam: "Miami Marlins",
  homeScore: 5,
  awayScore: 2,
  firstFiveHomeScore: 2,
  firstFiveAwayScore: 1,
  firstInningHomeScore: 0,
  firstInningAwayScore: 0,
  linescoreJson: null,
} as unknown as GameResult;
const RUN_IN_FIRST = { ...MARLINS_ROYALS, firstInningAwayScore: 1 } as GameResult;

check("'Marlins Royals NFRI' grades on the first inning: scoreless -> WIN", gradeImported("Marlins Royals NFRI", MARLINS_ROYALS), "WIN");
check("'Marlins Royals NFRI': a run in the first -> LOSS", gradeImported("Marlins Royals NFRI", RUN_IN_FIRST), "LOSS");
check("'Marlins Royals YFRI': scoreless -> LOSS", gradeImported("Marlins Royals YFRI", MARLINS_ROYALS), "LOSS");
check("'Marlins Royals YFRI': a run in the first -> WIN", gradeImported("Marlins Royals YFRI", RUN_IN_FIRST), "WIN");

console.log("\n-- unchanged --");
check("'Marlins Royals NRFI'", imported("Marlins Royals NRFI"), ["MLB", "NRFI", "FULL_GAME", "Marlins Royals NRFI", ["marlins", "royals"], null]);
check("'Marlins Royals YRFI (+105)'", imported("Marlins Royals YRFI (+105)"), ["MLB", "NRFI", "FULL_GAME", "Marlins Royals YRFI", ["marlins", "royals"], null]);
check("'Marlins Royals no run first inning'", imported("Marlins Royals no run first inning"), [
  "MLB",
  "NRFI",
  "FULL_GAME",
  "Marlins Royals no run first inning",
  ["marlins", "royals"],
  null,
]);
check("nrfiSide: NRFI / YRFI / 'no run' / 'yes run'", [nrfiSide("Yankees NRFI"), nrfiSide("Yankees YRFI"), nrfiSide("no run 1st"), nrfiSide("yes run first inning")], [
  "NO_RUN",
  "YES_RUN",
  "NO_RUN",
  "YES_RUN",
]);
check("a plain moneyline is still a moneyline", imported("Marlins ML"), ["MLB", "MONEYLINE", "FULL_GAME", "Marlins ML", ["marlins"], null]);
check("a two-team line with no market is still the MONEYLINE default", imported("Marlins Royals")[1], "MONEYLINE");

// ============================================================
// PART 2 - team totals
// ============================================================
console.log("\n########## PART 2: team totals ##########");

check("production: 'Astros team total over 3.5' is a TEAM_TOTAL on the Astros", imported("Astros team total over 3.5"), [
  "MLB",
  "TEAM_TOTAL",
  "FULL_GAME",
  "Astros team total over 3.5",
  ["astros"],
  3.5,
]);
for (const [line, sport, team, n] of [
  ["Astros TT over 3.5", "MLB", "astros", 3.5],
  ["Astros tt under 3.5", "MLB", "astros", 3.5],
  ["Astros tt o3.5", "MLB", "astros", 3.5],
  ["Astros Team Total: Over 3.5", "MLB", "astros", 3.5],
  ["Astros team-total over 3.5", "MLB", "astros", 3.5],
  ["Astros team totals under 3.5", "MLB", "astros", 3.5],
  ["Chiefs TT over 24.5", "NFL", "chiefs", 24.5],
  ["Lakers team total under 110.5", "NBA", "lakers", 110.5],
  ["Bruins TT o2.5", "NHL", "bruins", 2.5],
  ["Aces TT under 85.5", "WNBA", "aces", 85.5],
  ["Alabama team total over 31.5", "NCAAF", "alabama", 31.5],
] as const) {
  check(`'${line}' -> ${sport} TEAM_TOTAL`, imported(line), [sport, "TEAM_TOTAL", "FULL_GAME", line, [team], n]);
}
check("'Astros TTO 3.5' -> team total over, side spelled out in the stored text", imported("Astros TTO 3.5"), [
  "MLB",
  "TEAM_TOTAL",
  "FULL_GAME",
  "Astros TT over 3.5",
  ["astros"],
  3.5,
]);
check("'Astros TTU3.5' -> team total under", imported("Astros TTU3.5"), ["MLB", "TEAM_TOTAL", "FULL_GAME", "Astros TT under 3.5", ["astros"], 3.5]);
check("the side reads back from that stored text", [totalSideFromText("Astros TT over 3.5"), totalSideFromText("Astros TT under 3.5")], ["OVER", "UNDER"]);
check("a team total keeps its period: 'Chiefs team total over 13.5 1H'", imported("Chiefs team total over 13.5 1H"), [
  "NFL",
  "TEAM_TOTAL",
  "FIRST_HALF",
  "Chiefs team total over 13.5 1H",
  ["chiefs"],
  13.5,
]);

// Astros (home) 4, Rangers (away) 6: the Astros alone clear 3.5, and so does
// the game. Astros (home) 3, Rangers 6: the game clears 3.5, the Astros don't.
const ASTROS_4 = {
  homeTeam: "Houston Astros",
  awayTeam: "Texas Rangers",
  homeScore: 4,
  awayScore: 6,
  firstFiveHomeScore: 1,
  firstFiveAwayScore: 2,
  firstInningHomeScore: 0,
  firstInningAwayScore: 0,
  linescoreJson: null,
} as unknown as GameResult;
const ASTROS_3 = { ...ASTROS_4, homeScore: 3 } as GameResult;
check("'Astros team total over 3.5': Astros score 4 -> WIN", gradeImported("Astros team total over 3.5", ASTROS_4, "HOME"), "WIN");
check("'Astros team total over 3.5': Astros score 3 in a 9-run game -> LOSS, not the game total's WIN", gradeImported("Astros team total over 3.5", ASTROS_3, "HOME"), "LOSS");
check("'Astros team-total over 3.5': Astros score 3 -> LOSS", gradeImported("Astros team-total over 3.5", ASTROS_3, "HOME"), "LOSS");
check("'Astros TTO 3.5': Astros score 3 -> LOSS", gradeImported("Astros TTO 3.5", ASTROS_3, "HOME"), "LOSS");
check("'Astros TTU 3.5': Astros score 3 -> WIN", gradeImported("Astros TTU 3.5", ASTROS_3, "HOME"), "WIN");

console.log("\n-- unchanged --");
check("'Astros over 8.5' is still the game TOTAL", imported("Astros over 8.5"), ["MLB", "TOTAL", "FULL_GAME", "Astros over 8.5", ["astros"], 8.5]);
check("'Dodgers/Padres Over 8.5' is still the game TOTAL", imported("Dodgers/Padres Over 8.5")[1], "TOTAL");
check("'Chiefs vs Bills over 44.5' is still a full-game TOTAL", imported("Chiefs vs Bills over 44.5"), [
  "NFL",
  "TOTAL",
  "FULL_GAME",
  "Chiefs vs Bills over 44.5",
  ["chiefs", "bills"],
  44.5,
]);
check("'Astros over 8.5' grades on both teams: 9 runs -> WIN", gradeImported("Astros over 8.5", ASTROS_3, "HOME"), "WIN");
check("a name containing 'tt' is not a team total: 'Matt Olson over 1.5 hits'", parsePickText("Matt Olson over 1.5 hits").betType === "TEAM_TOTAL", false);

// ============================================================
// PART 3 - first quarter
// ============================================================
console.log("\n########## PART 3: first-quarter picks ##########");

check("production: 'UNLV vs Hawaii over 13.5 first quarter'", imported("UNLV vs Hawaii over 13.5 first quarter"), [
  "NCAAF",
  "TOTAL",
  "FIRST_QUARTER",
  "UNLV vs Hawaii over 13.5 first quarter",
  ["hawaii", "unlv"],
  13.5,
]);
check("production: 'Louisville vs Ole Miss Over 12.5 First Quarter'", imported("Louisville vs Ole Miss Over 12.5 First Quarter"), [
  "NCAAF",
  "TOTAL",
  "FIRST_QUARTER",
  "Louisville vs Ole Miss Over 12.5 First Quarter",
  ["louisville", "ole miss"],
  12.5,
]);
for (const form of ["1Q", "1st quarter", "Q1", "first qtr", "1st qtr", "1st Q", "first Q", "1QTR", "1 qtr", "quarter 1", "1st-quarter", "1st quater", "First Quater"]) {
  const line = `Chiefs vs Bills over 9.5 ${form}`;
  check(`'${line}' -> FIRST_QUARTER`, [imported(line)[2], betScope(line)], ["FIRST_QUARTER", "FIRST_QUARTER"]);
}
check("other quarters, same forms", [betScope("under 10.5 2nd Q"), betScope("over 9.5 3QTR"), betScope("Lakers -1.5 4th quater")], [
  "SECOND_QUARTER",
  "THIRD_QUARTER",
  "FOURTH_QUARTER",
]);
check("NFL / NBA: 'Chiefs 1Q -0.5', 'Lakers 1st Q ML', 'Lakers Q1 over 55.5'", [imported("Chiefs 1Q -0.5"), imported("Lakers 1st Q ML"), imported("Lakers Q1 over 55.5")], [
  ["NFL", "SPREAD", "FIRST_QUARTER", "Chiefs 1Q -0.5", ["chiefs"], -0.5],
  ["NBA", "MONEYLINE", "FIRST_QUARTER", "Lakers 1st Q ML", ["lakers"], null],
  ["NBA", "TOTAL", "FIRST_QUARTER", "Lakers Q1 over 55.5", ["lakers"], 55.5],
]);

// UNLV Rebels @ Hawai'i Rainbow Warriors (grading-segment-scope-acceptance-test.ts):
// final 21-6 (27), first quarter 7-0 (7). Over 13.5 wins on the game, loses
// on the quarter.
const UNLV_HAWAII = {
  homeTeam: "Hawai'i Rainbow Warriors",
  awayTeam: "UNLV Rebels",
  homeScore: 6,
  awayScore: 21,
  firstFiveHomeScore: 3,
  firstFiveAwayScore: 14,
  firstInningHomeScore: null,
  firstInningAwayScore: null,
  linescoreJson: [
    { home: 0, away: 7 },
    { home: 3, away: 7 },
    { home: 3, away: 0 },
    { home: 0, away: 7 },
  ],
} as unknown as GameResult;
const NO_LINESCORE = { ...UNLV_HAWAII, linescoreJson: null } as unknown as GameResult;

check("'UNLV vs Hawaii over 13.5 first quarter': 7 in the quarter -> LOSS, not the game's WIN", gradeImported("UNLV vs Hawaii over 13.5 first quarter", UNLV_HAWAII), "LOSS");
for (const form of ["1st Q", "1QTR", "1st quater", "1Q", "first qtr"]) {
  check(`'UNLV vs Hawaii over 13.5 ${form}' grades on the quarter -> LOSS`, gradeImported(`UNLV vs Hawaii over 13.5 ${form}`, UNLV_HAWAII), "LOSS");
}
check("no quarter scores for the game -> stays pending, never the full game", gradeImported("UNLV vs Hawaii over 13.5 1st Q", NO_LINESCORE), null);
check(
  "a row stored FULL_GAME whose text names a quarter stays pending",
  resolveOutcome({ betType: "TOTAL", period: "FULL_GAME", betDetail: "UNLV vs Hawaii over 13.5 1st Q", homeTeam: UNLV_HAWAII.homeTeam, line: null }, UNLV_HAWAII),
  null
);

console.log("\n-- unchanged --");
check("'UNLV vs Hawaii over 44.5' is a full-game total", imported("UNLV vs Hawaii over 44.5")[2], "FULL_GAME");
check("first half: 'Chiefs vs Bills over 22.5 1H', 'Chiefs -3 1H', 'Chiefs 1st half ML'", [imported("Chiefs vs Bills over 22.5 1H")[2], imported("Chiefs -3 1H")[2], imported("Chiefs 1st half ML")[2]], [
  "FIRST_HALF",
  "FIRST_HALF",
  "FIRST_HALF",
]);
check("F5: 'Astros F5 ML'", imported("Astros F5 ML")[2], "FIRST_HALF");
check("'UNLV vs Hawaii over 13.5 1H' grades on the half: 17 -> WIN", gradeImported("UNLV vs Hawaii over 13.5 1H", UNLV_HAWAII), "WIN");
check("'UNLV vs Hawaii over 26.5' grades on the game: 27 -> WIN", gradeImported("UNLV vs Hawaii over 26.5", UNLV_HAWAII), "WIN");
check("a line's own number is not a quarter: 'Chiefs -1 quarter', 'Chiefs +1 qtr', 'over 41 qtr'", [betScope("Chiefs -1 quarter"), betScope("Chiefs +1 qtr"), betScope("over 41 qtr")], [
  "FULL_GAME",
  "FULL_GAME",
  "FULL_GAME",
]);
check("a quarterback is not a quarter: 'first QB to throw a TD'", betScope("first QB to throw a TD"), "FULL_GAME");
check("NHL periods still read: 'Bruins 1st period ML'", betScope("Bruins 1st period ML"), "FIRST_PERIOD");

// ============================================================
// PART 4 - the unknown-team recovery path
// ============================================================
console.log("\n########## PART 4: recovery path (teams known only from the live feed) ##########");

// VMI and Furman are FCS schools the hand-kept list doesn't carry, so the
// main parser leaves these lines unresolved and recoverUnresolvedLines
// resolves them against the live feed.
const LIVE = [
  { sport: "NCAAF", name: "VMI Keydets" },
  { sport: "NCAAF", name: "Furman Paladins" },
];
function recovered(line: string) {
  const out = parseCatalog("Test Capper\n" + line, ["Test Capper"]);
  const rec = recoverUnresolvedLines(out.unresolved, out.unresolvedCapperNames, LIVE, [], out.picks);
  return [out.picks.length, rec.recovered.map((p) => [p.sportName, p.betType, p.period, p.description, p.teamNicknames]), rec.stillUnresolved];
}
check("'VMI team total over 20.5' -> TEAM_TOTAL on VMI", recovered("VMI team total over 20.5"), [
  0,
  [["NCAAF", "TEAM_TOTAL", "FULL_GAME", "VMI team total over 20.5", ["vmi keydets"]]],
  [],
]);
check("'VMI TTO 20.5' -> TEAM_TOTAL, side spelled out", recovered("VMI TTO 20.5"), [0, [["NCAAF", "TEAM_TOTAL", "FULL_GAME", "VMI TT over 20.5", ["vmi keydets"]]], []]);
check("'VMI over 13.5 first quarter' -> FIRST_QUARTER", recovered("VMI over 13.5 first quarter"), [
  0,
  [["NCAAF", "TOTAL", "FIRST_QUARTER", "VMI over 13.5 first quarter", ["vmi keydets"]]],
  [],
]);
check("'VMI +3.5 1H' -> FIRST_HALF", recovered("VMI +3.5 1H"), [0, [["NCAAF", "SPREAD", "FIRST_HALF", "VMI +3.5 1H", ["vmi keydets"]]], []]);
console.log("\n-- unchanged --");
check("'VMI over 44.5' -> full-game TOTAL", recovered("VMI over 44.5"), [0, [["NCAAF", "TOTAL", "FULL_GAME", "VMI over 44.5", ["vmi keydets"]]], []]);
check("'VMI +21.5' -> full-game SPREAD", recovered("VMI +21.5"), [0, [["NCAAF", "SPREAD", "FULL_GAME", "VMI +21.5", ["vmi keydets"]]], []]);
check("parseFallbackBetText: 'Wofford over 44.5 (2u)' is still TOTAL over", [parseFallbackBetText("Wofford over 44.5 (2u)").betType, parseFallbackBetText("Wofford over 44.5 (2u)").totalSide], [
  "TOTAL",
  "over",
]);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
