// MLB player-prop text parsing + catalog-import behavior. Pure (no DB, no network). Run with:
//   npx tsx src/lib/mlb-prop-parsing-acceptance-test.ts
//
// Covers: every market's shorthand, N+ handling, the scoped-variant guard ("hits allowed", "earned runs",
// "1st inning", "hits+runs+RBIs", batter Ks...), the line ceilings, and how parseCatalog routes MLB prop
// lines - explicit sport -> an MLB PLAYER_PROP pick, sport-less -> `unresolved` for roster recovery,
// never dropped, never a game TOTAL/MONEYLINE, and never touching team totals, NRFI, capper headers or
// the NFL/NHL prop paths.
import {
  parseMlbPlayerProp,
  normalizeMlbNPlus,
  mlbPositionFitsMarket,
  isMlbPaGatedMarket,
  isMlbPitcherMarket,
  type ParsedMlbProp,
} from "@/lib/mlb-prop";
import { parseCatalog, detectUnsupportedPropLine, parseSupportedMlbProp } from "@/lib/parse-catalog";
import { parseAnyPlayerProp, normalizeNPlusPlayerProp } from "@/lib/bet-line";
import { UNSUPPORTED_PROP_REASONS } from "@/lib/unsupported-prop-vocab";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

const shape = (p: ParsedMlbProp | null) => (p ? [p.playerName, p.propMarket, p.line] : null);

// ---- the parser: shorthand per market -------------------------------------------------------------
const PARSE: [string, [string, string, number] | null][] = [
  // pitcher strikeouts
  ["Chris Sale over 5.5 Ks", ["Chris Sale", "STRIKEOUTS", 5.5]],
  ["MLB Chris Sale o5.5 K", ["Chris Sale", "STRIKEOUTS", 5.5]],
  ["Tarik Skubal over 6.5 strikeouts -120", ["Tarik Skubal", "STRIKEOUTS", 6.5]],
  ["Paul Skenes 6+ strikeouts", ["Paul Skenes", "STRIKEOUTS", 5.5]],
  ["Corbin Burnes 5+ K +110", ["Corbin Burnes", "STRIKEOUTS", 4.5]],
  ["Skubal Ks over 6.5", ["Skubal", "STRIKEOUTS", 6.5]],
  ["Tyler Glasnow over 6.5 strikeouts (LAD)", ["Tyler Glasnow", "STRIKEOUTS", 6.5]],
  ["Gerrit Cole u5.5 K", ["Gerrit Cole", "STRIKEOUTS", 5.5]],
  // outs recorded
  ["Logan Webb u17.5 outs recorded", ["Logan Webb", "OUTS_RECORDED", 17.5]],
  ["Schlittler over 17.5 outs", ["Schlittler", "OUTS_RECORDED", 17.5]],
  ["Paul Skenes 18+ outs", ["Paul Skenes", "OUTS_RECORDED", 17.5]],
  // total bases
  ["Aaron Judge over 1.5 total bases", ["Aaron Judge", "TOTAL_BASES", 1.5]],
  ["Bobby Witt Jr. o1.5 TB", ["Bobby Witt Jr.", "TOTAL_BASES", 1.5]],
  ["Shohei Ohtani 2+ total bases", ["Shohei Ohtani", "TOTAL_BASES", 1.5]],
  ["Kyle Tucker 3+ TB", ["Kyle Tucker", "TOTAL_BASES", 2.5]],
  // hits
  ["Juan Soto 1+ hits", ["Juan Soto", "HITS", 0.5]],
  ["Freddie Freeman over 0.5 hits", ["Freddie Freeman", "HITS", 0.5]],
  ["Trea Turner 2+ hits", ["Trea Turner", "HITS", 1.5]],
  // walks
  ["Juan Soto 1+ BB", ["Juan Soto", "WALKS", 0.5]],
  ["Mookie Betts over 0.5 walks", ["Mookie Betts", "WALKS", 0.5]],
  ["Matt Olson o1.5 BB", ["Matt Olson", "WALKS", 1.5]],
  // runs
  ["Kyle Schwarber over 0.5 runs", ["Kyle Schwarber", "RUNS", 0.5]],
  ["Kyle Schwarber 1+ runs scored", ["Kyle Schwarber", "RUNS", 0.5]],
  ["Mookie Betts 2+ runs", ["Mookie Betts", "RUNS", 1.5]],
  // RBIs
  ["Pete Alonso over 0.5 RBIs", ["Pete Alonso", "RBIS", 0.5]],
  ["Pete Alonso 2+ RBI", ["Pete Alonso", "RBIS", 1.5]],
  ["Juan Soto over 1.5 runs batted in", ["Juan Soto", "RBIS", 1.5]],
  // home runs
  ["Aaron Judge 1+ HR", ["Aaron Judge", "HOME_RUNS", 0.5]],
  ["Aaron Judge to hit a home run", ["Aaron Judge", "HOME_RUNS", 0.5]],
  ["Aaron Judge anytime HR", ["Aaron Judge", "HOME_RUNS", 0.5]],
  ["Aaron Judge over 0.5 home runs", ["Aaron Judge", "HOME_RUNS", 0.5]],
  ["Aaron Judge anytime home run -110", ["Aaron Judge", "HOME_RUNS", 0.5]],
  // matchup prefix: matchup words are not part of the name
  ["Yankees vs Red Sox Schlittler over 17.5 outs", ["Yankees Red Sox Schlittler", "OUTS_RECORDED", 17.5]],
  // --- scoped variants and other markets: never the plain market ---
  ["Skenes o3.5 hits allowed", null],
  ["Skenes over 1.5 walks allowed", null],
  ["Skenes under 2.5 earned runs", null],
  ["Skenes o4.5 runs allowed", null],
  ["Mike Trout over 1.5 hits+runs+RBIs", null],
  ["Judge hits + runs + rbis o2.5", null],
  ["Judge H+R+RBI over 2.5", null],
  ["Skenes 1st inning over 0.5 Ks", null],
  ["Skenes first 5 innings over 3.5 Ks", null],
  ["Skenes F5 over 3.5 strikeouts", null],
  ["Judge first home run", null],
  ["Judge last HR", null],
  ["Judge over 1.5 singles", null],
  ["Judge batter Ks over 1.5", null],
  ["Judge hitter strikeouts o0.5", null],
  ["Pitcher hits over 4.5", null],
  // --- ceilings: other sports' vocabulary never reads as baseball ---
  ["Judge over 9.5 hits", null],
  ["Judge 25+ points", null],
  ["LeBron over 45.5 runs", null],
  ["Skenes over 20.5 strikeouts", null],
  // --- no line / not a stat ---
  ["Chris Sale Ks", null],
  ["Chris Sale to win", null],
  ["6 Ks Sale", null],
];
for (const [text, expected] of PARSE) check(`parse: "${text}"`, shape(parseMlbPlayerProp(text)), expected);

