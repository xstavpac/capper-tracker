// Regression proof: matchGameResult never grades a pick off ANOTHER game whose nicknames collide.
//
// Prod 2026-11: NCAAB stores a final only while a pending pick names its teams (final-pick-gate.ts). Mississippi St -
// Jackson St finished first; the LSU / Louisiana Tech picks' fuzzy match found "bulldogs" and "tigers" in their text
// and graded off that row, and with no LSU pick left pending the real final (LSU 90-50, ESPN 401921810) was never
// stored. Same for San José St / Fresno St off Gardner-Webb Runnin' Bulldogs / UNC Greensboro Spartans (real final
// SJSU 92-86, ESPN 401911473). A fuzzy candidate must now hold BOTH of the pick's teams by full identity.
// Pure: no DB. Run with:
//   npx tsx src/server/data/grading-no-wrong-game-acceptance-test.ts
import { matchGameResult, nicknameOnlyCandidate, NICKNAME_ONLY_REASON } from "@/server/data/grading";
import { finalsWithPicks } from "@/lib/final-pick-gate";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

const NCAAB = "basketball_ncaab";
const row = (homeTeam: string, awayTeam: string, at: string, home: number, away: number) => ({
  homeTeam,
  awayTeam,
  homeScore: home,
  awayScore: away,
  gameDate: new Date(at),
  gameNumber: null,
});
const teamsOf = (m: { game: { homeTeam: string; awayTeam: string }; matchType: string } | null) => (m ? [m.matchType, m.game.awayTeam + " @ " + m.game.homeTeam] : null);

// ---------------------------------------------------------------------
// 1. LSU / Louisiana Tech vs Mississippi State Bulldogs / Jackson State Tigers
// ---------------------------------------------------------------------
const MSU_JSU = row("Mississippi State Bulldogs", "Jackson State Tigers", "2026-11-10T00:30:00Z", 98, 57);
const LSU_LT = row("LSU Tigers", "Louisiana Tech Bulldogs", "2026-11-10T01:00:00Z", 90, 50);
const lsuPick = { homeTeam: "LSU Tigers", awayTeam: "Louisiana Tech Bulldogs", betDetail: "LSU -29.5", gameTime: new Date("2026-11-10T01:00:00Z") };

check("LSU pick, only Mississippi St - Jackson St stored: no match (PENDING), never that game", matchGameResult([MSU_JSU], lsuPick, NCAAB), null);
check(
  "...and the pending page names the colliding game",
  (() => {
    const other = nicknameOnlyCandidate([MSU_JSU], lsuPick, NCAAB);
    return other ? NICKNAME_ONLY_REASON(other) : null;
  })(),
  "no final stored for this game yet - the only nearby final with the same nicknames is a different game (Jackson State Tigers @ Mississippi State Bulldogs), which is never used to grade it"
);
check("...the pick stays pending, so the gated persist still stores the real LSU final", finalsWithPicks([LSU_LT, MSU_JSU], [lsuPick], NCAAB).map((g) => g.homeTeam), ["LSU Tigers"]);
check("once the real final is stored: graded off it", teamsOf(matchGameResult([MSU_JSU, LSU_LT], lsuPick, NCAAB)), ["exact", "Louisiana Tech Bulldogs @ LSU Tigers"]);

// ---------------------------------------------------------------------
// 2. San José St / Fresno St vs Gardner-Webb Runnin' Bulldogs / UNC Greensboro Spartans
// ---------------------------------------------------------------------
const GWEBB_UNCG = row("Gardner-Webb Runnin' Bulldogs", "UNC Greensboro Spartans", "2026-11-19T01:00:00Z", 72, 78);
const SJSU_FRESNO = row("San José State Spartans", "Fresno State Bulldogs", "2026-11-19T02:00:00Z", 92, 86);
const sjsuPick = { homeTeam: "San José State Spartans", awayTeam: "Fresno State Bulldogs", betDetail: "Fresno State +6.5", gameTime: new Date("2026-11-19T02:00:00Z") };
check("SJSU / Fresno St pick, only Gardner-Webb - UNCG stored: no match (PENDING)", matchGameResult([GWEBB_UNCG], sjsuPick, NCAAB), null);
check("once the real final is stored: graded off it", teamsOf(matchGameResult([GWEBB_UNCG, SJSU_FRESNO], sjsuPick, NCAAB)), ["exact", "Fresno State Bulldogs @ San José State Spartans"]);

// ---------------------------------------------------------------------
// 3. Fuzzy matches of the SAME game still work.
// ---------------------------------------------------------------------
// The pick spells the schools the Odds API's way ("St"), the score row ESPN's ("State").
const SDSU_SD = row("South Dakota State Jackrabbits", "South Dakota Coyotes", "2026-11-20T01:00:00Z", 81, 74);
const sdPick = { homeTeam: "South Dakota St Jackrabbits", awayTeam: "South Dakota Coyotes", betDetail: "South Dakota St -4.5", gameTime: new Date("2026-11-20T01:00:00Z") };
check("short-name vs full-name variant ('St' vs 'State'): still matched (fuzzy)", teamsOf(matchGameResult([SDSU_SD], sdPick, NCAAB)), ["fuzzy", "South Dakota Coyotes @ South Dakota State Jackrabbits"]);
const accent = row("San José State Spartans", "Fresno State Bulldogs", "2026-11-19T02:00:00Z", 92, 86);
check(
  "accent variant ('San Jose State' vs 'San José State'): still matched",
  teamsOf(matchGameResult([accent], { ...sjsuPick, homeTeam: "San Jose State Spartans" }, NCAAB)),
  ["fuzzy", "Fresno State Bulldogs @ San José State Spartans"]
);
check(
  "same game, home/away reversed (neutral site): still matched",
  teamsOf(matchGameResult([SDSU_SD], { ...sdPick, homeTeam: "South Dakota Coyotes", awayTeam: "South Dakota St Jackrabbits" }, NCAAB)),
  ["fuzzy", "South Dakota Coyotes @ South Dakota State Jackrabbits"]
);
check(
  "both the right game and a colliding one nearby: the right game",
  teamsOf(matchGameResult([MSU_JSU, row("LSU Tigers", "Louisiana Tech Bulldogs", "2026-11-10T01:05:00Z", 90, 50)], { ...lsuPick, homeTeam: "LSU Tigers " }, NCAAB)),
  ["fuzzy", "Louisiana Tech Bulldogs @ LSU Tigers"]
);
// A pro league: full identity through the league's alias table, one team spelled differently.
const NFL_ROW = row("Los Angeles Rams", "Buffalo Bills", "2026-11-16T21:25:00Z", 24, 27);
check(
  "NFL same game, identical names: exact as before",
  teamsOf(matchGameResult([NFL_ROW], { homeTeam: "Los Angeles Rams", awayTeam: "Buffalo Bills", betDetail: "Bills ML", gameTime: new Date("2026-11-16T21:25:00Z") }, "americanfootball_nfl")),
  ["exact", "Buffalo Bills @ Los Angeles Rams"]
);
check(
  "NFL: a pick on Rams / Bills never grades off Rams / Chargers (one shared team)",
  matchGameResult([row("Los Angeles Rams", "Los Angeles Chargers", "2026-11-16T21:25:00Z", 20, 17)], { homeTeam: "Los Angeles Rams", awayTeam: "Buffalo Bills", betDetail: "Bills ML", gameTime: new Date("2026-11-16T21:25:00Z") }, "americanfootball_nfl"),
  null
);

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll checks passed.");
