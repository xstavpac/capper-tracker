// Proof for nfl-momentum.ts - the pure rate-of-change + factor engine
// behind the NFL Momentum panel. No database, no live ESPN endpoint:
// everything here is fed synthetic inputs, matching nfl-momentum-data.ts's
// split of "pure engine" vs "I/O orchestration" (same shape as
// mlb-momentum-acceptance-test.ts, kept independent per this file's own
// header - not shared assertions, not shared fixtures).
// Run: npx tsx src/server/data/nfl-momentum-acceptance-test.ts

import {
  computeNflMomentumTrend,
  recentScoringFactor,
  driveSuccessFactor,
  possessionFactor,
  yardsPerDriveFactor,
  turnoversFactor,
  thirdDownFactor,
  redZoneFactor,
  NFL_MOMENTUM_WINDOW_PLAYS,
  NFL_MOMENTUM_STRONG_THRESHOLD,
  NFL_MOMENTUM_LEAN_THRESHOLD,
  NFL_MOMENTUM_MIN_DELTAS_FOR_READ,
} from "./nfl-momentum";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

function points(pcts: number[]): { homeWinPercentage: number }[] {
  return pcts.map((homeWinPercentage) => ({ homeWinPercentage }));
}

// ---- computeNflMomentumTrend: the core rate-of-change guardrail ----
{
  const empty = computeNflMomentumTrend([]);
  check("no observations -> EVEN, no data", empty.classification === "EVEN" && empty.currentHomeWinPercentage === null);

  // Missing WP data entirely (e.g. a game whose summary fetch returned an
  // empty winprobability array - pregame, or a malformed upstream response
  // that normalized to nothing) must never crash or fabricate a lean.
  check("missing WP data classifies EVEN, not a crash", computeNflMomentumTrend([]).classification === "EVEN");

  // The core guardrail: a team sitting at a HIGH absolute win percentage
  // with a FLAT recent trend must read EVEN, not "strong" - classification
  // comes from rate of change, never the absolute level. All values below
  // sit at 85%+ home WP the whole window.
  const flatButLopsided = computeNflMomentumTrend(points([86, 85.6, 85.9, 85.4, 85.7, 85.5, 85.8, 85.3, 85.6, 85.5, 85.7]));
  check(
    "flat trend at a lopsided absolute WP still reads EVEN",
    flatButLopsided.classification === "EVEN",
    `netShift=${flatButLopsided.netShift.toFixed(2)}`
  );

  // A team moving 45% -> 55% -> 65% (the example named in the task) must
  // register clear positive (toward-home) momentum.
  const risingExample = computeNflMomentumTrend(points([45, 50, 55, 60, 65]));
  check("45% -> 55% -> 65% nets a positive shift", risingExample.netShift > 0, `netShift=${risingExample.netShift.toFixed(2)}`);
  check(
    "and clears at least a lean toward home",
    risingExample.classification === "LEAN_HOME" || risingExample.classification === "STRONG_HOME",
    risingExample.classification
  );

  // WP decrease toward the away team.
  const fallingExample = computeNflMomentumTrend(points([60, 52, 45, 38, 30, 25]));
  check("a real fall in home WP nets a negative shift", fallingExample.netShift < 0);
  check(
    "and classifies as an away lean or strong away",
    fallingExample.classification === "LEAN_AWAY" || fallingExample.classification === "STRONG_AWAY",
    fallingExample.classification
  );

  // Neutral / small movement - well inside the lean threshold - must stay
  // EVEN even with plenty of observations to trust.
  const smallMovement = computeNflMomentumTrend(points([50, 51, 50, 52, 51, 50, 49, 50, 51, 50, 50]));
  check(
    "small back-and-forth movement stays EVEN",
    smallMovement.classification === "EVEN",
    `netShift=${smallMovement.netShift.toFixed(2)}`
  );

  // Early-game protection: too few observations to trust, even given a big
  // swing in the little data available.
  const tooEarly = computeNflMomentumTrend(points([50, 80]));
  check(
    "fewer deltas than the minimum stays EVEN regardless of swing size",
    tooEarly.classification === "EVEN" && tooEarly.deltasConsidered < NFL_MOMENTUM_MIN_DELTAS_FOR_READ
  );

  // Multiple successive observations: classification should track a
  // gradually building shift across three growing windows, moving from
  // EVEN -> a lean -> strong as more of the same-direction shift enters the
  // window (still same window size throughout, just larger observations).
  const gentle = computeNflMomentumTrend(points([50, 51, 52, 53, 54, 55]));
  const moderate = computeNflMomentumTrend(points([50, 53, 56, 59, 62, 65]));
  const large = computeNflMomentumTrend(points([50, 56, 62, 68, 74, 80]));
  check("gentle successive shift (net +5) stays EVEN", gentle.classification === "EVEN", `netShift=${gentle.netShift}`);
  check(
    "moderate successive shift clears at least a lean",
    moderate.classification === "LEAN_HOME" || moderate.classification === "STRONG_HOME",
    `netShift=${moderate.netShift} class=${moderate.classification}`
  );
  check(
    "large successive shift clears strong",
    large.classification === "STRONG_HOME",
    `netShift=${large.netShift} class=${large.classification}`
  );

  // Threshold boundary sanity - hardcoded integer-delta arrays (exact sums,
  // no floating-point accumulation risk), each built to fit within ONE
  // window (NFL_MOMENTUM_WINDOW_PLAYS points, so slice(-window) keeps every
  // point and the sum is not silently truncated by the window cap - a
  // formula scaled off the threshold constants alone would risk exceeding
  // the window and testing a truncated, wrong netShift instead).
  const leanFixture = [50, 51, 52, 53, 54, 55, 56, 57, 58, 58];
  const strongFixture = [50, 52, 54, 56, 58, 60, 62, 64, 66, 70];
  check(
    "test fixtures below fit within one window (guards the two checks after this one)",
    leanFixture.length <= NFL_MOMENTUM_WINDOW_PLAYS && strongFixture.length <= NFL_MOMENTUM_WINDOW_PLAYS
  );

  // 9 deltas summing to exactly NFL_MOMENTUM_LEAN_THRESHOLD (8): eight +1s
  // and one +0, in 10 points (this window's exact size).
  const exactlyLean = computeNflMomentumTrend(points(leanFixture));
  check(
    "a shift landing on the lean threshold classifies as a lean, not even or strong",
    exactlyLean.netShift === NFL_MOMENTUM_LEAN_THRESHOLD && exactlyLean.classification === "LEAN_HOME",
    `netShift=${exactlyLean.netShift} class=${exactlyLean.classification}`
  );

  // 9 deltas summing to exactly NFL_MOMENTUM_STRONG_THRESHOLD (20): eight
  // +2s and one +4, in 10 points.
  const exactlyStrong = computeNflMomentumTrend(points(strongFixture));
  check(
    "a shift landing on the strong threshold classifies as strong",
    exactlyStrong.netShift === NFL_MOMENTUM_STRONG_THRESHOLD && exactlyStrong.classification === "STRONG_HOME",
    `netShift=${exactlyStrong.netShift} class=${exactlyStrong.classification}`
  );

  // Window bound: only the most recent NFL_MOMENTUM_WINDOW_PLAYS
  // observations matter - a huge early swing that has fully scrolled out of
  // the window must not still drive classification.
  const scrolledOut = computeNflMomentumTrend([
    { homeWinPercentage: 5 },
    { homeWinPercentage: 95 }, // huge early swing, now far outside the window
    ...points([50, 50.5, 51, 50.5, 51, 50, 50.5, 51, 50, 50.5, 51, 50]),
  ]);
  check(
    "an old swing that has scrolled out of the window no longer drives classification",
    scrolledOut.classification === "EVEN",
    `netShift=${scrolledOut.netShift.toFixed(2)}`
  );
}

