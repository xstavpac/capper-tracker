// NHL "1P"/"2P"/"3P" period shorthand, read at import and at grading.
//
// The bare shorthand is a hockey period only in the NHL ("3P" is a basketball
// three-pointers prop), so bet-line's betScope reads it only when the caller
// passes sport "NHL". Before this change every import path called it with no
// sport at all, and "Colorado Avalanche over 1.5 1P" was stored FULL_GAME and
// graded off the full-game score.
//
//   PART A  betScope itself: NHL only; no sport / other sports unchanged.
//   PART B  one NHL "1P" line per import call-site family -> FIRST_PERIOD.
//   PART C  an ambiguous team / NBA-or-NHL player: answered NHL -> FIRST_PERIOD,
//           answered anything else -> unresolvedReason (the unresolved list),
//           never a FULL_GAME pick.
//   PART D  unchanged: an NBA "3P" prop, a full-game NHL total.
//   PART E  grading on a real NHL linescore (Calgary @ Seattle, 2026 regular
//           season, ESPN 401891824): a FIRST_PERIOD pick grades off period 1;
//           a legacy FULL_GAME row whose text says "1P" stays PENDING.
//
// Pure: fixtures only, no database, no network. Run with:
//   npx tsx src/server/data/nhl-period-shorthand-acceptance-test.ts
import fs from "node:fs";
import path from "node:path";
import { betScope, betScopeToken, pickPeriodFromText } from "@/lib/bet-line";
import { parseCatalog, resolveAmbiguousPick, PERIOD_SHORTHAND_OUTSIDE_NHL_REASON, type ParsedPick } from "@/lib/parse-catalog";
import { recoverUnresolvedLines } from "@/lib/recover-unresolved-lines";
import { narrowAmbiguousByLeague, filterPicksByLeague } from "@/lib/ingest-filters";
import { resolveOutcome } from "./grading";
import type { RosterPlayer } from "./nfl-roster";
import type { GameResult, Period } from "@prisma/client";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

const fixture = (name: string): RosterPlayer[] => JSON.parse(fs.readFileSync(path.join(__dirname, "__fixtures__", name), "utf8"));
const NBA = fixture("nba-league-roster-2026-10-13.json");
const NHL = fixture("nhl-league-roster-2026-10-13.json");

const shape = (p: ParsedPick | undefined) => (p ? [p.sportName, p.betType, p.period, p.description] : null);
const parse = (text: string, known: string[] = ["Cap"]) => parseCatalog(text, known);

// =====================================================================
// PART A - betScope
// =====================================================================
console.log("---- PART A: betScope ----");
check("NHL: 1P / 2P / 3P", ["over 1.5 1P", "under 2.5 2p", "Avs ML 3P"].map((t) => betScope(t, "NHL")), ["FIRST_PERIOD", "SECOND_PERIOD", "THIRD_PERIOD"]);
check("no sport: exactly as before (FULL_GAME)", ["over 1.5 1P", "under 2.5 2p", "Avs ML 3P"].map((t) => betScope(t)), ["FULL_GAME", "FULL_GAME", "FULL_GAME"]);
check("NBA / NFL / null: FULL_GAME", [betScope("Curry over 4.5 3P", "NBA"), betScope("Chiefs 1P", "NFL"), betScope("over 1.5 1P", null)], ["FULL_GAME", "FULL_GAME", "FULL_GAME"]);
check("NHL: a rule the sport-blind list already has still wins ('1st period')", betScope("over 1.5 1st period", "NHL"), "FIRST_PERIOD");
check("NHL: a line's own number is not a period ('+1.5', '31p' do not read)", [betScope("Avs +1.5", "NHL"), betScope("over 31p", "NHL")], ["FULL_GAME", "FULL_GAME"]);
check("betScopeToken: NHL carries '1P', no sport does not", [betScopeToken("1P", "NHL"), betScopeToken("1P")], ["1P", null]);
check("pickPeriodFromText follows the sport", [pickPeriodFromText("over 1.5 1P", "NHL"), pickPeriodFromText("over 1.5 1P")], ["FIRST_PERIOD", "FULL_GAME"]);

// =====================================================================
// PART B - every import call-site family
// =====================================================================
console.log("---- PART B: import paths ----");
const nhl1p = (desc: string) => ["NHL", "TOTAL", "FIRST_PERIOD", desc];

