// Proof for live-state.ts: a live feed row becomes the game's progress and
// away/home score; the feed's scoreMissing (shown as "0" on the board) is kept,
// so it reads as changed, never as 0-0; anything not live has no state.
// Pure: no DB, no network (liveStateOf only). Run with:
//   npx tsx src/server/data/live-state-acceptance-test.ts
import { liveStateOf } from "@/server/data/live-state";
import { startedPriceLabel, PRICE_PREGAME_PENDING, PRICE_EST_UNCHANGED } from "@/lib/parlay/game-progress";
import type { ScoreGame } from "@/server/data/odds";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : " - expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual)));
}

const GAME = { homeTeam: "Indiana Pacers", awayTeam: "Chicago Bulls" };
const row = (over: Partial<ScoreGame>): ScoreGame => ({
  id: "e1",
  homeTeam: "Indiana Pacers",
  awayTeam: "Chicago Bulls",
  status: "live",
  scores: [
    { name: "Indiana Pacers", score: "41" },
    { name: "Chicago Bulls", score: "45" },
  ],
  commenceTime: "2099-06-01T23:00:00Z",
  inningHalf: null,
  inningOrdinal: null,
  innings: null,
  period: 2,
  clock: "4:12",
  ...over,
});

check("NBA live row: period, clock, away/home score", liveStateOf(row({}), GAME, "basketball_nba"), { period: 2, clock: "4:12", inningHalf: null, inning: null, away: 45, home: 41, scoreMissing: false });
const missing = liveStateOf(row({ scores: [{ name: "Indiana Pacers", score: "0" }, { name: "Chicago Bulls", score: "0" }], scoreMissing: true }), GAME, "basketball_nba");
check("scoreMissing is kept even though the feed shows 0-0", missing?.scoreMissing, true);
check("...and the price label reads it as changed", startedPriceLabel({ gameStatus: "live", liveState: missing }), PRICE_PREGAME_PENDING);
const zero = liveStateOf(row({ scores: [{ name: "Indiana Pacers", score: "0" }, { name: "Chicago Bulls", score: "0" }] }), GAME, "basketball_nba");
check("a real 0-0 reads as unchanged", startedPriceLabel({ gameStatus: "live", liveState: zero }), PRICE_EST_UNCHANGED);
check("a blank score is missing", liveStateOf(row({ scores: [{ name: "Indiana Pacers", score: "" }, { name: "Chicago Bulls", score: "3" }] }), GAME, "basketball_nba")?.scoreMissing, true);
check("not live (preview / final / no row): no state", [liveStateOf(row({ status: "preview" }), GAME, "basketball_nba"), liveStateOf(row({ status: "final" }), GAME, "basketball_nba"), liveStateOf(undefined, GAME, "basketball_nba")], [null, null, null]);
const mlb = liveStateOf(
  row({ homeTeam: "Boston Red Sox", awayTeam: "New York Yankees", scores: [{ name: "Boston Red Sox", score: "1" }, { name: "New York Yankees", score: "2" }], period: null, clock: null, inningHalf: "Top", inningOrdinal: "5th" }),
  { homeTeam: "Boston Red Sox", awayTeam: "New York Yankees" },
  "baseball_mlb"
);
check("MLB: inning half + number and runs", [mlb?.inningHalf, mlb?.inning, mlb?.away, mlb?.home, mlb?.period], ["Top", 5, 2, 1, null]);

if (failures) {
  console.log(failures + " failure(s)");
  process.exit(1);
}
console.log("All live-state checks passed");