// ---- N+ normalization -------------------------------------------------------------------------------
check("normalize: 2+ hits", normalizeMlbNPlus("Juan Soto 2+ hits"), "Juan Soto Over 1.5 hits");
check("normalize: 1+ HR", normalizeMlbNPlus("Judge 1+ HR"), "Judge Over 0.5 HR");
check("normalize: to hit a home run", normalizeMlbNPlus("Judge to hit a home run"), "Judge Over 0.5 Home Runs");
check("normalize: anytime HR", normalizeMlbNPlus("Judge anytime HR"), "Judge Over 0.5 Home Runs");
check("normalize: explicit over/under line untouched", normalizeMlbNPlus("Judge over 0.5 hits"), "Judge over 0.5 hits");
check("normalize: hits allowed untouched", normalizeMlbNPlus("Skenes 4+ hits allowed"), "Skenes 4+ hits allowed");
check("normalize: 1st-inning K untouched", normalizeMlbNPlus("Skenes 3+ 1st inning Ks"), "Skenes 3+ 1st inning Ks");
check("normalize: non-MLB stat untouched", normalizeMlbNPlus("Judge 25+ points"), "Judge 25+ points");
check("normalize: above the ceiling untouched", normalizeMlbNPlus("Judge 12+ hits"), "Judge 12+ hits");
check("normalize: 0+ untouched", normalizeMlbNPlus("Judge 0+ hits"), "Judge 0+ hits");

// ---- position / market helpers ----------------------------------------------------------------------
check("pitcher markets", [isMlbPitcherMarket("STRIKEOUTS"), isMlbPitcherMarket("OUTS_RECORDED"), isMlbPitcherMarket("HITS")], [true, true, false]);
check("PA-gated markets: contact + walks yes, runs no", (["HITS", "TOTAL_BASES", "HOME_RUNS", "RBIS", "WALKS", "RUNS"] as const).map(isMlbPaGatedMarket), [true, true, true, true, true, false]);
check("pitcher market fits P and TWP only", ["P", "TWP", "SS", "DH", "C"].map((p) => mlbPositionFitsMarket(p, "STRIKEOUTS")), [true, true, false, false, false]);
check("hitter market fits everyone but P (TWP included)", ["P", "TWP", "SS", "DH", "C"].map((p) => mlbPositionFitsMarket(p, "HITS")), [false, true, true, true, true]);

