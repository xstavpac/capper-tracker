// Proof for buildPickDisplayLabel (pick-display-label.ts) - the canonical
// display label generator ("cubs ml" resolved data -> "Cubs Moneyline").
//
// Pure: no DB, no imports beyond the module under test and its own
// dependencies. Run with:
//   npx tsx src/lib/pick-display-label-acceptance-test.ts
import { buildPickDisplayLabel, type PickDisplayLabelInput } from "@/lib/pick-display-label";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

// Base input with every field resolved - each test overrides just what it
// needs, so a missing-field test reads as "everything else is fine except X".
const BASE: PickDisplayLabelInput = {
  betType: "MONEYLINE",
  matched: true,
  homeTeam: "Chicago White Sox",
  awayTeam: "Chicago Cubs",
  pickedSide: "AWAY",
  line: null,
  playerName: null,
  propMarket: null,
  sportName: "MLB",
  betDetail: "cubs ml",
};

// ---- 1. "cubs ml" resolved as Cubs moneyline ----
check(
  "moneyline: 'cubs ml' picked AWAY (Cubs) -> 'Cubs Moneyline'",
  buildPickDisplayLabel(BASE),
  "Cubs Moneyline"
);
check(
  "moneyline: picked HOME (White Sox) -> 'White Sox Moneyline'",
  buildPickDisplayLabel({ ...BASE, pickedSide: "HOME", betDetail: "chisox ml" }),
  "White Sox Moneyline"
);

// ---- 2. Multi-word mascots via shortTeamName ----
const MULTI_WORD_CASES: [string, string, "HOME" | "AWAY", string][] = [
  // [homeTeam, awayTeam, pickedSide, expectedTeamName]
  ["Nashville Predators", "Columbus Blue Jackets", "AWAY", "Blue Jackets"],
  ["Boston Bruins", "Toronto Maple Leafs", "AWAY", "Maple Leafs"],
  ["Los Angeles Kings", "Vegas Golden Knights", "AWAY", "Golden Knights"],
  ["Boston Red Sox", "New York Yankees", "HOME", "Red Sox"],
  ["Chicago White Sox", "Cleveland Guardians", "HOME", "White Sox"],
  ["Denver Nuggets", "Portland Trail Blazers", "AWAY", "Trail Blazers"],
];
for (const [homeTeam, awayTeam, pickedSide, expectedTeam] of MULTI_WORD_CASES) {
  const sportName = homeTeam.includes("Sox") || homeTeam.includes("Yankees") || awayTeam.includes("Yankees") ? "MLB"
    : homeTeam.includes("Nuggets") || awayTeam.includes("Blazers") ? "NBA"
    : "NHL";
  check(
    `moneyline: ${pickedSide === "HOME" ? homeTeam : awayTeam} -> '${expectedTeam} Moneyline'`,
    buildPickDisplayLabel({ ...BASE, homeTeam, awayTeam, pickedSide, sportName, betDetail: "x" }),
    `${expectedTeam} Moneyline`
  );
}

// ---- 3. Player prop team-name stripping ----
check(
  "player prop: 'Chiefs Travis Kelce Over 42.5 Receiving Yards' -> 'Travis Kelce Over 42.5 Rec Yds'",
  buildPickDisplayLabel({
    ...BASE,
    betType: "PLAYER_PROP",
    homeTeam: "Kansas City Chiefs",
    awayTeam: "Buffalo Bills",
    pickedSide: null,
    sportName: "NFL",
    playerName: "Chiefs Travis Kelce",
    propMarket: "REC_YDS",
    betDetail: "Chiefs Travis Kelce Over 42.5 Receiving Yards",
  }),
  "Travis Kelce Over 42.5 Rec Yds"
);

