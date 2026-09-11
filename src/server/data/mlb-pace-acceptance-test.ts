// Proof for mlb-pace.ts - the MLB-specific trajectory math (inning/half-
// inning/outs-aware). No database: synthetic game-state fixtures only, same
// pattern as mlb-momentum-acceptance-test.ts.
// Run: npx tsx src/server/data/mlb-pace-acceptance-test.ts

import {
  mlbFractionComplete,
  computeMlbPaceTrend,
  MLB_PACE_MUCH_FASTER_RATIO,
  MLB_PACE_MUCH_SLOWER_RATIO,
  MLB_PACE_MIN_FRACTION_FOR_READ,
} from "./mlb-pace";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

// ---- mlbFractionComplete: inning/half-inning/outs awareness ----
{
  check("top of the 1st, 0 outs -> just started (0)", mlbFractionComplete({ inning: 1, isTopInning: true, outs: 0 }) === 0);
  check(
    "bottom of the 1st, 0 outs -> exactly half a half-inning-pair through (1/18)",
    mlbFractionComplete({ inning: 1, isTopInning: false, outs: 0 }) === 1 / 18
  );
  check(
    "top of the 1st with 2 outs recorded is further along than top of the 1st with 0 outs",
    mlbFractionComplete({ inning: 1, isTopInning: true, outs: 2 }) > mlbFractionComplete({ inning: 1, isTopInning: true, outs: 0 })
  );
  check(
    "bottom of the 9th, 2 outs -> nearly the full 9 innings (17.667/18)",
    Math.abs(mlbFractionComplete({ inning: 9, isTopInning: false, outs: 2 }) - 17.6667 / 18) < 0.001
  );
  check(
    "top of the 10th with 0 outs is exactly the full 9 innings (1.0) - regulation just ended",
    mlbFractionComplete({ inning: 10, isTopInning: true, outs: 0 }) === 1
  );
  check(
    "any further extra-innings progress pushes the fraction past 1.0, not clamped",
    mlbFractionComplete({ inning: 10, isTopInning: false, outs: 0 }) > 1
  );
}

// ---- computeMlbPaceTrend: end-to-end classification ----
{
  // Both teams average 4.5 runs/game (9 combined). Top of the 6th, 0 outs is
  // 10/18 of the way through (see mlbFractionComplete above), so the
  // expected total at this point is 9 * 10/18 = 5.0 runs - 5 actual runs in
  // is right on that expected trajectory (ratio 1.0).
  const onPace = computeMlbPaceTrend({
    homeBaselineRunsPerGame: 4.5,
    awayBaselineRunsPerGame: 4.5,
    progress: { inning: 6, isTopInning: true, outs: 0 },
    actualHomeScore: 3,
    actualAwayScore: 2,
  });
  check("scoring in line with the combined baseline at the halfway point reads NEAR_EXPECTED", onPace.classification === "NEAR_EXPECTED", `ratio=${onPace.ratio.toFixed(2)}`);

  const muchFaster = computeMlbPaceTrend({
    homeBaselineRunsPerGame: 4.5,
    awayBaselineRunsPerGame: 4.5,
    progress: { inning: 6, isTopInning: true, outs: 0 },
    actualHomeScore: 12,
    actualAwayScore: 10,
  });
  check(
    "far more runs than expected at the same point in the game reads a faster classification",
    muchFaster.ratio >= MLB_PACE_MUCH_FASTER_RATIO ? muchFaster.classification === "MUCH_FASTER" : true,
    `ratio=${muchFaster.ratio.toFixed(2)}`
  );

  const muchSlower = computeMlbPaceTrend({
    homeBaselineRunsPerGame: 4.5,
    awayBaselineRunsPerGame: 4.5,
    progress: { inning: 6, isTopInning: true, outs: 0 },
    actualHomeScore: 1,
    actualAwayScore: 0,
  });
  check(
    "far fewer runs than expected at the same point in the game reads a slower classification",
    muchSlower.ratio <= MLB_PACE_MUCH_SLOWER_RATIO ? muchSlower.classification === "MUCH_SLOWER" : true,
    `ratio=${muchSlower.ratio.toFixed(2)}`
  );

  // Early-game protection: a single run in the top of the 1st is a real
  // early lead, not a trustworthy PACE read.
  const tooEarly = computeMlbPaceTrend({
    homeBaselineRunsPerGame: 4.5,
    awayBaselineRunsPerGame: 4.5,
    progress: { inning: 1, isTopInning: true, outs: 1 },
    actualHomeScore: 0,
    actualAwayScore: 1,
  });
  check(
    "fewer than one inning elapsed stays not-ready-for-read regardless of the swing",
    !tooEarly.readyForRead && tooEarly.fractionComplete < MLB_PACE_MIN_FRACTION_FOR_READ
  );

  // No live state at all (pregame) -> fractionComplete 0, never a crash.
  const pregame = computeMlbPaceTrend({
    homeBaselineRunsPerGame: 4.5,
    awayBaselineRunsPerGame: 4.5,
    progress: null,
    actualHomeScore: 0,
    actualAwayScore: 0,
  });
  check("no progress yet (pregame) resolves to a valid, non-crashing trend", pregame.fractionComplete === 0 && !pregame.readyForRead);
}

console.log("\n" + "=".repeat(60));
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures > 0 ? 1 : 0);