// ---- bet-line.ts: NFL/NHL parsing is untouched; MLB only via the known-PLAYER_PROP parser ------------------
check("normalizeNPlusPlayerProp does NOT rewrite MLB N+ (MLB normalization is evidence-gated in parse-catalog)", normalizeNPlusPlayerProp("Juan Soto 2+ hits"), "Juan Soto 2+ hits");
check("parseAnyPlayerProp: NFL first", parseAnyPlayerProp("Josh Allen Over 275.5 Passing Yards")?.propMarket, "PASS_YDS");
check("parseAnyPlayerProp: NHL second", parseAnyPlayerProp("NHL Ivan Demidov 2+ shots on goal")?.propMarket, "SHOTS_ON_GOAL");
check("parseAnyPlayerProp: MLB third (known PLAYER_PROP text)", parseAnyPlayerProp("Chris Sale over 5.5 Ks")?.propMarket, "STRIKEOUTS");

// ---- parseSupportedMlbProp: the evidence gate --------------------------------------------------------------
const supported = (t: string) => parseSupportedMlbProp(t) !== null;
check("gate: person subject + MLB vocabulary", supported("Juan Soto 1+ hits"), true);
check("gate: explicit MLB code", supported("MLB Chris Sale o5.5 K"), true);
check("gate: a TEAM subject is never a player prop (Yankees over 2.5 runs)", supported("Yankees over 2.5 runs"), false);
check("gate: a team total is never a player prop (Dodgers over 1.5 walks)", supported("Dodgers over 1.5 walks"), false);
check("gate: matchup total (Yankees vs Red Sox over 8.5 runs)", supported("Yankees vs Red Sox over 8.5 runs"), false);
check("gate: matchup total stat (over 20.5 hits)", supported("Yankees vs Red Sox over 20.5 hits"), false);
check("gate: team-prefixed player (Yankees Aaron Judge over 1.5 hits)", supported("Yankees Aaron Judge over 1.5 hits"), true);
check("gate: another sport's code wins (NHL Connor McDavid 3+ hits)", supported("NHL Connor McDavid 3+ hits"), false);
check("gate: another sport's code wins (NBA LeBron James over 6.5 hits)", supported("NBA LeBron James over 6.5 hits"), false);
check("gate: an NFL prop is never an MLB prop", supported("Josh Allen Over 275.5 Passing Yards"), false);

