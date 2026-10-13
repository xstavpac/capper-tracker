// Proof for the /picks game links and Most Backed's side labels - run with:
//   npx tsx src/lib/pick-game-link-acceptance-test.ts
import { liveGameHref, GAME_LINK_MAX_DRIFT_MS, type SlateGame } from "./pick-game-link";
import { sideLabel, buildPickLabel, type LedgerPickInput } from "./pick-display";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const T = Date.parse("2026-10-12T23:15:00Z");
const HOUR = 3600000;
const game = (id: string, homeTeam: string, awayTeam: string, at: number): SlateGame => ({ id, homeTeam, awayTeam, commenceTime: new Date(at).toISOString() });
const slate = [game("g1", "Buffalo Bills", "Kansas City Chiefs", T), game("g2", "New York Yankees", "Boston Red Sox", T), game("g3", "New York Yankees", "Boston Red Sox", T + 24 * HOUR)];
const NFL = "americanfootball_nfl";
const MLB = "baseball_mlb";
const pick = (homeTeam: string, awayTeam: string, at: number) => ({ homeTeam, awayTeam, gameTime: new Date(at) });

check("same teams, same start -> that game's page, sport on the link", liveGameHref(slate, pick("Buffalo Bills", "Kansas City Chiefs", T), NFL), "/live/g1?sport=" + NFL);
check("a moved start inside the drift still matches", liveGameHref(slate, pick("Buffalo Bills", "Kansas City Chiefs", T + 2 * HOUR), NFL), "/live/g1?sport=" + NFL);
check("past the drift -> no link", liveGameHref(slate, pick("Buffalo Bills", "Kansas City Chiefs", T + GAME_LINK_MAX_DRIFT_MS + 1), NFL), null);
check("a series: the closest start wins", liveGameHref(slate, pick("New York Yankees", "Boston Red Sox", T + 23 * HOUR), MLB), "/live/g3?sport=" + MLB);
check("home and away swapped is another game -> no link", liveGameHref(slate, pick("Kansas City Chiefs", "Buffalo Bills", T), NFL), null);
check("a game the slate does not carry -> no link", liveGameHref(slate, pick("Dallas Cowboys", "New York Giants", T), NFL), null);
check("empty slate -> no link", liveGameHref([], pick("Buffalo Bills", "Kansas City Chiefs", T), NFL), null);

// A side's label is the label a pick on that side gets in the ledger.
const g = { homeTeam: "Bills", awayTeam: "Chiefs" };
const ledger = (o: Partial<LedgerPickInput>): string =>
  buildPickLabel({ id: "p", capperId: "c", sportName: "NFL", ...g, betType: "MONEYLINE", betDetail: null, line: null, period: "FULL_GAME", pickedSide: null, odds: -110, status: "PENDING", gameTime: new Date(T), ...o });
check("moneyline side = the team", [sideLabel({ ...g, betType: "MONEYLINE", side: "AWAY", line: null }), ledger({ pickedSide: "AWAY" })], ["Chiefs", "Chiefs"]);
check("spread side = team and signed line", [sideLabel({ ...g, betType: "SPREAD", side: "AWAY", line: -3.5 }), ledger({ betType: "SPREAD", pickedSide: "AWAY", line: -3.5 })], ["Chiefs -3.5", "Chiefs -3.5"]);
check("spread dog gets its plus", sideLabel({ ...g, betType: "SPREAD", side: "HOME", line: 3 }), "Bills +3");
check("spread with no line = the team alone", sideLabel({ ...g, betType: "SPREAD", side: "HOME", line: null }), "Bills");
check("total side = Over / Under and the line", [sideLabel({ ...g, betType: "TOTAL", side: "OVER", line: 44.5 }), ledger({ betType: "TOTAL", betDetail: "over 44.5", line: 44.5 })], ["Over 44.5", "Over 44.5"]);
check("under", sideLabel({ ...g, betType: "TOTAL", side: "UNDER", line: 8 }), "Under 8");
check("NRFI / YRFI", [sideLabel({ ...g, betType: "NRFI", side: "NRFI", line: null }), ledger({ betType: "NRFI", betDetail: "NRFI" }), sideLabel({ ...g, betType: "NRFI", side: "YRFI", line: null }), ledger({ betType: "NRFI", betDetail: "YRFI" })], ["No run in the 1st inning", "No run in the 1st inning", "Run in the 1st inning", "Run in the 1st inning"]);
check("three-way draw", sideLabel({ ...g, betType: "MONEYLINE", side: "DRAW", line: null }), "Draw");

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll passed");
