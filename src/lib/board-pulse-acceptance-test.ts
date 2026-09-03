// Proof for computeBoardPulse after three fixes:
//
//  1. Data source. Board Pulse's slate is the FIXED list of today's scheduled
//     games (built off the odds snapshot in live/page.tsx), not the Live
//     board's rendered list - which orderBoardGames shrinks as games go Final.
//     "Expected upsets today" must stay constant through the day, and finished
//     games must keep contributing after they leave the visible board.
//
//  2. Confirmed vs live split. Favorite/underdog outcomes are counted
//     separately for Final games (favsWon / dogsWon) and in-progress games
//     (favsLeadingLive / dogsLeadingLive).
//
//  3. Pace-relative verdict. Instead of a knife-edge rate-vs-0.427 comparison,
//     the verdict is confirmed upsets vs what the historical rate predicts for
//     the games finished SO FAR (expectedUpsetsSoFar), judged against a dynamic
//     +/-1-sigma dead band. Only finished games count.
//
// Pure: computeBoardPulse takes a plain BoardPulseGame[], classifyPace takes
// plain numbers. Run with:
//   npx tsx src/lib/board-pulse-acceptance-test.ts
import {
  computeBoardPulse,
  classifyPace,
  MLB_UNDERDOG_WIN_RATE,
  MIN_GAMES_FOR_VERDICT,
  type BoardPulseGame,
} from "@/lib/board-pulse";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}
function approx(label: string, actual: number, expected: number, tol = 1e-9) {
  const pass = Math.abs(actual - expected) <= tol;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${actual} expected~=${expected}`);
  if (!pass) failures++;
}

// favorite is always "home" in these fixtures; the score decides fav vs dog.
const favWin = (id: string): BoardPulseGame =>
  ({ id, status: "final", homeScore: 5, awayScore: 2, inningHalf: null, inningOrdinal: null, favorite: "home", totalLine: null });
const dogWin = (id: string): BoardPulseGame =>
  ({ id, status: "final", homeScore: 2, awayScore: 5, inningHalf: null, inningOrdinal: null, favorite: "home", totalLine: null });
const favLeadingLive = (id: string): BoardPulseGame =>
  ({ id, status: "live", homeScore: 3, awayScore: 1, inningHalf: "Top", inningOrdinal: "5", favorite: "home", totalLine: null });
const dogLeadingLive = (id: string): BoardPulseGame =>
  ({ id, status: "live", homeScore: 1, awayScore: 3, inningHalf: "Top", inningOrdinal: "5", favorite: "home", totalLine: null });
const notStarted = (id: string): BoardPulseGame =>
  ({ id, status: "preview", homeScore: null, awayScore: null, inningHalf: null, inningOrdinal: null, favorite: "home", totalLine: null });

const many = (n: number, make: (id: string) => BoardPulseGame, prefix: string) =>
  Array.from({ length: n }, (_, i) => make(`${prefix}${i}`));

function main() {
  // ==== Data source (unchanged core fix) ====

  // A. Expected upsets is fixed to the full slate, all day.
  {
    const morning = [...many(2, favWin, "a"), ...many(2, dogWin, "b"), ...many(11, notStarted, "c")];
    const nightfall = [...many(9, favWin, "a"), ...many(6, dogWin, "b")];
    check("A: morning gameCount is the full slate", computeBoardPulse(morning).gameCount, 15);
    check("A: nightfall gameCount is the full slate", computeBoardPulse(nightfall).gameCount, 15);
    check(
      "A: expectedUpsets identical morning vs nightfall",
      computeBoardPulse(morning).expectedUpsets,
      computeBoardPulse(nightfall).expectedUpsets
    );
    check("A: expectedUpsets = full slate x rate", computeBoardPulse(morning).expectedUpsets, 15 * MLB_UNDERDOG_WIN_RATE);
  }

  // B. Finished games keep contributing after they leave the board.
  {
    const games = [favWin("f0"), favWin("f1"), dogWin("f2"), dogWin("f3"), ...many(11, notStarted, "p")];
    const s = computeBoardPulse(games);
    check("B: final favorite wins counted", s.favsWon, 2);
    check("B: final underdog wins counted", s.dogsWon, 2);
    check("B: confirmed upsets counted", s.upsetsConfirmed, 2);
    check("B: decidedGames = finals only", s.decidedGames, 4);
  }

  // C. Confirmed vs live split; blended fields add up.
  {
    const s = computeBoardPulse([favWin("a"), favWin("b"), dogWin("c"), favLeadingLive("d"), dogLeadingLive("e")]);
    check("C: favsWon / dogsWon", [s.favsWon, s.dogsWon], [2, 1]);
    check("C: favsLeadingLive / dogsLeadingLive", [s.favsLeadingLive, s.dogsLeadingLive], [1, 1]);
    check("C: favsLeading = won + leading", s.favsLeading, 3);
    check("C: dogsLeading = won + leading", s.dogsLeading, 2);
    check("C: upsetsLive = dogsLeadingLive", s.upsetsLive, 1);
    check("C: upsetRate preserved (confirmed / decided)", s.upsetRate, 1 / 3);
    check("C: deprecated aliases point at confirmed values", [s.upsetsSoFar, s.gamesSoFar], [s.upsetsConfirmed, s.decidedGames]);
  }

  // D. Not-yet-started games count toward expectedUpsets, not "so far".
  {
    const s = computeBoardPulse(many(10, notStarted, "p"));
    check("D: gameCount includes previews", s.gameCount, 10);
    check("D: expectedUpsets includes previews", s.expectedUpsets, 10 * MLB_UNDERDOG_WIN_RATE);
    check("D: nothing decided yet", [s.upsetsConfirmed, s.decidedGames], [0, 0]);
    check("D: upsetRate null with nothing decided", s.upsetRate, null);
    check("D: favsLeading / dogsLeading 0", [s.favsLeading, s.dogsLeading], [0, 0]);
  }

  // ==== Pace-relative verdict ====

  // 1. expectedUpsetsSoFar = decidedGames x 0.427 (pro-rated to FINISHED games,
  //    unaffected by live / not-yet-started games on the slate).
  {
    const s = computeBoardPulse([favWin("a"), favWin("b"), dogWin("c"), favLeadingLive("d"), notStarted("e")]);
    check("1: decidedGames = 3 (live + preview excluded)", s.decidedGames, 3);
    check("1: expectedUpsetsSoFar = decidedGames x rate", s.expectedUpsetsSoFar, 3 * MLB_UNDERDOG_WIN_RATE);
  }

  // 2. Known paceDelta sign and magnitude: 5 finished, 4 upsets.
  //    expectedUpsetsSoFar = 5 x 0.427 = 2.135 ; paceDelta = 4 - 2.135 = 1.865.
  {
    const s = computeBoardPulse([...many(4, dogWin, "d"), favWin("f")]);
    check("2: decidedGames", s.decidedGames, 5);
    check("2: upsetsConfirmed", s.upsetsConfirmed, 4);
    approx("2: expectedUpsetsSoFar = 5 x 0.427", s.expectedUpsetsSoFar, 2.135);
    approx("2: paceDelta = 4 - 2.135", s.paceDelta, 1.865);
    check("2: paceDelta positive", s.paceDelta > 0, true);
    approx("2: sigma = sqrt(5 x 0.427 x 0.573)", s.sigma, Math.sqrt(5 * 0.427 * 0.573));
    check("2: paceDelta (1.865) > sigma (~1.106) -> hot", s.verdict, "hot");
  }

  // 3. decidedGames === 0 -> pace fields are zero, verdict insufficient.
  {
    const s = computeBoardPulse([...many(4, notStarted, "p"), favLeadingLive("l")]);
    check("3: decidedGames 0", s.decidedGames, 0);
    check("3: expectedUpsetsSoFar 0", s.expectedUpsetsSoFar, 0);
    check("3: paceDelta 0", s.paceDelta, 0);
    check("3: sigma 0", s.sigma, 0);
    check("3: verdict insufficient", s.verdict, "insufficient");
  }

  // classifyPace boundary cases - the exact +/-sigma edges can't be produced by
  // an integer upset count from a real fixture, so drive the decision directly.
  const N = MIN_GAMES_FOR_VERDICT; // 3 - enough decided games for a real verdict

  // 4. paceDelta exactly +sigma -> "on pace" (band is inclusive; "hot" is strictly above).
  check("4: paceDelta === +sigma -> on pace", classifyPace(1.0, 1.0, N), "on pace");

  // 5. paceDelta just above +sigma -> "hot".
  check("5: paceDelta just above +sigma -> hot", classifyPace(1.0 + 1e-9, 1.0, N), "hot");

  // 6. paceDelta exactly -sigma -> "on pace".
  check("6: paceDelta === -sigma -> on pace", classifyPace(-1.0, 1.0, N), "on pace");

  // 7. paceDelta just below -sigma -> "cold".
  check("7: paceDelta just below -sigma -> cold", classifyPace(-1.0 - 1e-9, 1.0, N), "cold");

  // 8. Fewer than MIN_GAMES_FOR_VERDICT decided -> "insufficient" no matter the pace.
  check("8: 2 decided, huge positive paceDelta -> insufficient", classifyPace(999, 0.1, 2), "insufficient");
  check("8: 2 decided, huge negative paceDelta -> insufficient", classifyPace(-999, 0.1, 2), "insufficient");
  check("8: 0 decided -> insufficient", classifyPace(0, 0, 0), "insufficient");

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