// ---- parseCatalog routing ----------------------------------------------------------------------------------
function pickOf(line: string, capper = "Krash") {
  const r = parseCatalog([capper, line].join("\n"));
  return { picks: r.picks.map((p) => [p.capperName, p.sportName, p.betType, p.description]), unresolved: r.unresolved, parlays: r.parlays.length };
}
// Explicit sport -> an MLB PLAYER_PROP pick, N+ already normalized into the stored description.
const EXPLICIT: [string, string][] = [
  ["MLB Chris Sale o5.5 K", "Chris Sale o5.5 K"],
  ["MLB Paul Skenes 6+ strikeouts", "Paul Skenes Over 5.5 strikeouts"],
  ["MLB Logan Webb u17.5 outs recorded", "Logan Webb u17.5 outs recorded"],
  ["MLB Aaron Judge 2+ total bases", "Aaron Judge Over 1.5 total bases"],
  ["MLB Juan Soto 1+ hits", "Juan Soto Over 0.5 hits"],
  ["MLB Juan Soto 1+ BB -120", "Juan Soto Over 0.5 BB"], // trailing -120 is read as the odds, not kept in the bet text
  ["MLB Kyle Schwarber 1+ runs scored", "Kyle Schwarber Over 0.5 runs scored"],
  ["MLB Pete Alonso 2+ RBI", "Pete Alonso Over 1.5 RBI"],
  ["MLB Aaron Judge to hit a home run", "Aaron Judge Over 0.5 Home Runs"],
  ["Yankees Aaron Judge over 1.5 hits", "Yankees Aaron Judge over 1.5 hits"],
  ["Dodgers Shohei Ohtani 1+ HR", "Dodgers Shohei Ohtani Over 0.5 HR"],
  ["Aaron Judge to hit a home run MLB", "Aaron Judge Over 0.5 Home Runs"], // trailing league code (was dropped without the guard)
  ["Chris Sale o5.5 K MLB", "Chris Sale o5.5 K"],
  ["Yankees vs Red Sox Schlittler over 17.5 outs MLB", "Yankees vs Red Sox Schlittler over 17.5 outs"],
];
for (const [line, desc] of EXPLICIT) {
  const r = pickOf(line);
  check(`explicit: "${line}"`, [r.picks, r.unresolved, r.parlays], [[["Krash", "MLB", "PLAYER_PROP", desc]], [], 0]);
}
// Sport-less -> parked for MLB-roster recovery, attributed to the capper, never a pick, never flagged unsupported.
for (const line of [
  "Chris Sale over 5.5 Ks",
  "Skenes o17.5 outs",
  "Juan Soto 1+ BB",
  "Kyle Tucker 2+ TB",
  "Bobby Witt Jr. o1.5 TB",
  "Mookie Betts over 0.5 walks",
  "Kyle Schwarber over 0.5 runs",
  "Pete Alonso over 0.5 RBIs",
  "Judge 1+ HR",
  "Juan Soto 1+ hits",
]) {
  const r = parseCatalog("Krash\n" + line);
  check(`sport-less awaits roster recovery: "${line}"`, [r.picks.length, r.parlays.length, r.unresolved, r.unresolvedCapperNames, detectUnsupportedPropLine(line)], [0, 0, [line], ["Krash"], null]);
}
// No grader: stays unsupported with the MLB reason (and is NOT dropped as a capper header).
for (const line of ["Judge stolen base", "Judge 1+ SB", "Judge 1+ stolen bases", "Judge to steal a base", "Skenes o3.5 hits allowed", "Mike Trout over 1.5 hits+runs+RBIs"]) {
  const r = parseCatalog("Krash\n" + line);
  check(`unsupported MLB market is parked, not dropped: "${line}"`, [r.picks.length, r.unresolved, detectUnsupportedPropLine(line)?.reason], [0, [line], UNSUPPORTED_PROP_REASONS.MLB]);
}
// Earned runs is a different market with no vocabulary flag of its own (pre-existing): still parked, never graded as runs.
check("earned runs is parked in unresolved", [pickOf("Skenes under 2.5 earned runs").picks.length, pickOf("Skenes under 2.5 earned runs").unresolved], [0, ["Skenes under 2.5 earned runs"]]);
// Team bets, totals, NRFI and capper headers are untouched.
for (const [line, sport, betType] of [
  ["MLB Yankees ML", "MLB", "MONEYLINE"],
  ["MLB Yankees vs Red Sox over 8.5 runs", "MLB", "TOTAL"],
  ["Yankees over 2.5 runs", "MLB", "TOTAL"],
  ["MLB Yankees team total over 4.5 runs", "MLB", "TEAM_TOTAL"],
  ["MLB Yankees NRFI", "MLB", "NRFI"],
  ["Yankees NRFI", "MLB", "NRFI"],
  ["Yankees YRFI", "MLB", "NRFI"],
  ["Dodgers vs Padres NRFI", "MLB", "NRFI"],
  ["MLB Yankees F5 -0.5", "MLB", "SPREAD"],
] as const) {
  const r = parseCatalog("Krash\n" + line);
  check(`unchanged: "${line}"`, r.picks.map((p) => [p.sportName, p.betType]), [[sport, betType]]);
}
for (const header of ["Hits Only 12-2", "Bambino 19-0 NRFI Run"]) {
  const r = parseCatalog(header + "\nMLB Yankees ML");
  check(`header stays a header (no phantom pick/unresolved): "${header}"`, [r.picks.length, r.unresolved.length], [1, 0]);
}
// A team walk total used to import as a game TOTAL (wrong data); it is now a stat total like "Lakers over 45.5 rebounds".
check("team walks total is no longer imported as a TOTAL", pickOf("Yankees over 1.5 walks"), { picks: [], unresolved: ["Yankees over 1.5 walks"], parlays: 0 });
// Another sport's prop with MLB-shaped vocabulary is left to that sport.
check("NHL-coded hits stays NHL-unsupported", [pickOf("NHL Connor McDavid 3+ hits").picks, detectUnsupportedPropLine("NHL Connor McDavid 3+ hits")?.reason], [[], UNSUPPORTED_PROP_REASONS.NHL]);
// NHL prop parsing untouched.
check("NHL prop still imports", pickOf("NHL Ivan Demidov 2+ shots on goal").picks, [["Krash", "NHL", "PLAYER_PROP", "Ivan Demidov Over 1.5 shots on goal"]]);
check("one capper, mixed paste: every MLB line kept and attributed", (() => {
  const r = parseCatalog(["Krash", "MLB Yankees ML", "Chris Sale over 5.5 Ks", "MLB Juan Soto 1+ hits", "Hoop Dealer", "NBA Nuggets ML"].join("\n"));
  return [r.picks.map((p) => [p.capperName, p.sportName, p.betType]), r.unresolved, r.unresolvedCapperNames];
})(), [
  [
    ["Krash", "MLB", "MONEYLINE"],
    ["Krash", "MLB", "PLAYER_PROP"],
    ["Hoop Dealer", "NBA", "MONEYLINE"],
  ],
  ["Chris Sale over 5.5 Ks"],
  ["Krash"],
]);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