// ---- 4. Totals using "@" ----
check(
  "total: Cardinals @ Raiders Over 40.5",
  buildPickDisplayLabel({
    ...BASE,
    betType: "TOTAL",
    homeTeam: "Las Vegas Raiders",
    awayTeam: "Arizona Cardinals",
    pickedSide: null,
    sportName: "NFL",
    line: 40.5,
    betDetail: "cardinals raiders over 40.5",
  }),
  "Cardinals @ Raiders Over 40.5"
);
check(
  "total: away @ home Under, using shortTeamName on both sides",
  buildPickDisplayLabel({
    ...BASE,
    betType: "TOTAL",
    homeTeam: "Boston Red Sox",
    awayTeam: "New York Yankees",
    pickedSide: null,
    sportName: "MLB",
    line: 8.5,
    betDetail: "under 8.5",
  }),
  "Yankees @ Red Sox Under 8.5"
);

// ---- Spread / team total (not explicitly enumerated above but part of the format spec) ----
check(
  "spread: 'Lions +7'",
  buildPickDisplayLabel({
    ...BASE,
    betType: "SPREAD",
    homeTeam: "Detroit Lions",
    awayTeam: "Chicago Bears",
    pickedSide: "HOME",
    sportName: "NFL",
    line: 7,
    betDetail: "lions +7",
  }),
  "Lions +7"
);
check(
  "spread: negative line keeps its own sign, no double-negative",
  buildPickDisplayLabel({
    ...BASE,
    betType: "SPREAD",
    homeTeam: "Columbus Blue Jackets",
    awayTeam: "Boston Bruins",
    pickedSide: "HOME",
    sportName: "NHL",
    line: -1.5,
    betDetail: "blue jackets -1.5",
  }),
  "Blue Jackets -1.5"
);
check(
  "team total: 'Cardinals Over 4.5'",
  buildPickDisplayLabel({
    ...BASE,
    betType: "TEAM_TOTAL",
    homeTeam: "Arizona Diamondbacks",
    awayTeam: "St. Louis Cardinals",
    pickedSide: "AWAY",
    sportName: "MLB",
    line: 4.5,
    betDetail: "cardinals team total over 4.5",
  }),
  "Cardinals Over 4.5"
);

// ---- 5. NRFI and YRFI ----
check(
  "nrfi: 'Yankees @ Red Sox NRFI'",
  buildPickDisplayLabel({
    ...BASE,
    betType: "NRFI",
    homeTeam: "Boston Red Sox",
    awayTeam: "New York Yankees",
    pickedSide: null,
    sportName: "MLB",
    betDetail: "nrfi",
  }),
  "Yankees @ Red Sox NRFI"
);
check(
  "yrfi: 'Yankees @ Red Sox YRFI'",
  buildPickDisplayLabel({
    ...BASE,
    betType: "NRFI",
    homeTeam: "Boston Red Sox",
    awayTeam: "New York Yankees",
    pickedSide: null,
    sportName: "MLB",
    betDetail: "yrfi",
  }),
  "Yankees @ Red Sox YRFI"
);

