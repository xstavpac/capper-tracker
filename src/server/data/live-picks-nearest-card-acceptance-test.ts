// Proof that assignPicksToNearestGame (getPicksForGames' second pass) puts each
// pick on exactly ONE card. Before it, matchPicksToGame matched cards
// independently, so the same 16 Phillies/Braves picks counted under both a
// 1:00 PM and a 7:11 PM card on 2026-10-01 (the 18:00Z card was exactly 6h from
// the picks' 00:00Z gameTime - inside the inclusive 6h drift window).
//
// Run with:
//   npx tsx src/server/data/live-picks-nearest-card-acceptance-test.ts
// Exits non-zero on any failed assertion.
import { matchPicksToGame, assignPicksToNearestGame } from "./picks";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const HOUR = 3600000;
type Pick = { homeTeam: string; awayTeam: string; betDetail: string | null; gameTime: Date; gameNumber?: number | null };
const mk = (home: string, away: string, iso: string, betDetail: string, gameNumber: number | null = null): Pick => ({
  homeTeam: home,
  awayTeam: away,
  betDetail,
  gameTime: new Date(iso),
  gameNumber,
});
const g = (home: string, away: string, iso: string, gameNumber: number | null = null) => ({
  homeTeam: home,
  awayTeam: away,
  commenceTime: new Date(iso),
  gameNumber,
});
// The production flow: per-game match, then the nearest-card assignment.
function board(picks: Pick[], games: ReturnType<typeof g>[], sport = "MLB") {
  return assignPicksToNearestGame(
    games.map((game) => matchPicksToGame(picks, game, sport)),
    games
  );
}
const labels = (rows: Pick[][]) => rows.map((r) => r.map((p) => p.betDetail));

const ATL = "Atlanta Braves";
const PHI = "Philadelphia Phillies";

// ---- 1. The phantom case, if the phantom ever reached pick matching ------------
const picks16 = Array.from({ length: 16 }, (_, i) => mk(ATL, PHI, "2026-10-02T00:00:00Z", "p" + i));
const phantomCard = g(ATL, PHI, "2026-10-01T18:00:00Z"); // exactly 6h from the picks
const realCard = g(ATL, PHI, "2026-10-02T00:11:00Z"); // 11 min from the picks

// Precondition: the old behaviour really did match both (otherwise this proves nothing).
expect(
  "1a. precondition: per-game matching alone attaches all 16 to BOTH cards",
  [matchPicksToGame(picks16, phantomCard, "MLB").length, matchPicksToGame(picks16, realCard, "MLB").length],
  [16, 16]
);
const r1 = board(picks16, [phantomCard, realCard]);
expect("1b. after assignment: 0 on the 1:00 PM card, 16 on the 7:11 PM card", r1.map((r) => r.length), [0, 16]);
expect("1c. total is 16, not 32", r1.flat().length, 16);

// ---- 2. A pick exactly 6h from two cards ---------------------------------------
const T = "2026-10-01T18:00:00Z";
const earlier = g(ATL, PHI, new Date(new Date(T).getTime() - 6 * HOUR).toISOString());
const later = g(ATL, PHI, new Date(new Date(T).getTime() + 6 * HOUR).toISOString());
const equi = mk(ATL, PHI, T, "equidistant");
expect(
  "2a. precondition: an exactly-6h pick matches both cards",
  [matchPicksToGame([equi], earlier, "MLB").length, matchPicksToGame([equi], later, "MLB").length],
  [1, 1]
);
expect("2b. tie goes to the earlier card, counted once", labels(board([equi], [earlier, later])), [["equidistant"], []]);
expect("2c. same result whichever order the cards arrive in", labels(board([equi], [later, earlier])), [[], ["equidistant"]]);

// ---- 3. A real doubleheader: both cards kept, picks split ----------------------
const CHC = "Chicago Cubs";
const STL = "St. Louis Cardinals";
const dhG1 = g(CHC, STL, "2026-09-20T17:05:00Z", 1);
const dhG2 = g(CHC, STL, "2026-09-20T20:35:00Z", 2);
const byTime = [
  mk(CHC, STL, "2026-09-20T17:05:00Z", "g1-bet"),
  mk(CHC, STL, "2026-09-20T20:35:00Z", "g2-bet"),
];
expect("3a. no gameNumber on picks: split by nearest start time", labels(board(byTime, [dhG1, dhG2])), [["g1-bet"], ["g2-bet"]]);

// Traditional doubleheader, game 2's listed time a placeholder 15 min after
// game 1: nearest-time alone would send a game-2 pick to game 1; gameNumber
// must win.
const phG1 = g(CHC, STL, "2026-09-20T17:05:00Z", 1);
const phG2 = g(CHC, STL, "2026-09-20T17:20:00Z", 2);
const byNumber = [
  mk(CHC, STL, "2026-09-20T17:06:00Z", "g1-bet", 1),
  mk(CHC, STL, "2026-09-20T17:06:00Z", "g2-bet", 2),
];
expect("3b. gameNumber outranks nearest time", labels(board(byNumber, [phG1, phG2])), [["g1-bet"], ["g2-bet"]]);

const onlyG1Card = [phG1];
expect(
  "3c. a game-2 pick with no game-2 card still shows (single candidate, untouched)",
  labels(board([mk(CHC, STL, "2026-09-20T17:06:00Z", "g2-bet", 2)], onlyG1Card)),
  [["g2-bet"]]
);
expect(
  "3d. gameNumber matching no candidate falls back to nearest, never vanishes",
  labels(board([mk(CHC, STL, "2026-09-20T17:06:00Z", "g3-bet", 3)], [phG1, phG2])),
  [["g3-bet"], []]
);

// ---- 4. Untouched behaviour ----------------------------------------------------
expect(
  "4a. a pick that matches one card is unchanged and keeps order",
  labels(board([mk(ATL, PHI, "2026-10-02T00:00:00Z", "a"), mk(ATL, PHI, "2026-10-02T00:00:00Z", "b")], [realCard])),
  [["a", "b"]]
);
expect(
  "4b. a pick for an unrelated matchup stays off both cards",
  labels(board([mk("New York Mets", "Miami Marlins", "2026-10-02T00:00:00Z", "m")], [phantomCard, realCard])),
  [[], []]
);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
if (failures > 0) process.exit(1);