// ---- Factors: each degrades to "unavailable" rather than fabricating a lean ----
{
  const noScoring = recentScoringFactor(
    { teamName: "NE", avgPointsLastN: null, gamesConsidered: 0 },
    { teamName: "SEA", avgPointsLastN: null, gamesConsidered: 0 }
  );
  check("recentScoringFactor is unavailable with no finished games", noScoring.lean === "unavailable");

  const scoringLeanAway = recentScoringFactor(
    { teamName: "NE", avgPointsLastN: 17.2, gamesConsidered: 5 },
    { teamName: "SEA", avgPointsLastN: 27.8, gamesConsidered: 5 }
  );
  check("recentScoringFactor leans toward the higher recent scoring average", scoringLeanAway.lean === "away");

  const noDrives = driveSuccessFactor("SF", "LAR", null, null, []);
  check("driveSuccessFactor is unavailable with no abbreviations/drives", noDrives.lean === "unavailable");

  const drives = [
    { teamAbbreviation: "LAR", isScore: true },
    { teamAbbreviation: "SF", isScore: false },
    { teamAbbreviation: "LAR", isScore: true },
    { teamAbbreviation: "SF", isScore: false },
    { teamAbbreviation: "LAR", isScore: false },
  ];
  const driveLeanHome = driveSuccessFactor("LA Rams", "SF 49ers", "LAR", "SF", drives);
  check("driveSuccessFactor leans toward the team with the better recent scoring-drive rate", driveLeanHome.lean === "home");

  const noPossession = possessionFactor("NE", "SEA", "NE", "SEA", null, null, null, null);
  check("possessionFactor is unavailable before the game starts", noPossession.lean === "unavailable");

  const possessionLeanAway = possessionFactor("NE", "SEA", "NE", "SEA", "SEA", 900, 1500, {
    down: 1,
    distance: 10,
    yardLine: 35,
  });
  check("possessionFactor leans toward the team controlling more time of possession", possessionLeanAway.lean === "away");
  check("possessionFactor detail names who currently has the ball", possessionLeanAway.detail.includes("SEA have the ball"));
  check("possessionFactor detail includes the live down & distance", possessionLeanAway.detail.includes("1st & 10"));

  const noYpd = yardsPerDriveFactor("NE", "SEA", null, null, null, null);
  check("yardsPerDriveFactor is unavailable with no drives yet", noYpd.lean === "unavailable");

  const ypdLeanHome = yardsPerDriveFactor("NE", "SEA", 350, 10, 210, 9);
  check("yardsPerDriveFactor leans toward the higher yards/drive", ypdLeanHome.lean === "home");

  const noTurnovers = turnoversFactor("NE", "SEA", null, null);
  check("turnoversFactor is unavailable with no data yet", noTurnovers.lean === "unavailable");
  const turnoversEven = turnoversFactor("NE", "SEA", 1, 1);
  check("turnoversFactor is even when turnover counts match", turnoversEven.lean === "even");
  const turnoversLeanHome = turnoversFactor("NE", "SEA", 0, 2);
  check("turnoversFactor leans toward the team with FEWER turnovers", turnoversLeanHome.lean === "home");

  const noThirdDown = thirdDownFactor("NE", "SEA", null, null, null, null);
  check("thirdDownFactor is unavailable with no attempts yet", noThirdDown.lean === "unavailable");
  const thirdDownLeanAway = thirdDownFactor("NE", "SEA", 2, 9, 7, 12);
  check("thirdDownFactor leans toward the better conversion rate", thirdDownLeanAway.lean === "away");

  const noRedZone = redZoneFactor("NE", "SEA", null, null, null, null, false, null);
  check("redZoneFactor is unavailable with no red-zone trips yet", noRedZone.lean === "unavailable");
  const redZoneLeanAway = redZoneFactor("NE", "SEA", 1, 3, 2, 3, true, "SEA");
  check("redZoneFactor leans toward the better red-zone efficiency", redZoneLeanAway.lean === "away");
  check(
    "redZoneFactor surfaces the live isRedZone flag when a team is currently driving in it",
    redZoneLeanAway.detail.includes("SEA currently driving in the red zone")
  );
  const redZoneNoCurrent = redZoneFactor("NE", "SEA", 1, 3, 2, 3, false, null);
  check(
    "redZoneFactor omits the live-drive note when nobody is currently in the red zone",
    !redZoneNoCurrent.detail.includes("currently driving")
  );
}

console.log("\n" + "=".repeat(60));
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures > 0 ? 1 : 0);