check("the two production lines (sport from the team name)", parse("Cap\nColorado Avalanche over 1.5 1P\nPittsburgh Penguins over 1.5 1P").picks.map(shape), [
  nhl1p("Colorado Avalanche over 1.5 1P"),
  nhl1p("Pittsburgh Penguins over 1.5 1P"),
]);
check("catalog with a header: capper header + NHL league sub-header", shape(parse("Cap\nNHL\nColorado Avalanche over 1.5 1P").picks[0]), nhl1p("Colorado Avalanche over 1.5 1P"));
check("catalog without a header line above (capper on the line, 'Cap: ...')", shape(parse("Other\nCap: Pittsburgh Penguins over 1.5 1P", ["Cap", "Other"]).picks[0]), nhl1p("Pittsburgh Penguins over 1.5 1P"));
check("inline capper ('Cap - ...')", shape(parse("Cap - Colorado Avalanche over 1.5 1P").picks[0]), nhl1p("Colorado Avalanche over 1.5 1P"));
check("a parenthetical '(1P)' is carried into the stored text", shape(parse("Cap\nPittsburgh Penguins over 1.5 (1P)").picks[0]), nhl1p("Pittsburgh Penguins over 1.5 1P"));
check("team pair (an ambiguous 'Panthers' settled by 'Penguins')", shape(parse("Cap\nPanthers/Penguins under 1.5 1P").picks[0]), ["NHL", "TOTAL", "FIRST_PERIOD", "Panthers/Penguins under 1.5 1P"]);
check(
  "parlay legs (MLP)",
  parse("Cap\nNHL Avalanche ML 1P + Penguins ML 1P mlp").parlays[0]?.legs.map((l) => [l.sportName, l.period, l.description]),
  [
    ["NHL", "FIRST_PERIOD", "Avalanche ML 1P"],
    ["NHL", "FIRST_PERIOD", "Penguins ML 1P"],
  ]
);
{
  const rec = recoverUnresolvedLines(["Colorado Avalanche over 1.5 1P"], ["Cap"], [{ sport: "NHL", name: "Colorado Avalanche" }] as never, []);
  check("recovery: live-schedule team fallback", rec.recovered.map(shape), [nhl1p("Colorado Avalanche over 1.5 1P")]);
}
{
  const p = parse("Cap\nCale Makar over 0.5 points 1P", []);
  const rec = recoverUnresolvedLines(p.unresolved, p.unresolvedCapperNames, [], [], p.picks, NHL, [], [], NBA, p.unresolvedLeagues);
  check("recovery: NHL roster player prop", rec.recovered.map((r) => [r.sportName, r.period, r.description]), [["NHL", "FIRST_PERIOD", "Cale Makar over 0.5 points 1P"]]);
}
{
  // Telegram ingest runs the same parseCatalog + recovery, then its league allowlist filters.
  const direct = filterPicksByLeague(new Set(["NHL"]), parse("Cap\nColorado Avalanche over 1.5 1P").picks);
  check("Telegram ingest: an NHL pick through the league filter", direct.keep.map(shape), [nhl1p("Colorado Avalanche over 1.5 1P")]);
  const narrowed = narrowAmbiguousByLeague(new Set(["NHL"]), parse("Cap\nPanthers over 1.5 1P").picks);
  check("Telegram ingest: an ambiguous 'Panthers' narrowed to NHL by the allowlist", narrowed.keep.map((p) => [p.sportName, p.period, p.unresolvedReason ?? null]), [["NHL", "FIRST_PERIOD", null]]);
  const nfl = narrowAmbiguousByLeague(new Set(["NFL"]), parse("Cap\nPanthers over 1.5 1P").picks);
  check("Telegram ingest: the same line narrowed to NFL is unresolved, not FULL_GAME", nfl.keep.map((p) => p.unresolvedReason), [PERIOD_SHORTHAND_OUTSIDE_NHL_REASON]);
}