// ---- 6. Every PropMarket value ----
const PROP_BASE: PickDisplayLabelInput = {
  ...BASE,
  betType: "PLAYER_PROP",
  homeTeam: "Kansas City Chiefs",
  awayTeam: "Buffalo Bills",
  pickedSide: null,
  sportName: "NFL",
  playerName: "Josh Allen",
};
check(
  "PropMarket PASS_YDS",
  buildPickDisplayLabel({ ...PROP_BASE, propMarket: "PASS_YDS", betDetail: "Josh Allen Over 275.5 Passing Yards" }),
  "Josh Allen Over 275.5 Pass Yds"
);
check(
  "PropMarket RUSH_YDS",
  buildPickDisplayLabel({ ...PROP_BASE, propMarket: "RUSH_YDS", betDetail: "Josh Allen Over 31.5 Rushing Yards" }),
  "Josh Allen Over 31.5 Rush Yds"
);
check(
  "PropMarket REC_YDS",
  buildPickDisplayLabel({ ...PROP_BASE, propMarket: "REC_YDS", betDetail: "Josh Allen Over 42.5 Receiving Yards" }),
  "Josh Allen Over 42.5 Rec Yds"
);
check(
  "PropMarket RECEPTIONS",
  buildPickDisplayLabel({ ...PROP_BASE, propMarket: "RECEPTIONS", betDetail: "Josh Allen Under 5.5 Receptions" }),
  "Josh Allen Under 5.5 Receptions"
);
check(
  "PropMarket RUSH_REC_YDS",
  buildPickDisplayLabel({ ...PROP_BASE, propMarket: "RUSH_REC_YDS", betDetail: "Josh Allen Over 55.5 Rush and Rec Yards" }),
  "Josh Allen Over 55.5 Rush+Rec Yds"
);
check(
  "PropMarket PASS_RUSH_YDS",
  buildPickDisplayLabel({ ...PROP_BASE, propMarket: "PASS_RUSH_YDS", betDetail: "Josh Allen Over 300.5 Pass and Rush Yards" }),
  "Josh Allen Over 300.5 Pass+Rush Yds"
);
check(
  "PropMarket TD -> Anytime TD, no Over/Under/line",
  buildPickDisplayLabel({ ...PROP_BASE, propMarket: "TD", playerName: "Chiefs Travis Kelce", betDetail: "Chiefs Travis Kelce Anytime TD" }),
  "Travis Kelce Anytime TD"
);

// ---- 7. Null cases ----
check(
  "null: pickedSide null on MONEYLINE -> null",
  buildPickDisplayLabel({ ...BASE, pickedSide: null }),
  null
);
check(
  "null: SPREAD with null line -> null",
  buildPickDisplayLabel({ ...BASE, betType: "SPREAD", pickedSide: "HOME", line: null, betDetail: "cubs -1.5" }),
  null
);
check(
  "null: TOTAL with null line -> null",
  buildPickDisplayLabel({ ...BASE, betType: "TOTAL", pickedSide: null, line: null, betDetail: "over" }),
  null
);
check(
  "null: TEAM_TOTAL with null line -> null (import gap, not fixed by this PR)",
  buildPickDisplayLabel({ ...BASE, betType: "TEAM_TOTAL", pickedSide: "AWAY", line: null, betDetail: "cubs team total over" }),
  null
);
check(
  "null: PLAYER_PROP missing playerName -> null",
  buildPickDisplayLabel({ ...PROP_BASE, playerName: null, propMarket: "RUSH_YDS", betDetail: "Over 31.5 Rushing Yards" }),
  null
);
check(
  "null: PLAYER_PROP missing propMarket -> null",
  buildPickDisplayLabel({ ...PROP_BASE, propMarket: null, betDetail: "Josh Allen Over 31.5 Rushing Yards" }),
  null
);
check(
  "null: unrecognized bet type -> null",
  buildPickDisplayLabel({ ...BASE, betType: "SOMETHING_NEW" }),
  null
);
check(
  "null: unresolved team/game info (matched: false) -> null",
  buildPickDisplayLabel({ ...BASE, matched: false }),
  null
);
check(
  "null: same-mascot matchup (pickedSide left null by resolveGameAndOdds) -> null",
  buildPickDisplayLabel({
    ...BASE,
    homeTeam: "Clemson Tigers",
    awayTeam: "LSU Tigers",
    pickedSide: null,
    sportName: "NCAAF",
    betDetail: "tigers ml",
  }),
  null
);
check(
  "null: TOTAL with no recognizable over/under side in text -> null",
  buildPickDisplayLabel({ ...BASE, betType: "TOTAL", pickedSide: null, line: 8.5, betDetail: "8.5" }),
  null
);
check(
  "null: NRFI with no recognizable NRFI/YRFI phrasing -> null",
  buildPickDisplayLabel({ ...BASE, betType: "NRFI", pickedSide: null, betDetail: "first inning bet" }),
  null
);
check(
  "null: PLAYER_PROP (non-TD) with no parseable Over/Under line in text -> null",
  buildPickDisplayLabel({ ...PROP_BASE, propMarket: "RUSH_YDS", betDetail: "Josh Allen Rushing Yards" }),
  null
);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
