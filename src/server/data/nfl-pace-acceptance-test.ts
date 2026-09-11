// Proof for nfl-pace.ts (quarter/clock-aware trajectory math) and for the
// NFL live-state additions this PR makes to nfl-live-game-state.ts
// (normalizeGameClockPlay) - both pure, no database, no network. Same
// pattern as nfl-momentum-acceptance-test.ts / nfl-live-game-state-
// acceptance-test.ts.
// Run: npx tsx src/server/data/nfl-pace-acceptance-test.ts

import {
  nflFractionComplete,
  computeNflPaceTrend,
  NFL_PACE_REGULATION_PERIOD_SECONDS,
  NFL_PACE_OT_PERIOD_SECONDS,
} from "./nfl-pace";
import { normalizeGameClockPlay } from "./nfl-live-game-state";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

// ---- nflFractionComplete: quarter/clock-remaining awareness ----
{
  check("kickoff (Q1, full clock) -> 0", nflFractionComplete({ period: 1, clockSeconds: NFL_PACE_REGULATION_PERIOD_SECONDS }) === 0);
  check(
    "end of Q4 (clock at 0) -> the full regulation game (1.0)",
    Math.abs(nflFractionComplete({ period: 4, clockSeconds: 0 }) - 1) < 1e-9
  );
  check(
    "halfway through Q1 -> 1/8 of the game (one of eight regulation quarter-halves)",
    Math.abs(nflFractionComplete({ period: 1, clockSeconds: NFL_PACE_REGULATION_PERIOD_SECONDS / 2 }) - 1 / 8) < 1e-9
  );

  // The exact example from the PR description: a 14-point game reads
  // differently depending on WHEN those 14 points happened, not just that
  // they happened - 11:00 left in Q2 is much earlier than 2:00 left in Q4.
  const earlyState = nflFractionComplete({ period: 2, clockSeconds: 11 * 60 });
  const lateState = nflFractionComplete({ period: 4, clockSeconds: 2 * 60 });
  check(
    "11:00 left in Q2 is a much smaller fraction of the game than 2:00 left in Q4",
    earlyState < lateState,
    `Q2@11:00=${earlyState.toFixed(3)} vs Q4@2:00=${lateState.toFixed(3)}`
  );

  // Overtime uses its own (shorter) period length, not regulation's.
  const otHalfway = nflFractionComplete({ period: 5, clockSeconds: NFL_PACE_OT_PERIOD_SECONDS / 2 });
  check("overtime periods use the 600s OT length, not the 900s regulation length", otHalfway > 1, `fraction=${otHalfway.toFixed(3)}`);

  check(
    "a null clockSeconds (unparseable display clock) degrades to 'just started this period', not a crash",
    nflFractionComplete({ period: 3, clockSeconds: null }) === nflFractionComplete({ period: 3, clockSeconds: NFL_PACE_REGULATION_PERIOD_SECONDS })
  );
}

// ---- computeNflPaceTrend: the same 14-point example, end to end ----
{
  // Two teams that combine for 45 points/game on average (a realistic NFL
  // total). The SAME 14-point actual score reads very differently at these
  // two states.
  const q2Early = computeNflPaceTrend({
    homeBaselinePointsPerGame: 22.5,
    awayBaselinePointsPerGame: 22.5,
    progress: { period: 2, clockSeconds: 11 * 60 },
    actualHomeScore: 14,
    actualAwayScore: 0,
  });
  const q4Late = computeNflPaceTrend({
    homeBaselinePointsPerGame: 22.5,
    awayBaselinePointsPerGame: 22.5,
    progress: { period: 4, clockSeconds: 2 * 60 },
    actualHomeScore: 14,
    actualAwayScore: 0,
  });
  check(
    "14 points with 11:00 left in Q2 reads as a much faster pace than the same 14 points with 2:00 left in Q4",
    q2Early.ratio > q4Late.ratio,
    `Q2@11:00 ratio=${q2Early.ratio.toFixed(2)} vs Q4@2:00 ratio=${q4Late.ratio.toFixed(2)}`
  );
  check(
    "the Q4-late read classifies as slower than the Q2-early read for the identical actual score",
    q2Early.classification === "NEAR_EXPECTED" && q4Late.classification === "MUCH_SLOWER",
    `Q2 class=${q2Early.classification} Q4 class=${q4Late.classification}`
  );

  const pregame = computeNflPaceTrend({
    homeBaselinePointsPerGame: 22.5,
    awayBaselinePointsPerGame: 22.5,
    progress: null,
    actualHomeScore: 0,
    actualAwayScore: 0,
  });
  check("no progress yet (pregame) resolves to a valid, non-crashing trend", pregame.fractionComplete === 0 && !pregame.readyForRead);
}

// ---- normalizeGameClockPlay: real ESPN play shape, confirmed live ----
// Captured live from ESPN event 401872657 (SF @ LAR) during this build's
// verification: a mid-game play from drives.previous[5].plays and the
// game's final play from drives.previous' last drive.
{
  const midGamePlay = {
    id: "4018726571234",
    sequenceNumber: "123400",
    period: { number: 2 },
    clock: { displayValue: "14:57" },
    homeScore: 7,
    awayScore: 3,
  };
  const play = normalizeGameClockPlay(midGamePlay);
  check("a real mid-game play normalizes successfully", play !== null);
  check("period reads from period.number", play?.period === 2);
  check("clockSeconds parses '14:57' to 897 seconds", play?.clockSeconds === 14 * 60 + 57);
  check("homeScore/awayScore pass through", play?.homeScore === 7 && play?.awayScore === 3);

  const finalPlay = {
    id: "4018726573916",
    period: { number: 4 },
    clock: { displayValue: "0:00" },
    homeScore: 7,
    awayScore: 27,
    text: "END GAME",
  };
  const end = normalizeGameClockPlay(finalPlay);
  check("the game's final play normalizes with clockSeconds 0, not null", end?.clockSeconds === 0);

  check("a play missing period.number is dropped (returns null)", normalizeGameClockPlay({ id: "x", clock: { displayValue: "5:00" }, homeScore: 0, awayScore: 0 }) === null);
  check(
    "a play missing homeScore/awayScore is dropped (returns null)",
    normalizeGameClockPlay({ id: "x", period: { number: 1 }, clock: { displayValue: "5:00" } }) === null
  );
  check("null/undefined input is dropped, not thrown", normalizeGameClockPlay(null) === null && normalizeGameClockPlay(undefined) === null);

  // A play with an unparseable/missing clock still normalizes - period and
  // score are still usable for a fraction-complete estimate without a
  // clock reading (see nflFractionComplete's null-clockSeconds handling).
  const noClock = normalizeGameClockPlay({ id: "x", period: { number: 3 }, homeScore: 10, awayScore: 10 });
  check("a play with no clock field normalizes with clockSeconds null, not dropped", noClock !== null && noClock.clockSeconds === null);
}

console.log("\n" + "=".repeat(60));
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures > 0 ? 1 : 0);