// =====================================================================
// PART C - sport unknown until the user answers
// =====================================================================
console.log("---- PART C: ambiguous team / player ----");
{
  const amb = parse("Cap\nPanthers over 1.5 1P").picks[0];
  check("an ambiguous team with 1P is a question, not a stored pick", [amb.sportName, amb.ambiguous?.map((o) => o.sport)], ["", ["NFL", "NHL"]]);
  const nhlOpt = amb.ambiguous!.find((o) => o.sport === "NHL")!;
  const nflOpt = amb.ambiguous!.find((o) => o.sport === "NFL")!;
  const asNhl = resolveAmbiguousPick(amb, nhlOpt);
  check("team: answered NHL -> FIRST_PERIOD", [asNhl.sportName, asNhl.period, asNhl.unresolvedReason ?? null], ["NHL", "FIRST_PERIOD", null]);
  const asNfl = resolveAmbiguousPick(amb, nflOpt);
  check("team: answered NFL -> unresolved with the reason, never a FULL_GAME pick", asNfl.unresolvedReason, PERIOD_SHORTHAND_OUTSIDE_NHL_REASON);
  // A plain full-game ambiguous line is untouched by the rule.
  const plain = parse("Cap\nPanthers ML").picks[0];
  check("team without 1P: answered NFL is a normal pick", resolveAmbiguousPick(plain, plain.ambiguous!.find((o) => o.sport === "NFL")!).unresolvedReason ?? null, null);
}
{
  // Fox: De'Aaron Fox (NBA) and Adam Fox (NHL) - the roster pass asks which league.
  const p = parse("Cap\nFox over 0.5 points (1P)", []);
  const rec = recoverUnresolvedLines(p.unresolved, p.unresolvedCapperNames, [], [], p.picks, NHL, [], [], NBA, p.unresolvedLeagues);
  const q = rec.recovered[0];
  check("player: a name on both rosters asks NBA or NHL", q?.ambiguous?.map((o) => o.sport), ["NBA", "NHL"]);
  const asNhl = resolveAmbiguousPick(q, q.ambiguous!.find((o) => o.sport === "NHL")!);
  check("player: answered NHL -> FIRST_PERIOD, '1P' kept in the text", [asNhl.sportName, asNhl.period, asNhl.description, asNhl.unresolvedReason ?? null], ["NHL", "FIRST_PERIOD", "Fox over 0.5 points 1P", null]);
  const asNba = resolveAmbiguousPick(q, q.ambiguous!.find((o) => o.sport === "NBA")!);
  check("player: answered NBA -> unresolved, never FULL_GAME", asNba.unresolvedReason, PERIOD_SHORTHAND_OUTSIDE_NHL_REASON);
}

// =====================================================================
// PART D - unchanged
// =====================================================================
console.log("---- PART D: unchanged ----");
check("NBA '3P' line with the league named: NBA, FULL_GAME, text untouched", shape(parse("Cap\nNBA Stephen Curry over 4.5 3P").picks[0]), ["NBA", "TOTAL", "FULL_GAME", "Stephen Curry over 4.5 3P"]);
check("NBA '3P' line with no league: still the unresolved list (as before)", parse("Cap\nStephen Curry over 4.5 3P").unresolved, ["Stephen Curry over 4.5 3P"]);
check("full-game NHL 'over 6.5': FULL_GAME", shape(parse("Cap\nColorado Avalanche over 6.5").picks[0]), ["NHL", "TOTAL", "FULL_GAME", "Colorado Avalanche over 6.5"]);

// =====================================================================
// PART E - grading
// =====================================================================
console.log("---- PART E: grading ----");
// Calgary Flames @ Seattle Kraken, final 6-1. Periods (home-away): 3-0, 2-0, 1-1.
const SEA_CGY = {
  sportKey: "icehockey_nhl",
  homeTeam: "Seattle Kraken",
  awayTeam: "Calgary Flames",
  homeScore: 6,
  awayScore: 1,
  firstFiveHomeScore: null,
  firstFiveAwayScore: null,
  firstInningHomeScore: null,
  firstInningAwayScore: null,
  linescoreJson: [
    { home: 3, away: 0 },
    { home: 2, away: 0 },
    { home: 1, away: 1 },
  ],
} as unknown as GameResult;
const grade = (period: Period, betDetail: string, line: number, game = SEA_CGY) =>
  resolveOutcome({ betType: "TOTAL", period, betDetail, homeTeam: game.homeTeam, line, pickedSide: null }, game as never);

check("FIRST_PERIOD 'over 3.5 1P' grades off P1 (3 goals): LOSS", grade("FIRST_PERIOD", "Seattle Kraken over 3.5 1P", 3.5), "LOSS");
check("FIRST_PERIOD 'over 2.5 1P': WIN", grade("FIRST_PERIOD", "Seattle Kraken over 2.5 1P", 2.5), "WIN");
check("THIRD_PERIOD 'under 2.5 3P' (P3 = 2 goals): WIN", grade("THIRD_PERIOD", "Seattle Kraken under 2.5 3P", 2.5), "WIN");
check("full-game 'over 6.5' (7 goals): WIN, unchanged", grade("FULL_GAME", "Seattle Kraken over 6.5", 6.5), "WIN");
check("legacy row stored FULL_GAME with '1P' text: PENDING (null), not graded off the full game", grade("FULL_GAME", "Seattle Kraken over 3.5 1P", 3.5), null);
check(
  "the same legacy row on a game with no sport key reads as before (full game, 7 goals: WIN)",
  grade("FULL_GAME", "Seattle Kraken over 3.5 1P", 3.5, { ...SEA_CGY, sportKey: undefined } as unknown as GameResult),
  "WIN"
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
