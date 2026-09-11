// Proof for mlb-momentum.ts - the pure rate-of-change + factor engine behind
// the MLB Momentum panel. No database: everything here is fed synthetic
// inputs, matching mlb-momentum-data.ts's split of "pure engine" vs
// "I/O orchestration" (same shape as game-pulse.ts's
// buildGamePulsePanelRows / getGamePulsePanelRows).
// Run: npx tsx src/server/data/mlb-momentum-acceptance-test.ts

import {
  computeMomentumTrend,
  currentPitcherForTeam,
  recentFormFactor,
  recentScoringFactor,
  inGameScoringFactor,
  baseOutFactor,
  startingPitcherFactor,
  bullpenUsageFactor,
  MOMENTUM_STRONG_THRESHOLD,
  MOMENTUM_LEAN_THRESHOLD,
  MOMENTUM_MIN_DELTAS_FOR_READ,
} from "./mlb-momentum";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

function playsWithWp(wps: number[]): { homeWinProbability: number }[] {
  return wps.map((homeWinProbability) => ({ homeWinProbability }));
}

// ---- computeMomentumTrend: the core rate-of-change guardrail ----
{
  const empty = computeMomentumTrend([]);
  check("no plays -> EVEN, no data", empty.classification === "EVEN" && empty.currentHomeWinProbability === null);

  // A HIGH absolute win probability with a FLAT recent trend must read EVEN,
  // not "strong home" - this is the guardrail from the whitepaper (Section
  // 6): Momentum classifies off rate of change, never off the absolute
  // level. All the values below sit at 90%+ home WP the whole window.
  const flatButLopsided = computeMomentumTrend(
    playsWithWp([90, 90.2, 89.9, 90.1, 90, 90.3, 89.8, 90.1, 90, 90.2, 90.1, 90])
  );
  check(
    "flat trend at a lopsided absolute WP still reads EVEN",
    flatButLopsided.classification === "EVEN",
    `netShift=${flatButLopsided.netShift.toFixed(2)}`
  );

  // The inverse: a genuine swing FROM a near-50/50 game should register even
  // though the absolute level never gets extreme.
  const risingTowardHome = computeMomentumTrend(playsWithWp([50, 52, 55, 58, 62, 66, 68]));
  check(
    "a real rise in home WP over the window nets a positive shift",
    risingTowardHome.netShift > 0,
    `netShift=${risingTowardHome.netShift.toFixed(2)}`
  );
  check(
    "a shift past the strong threshold classifies STRONG_HOME",
    risingTowardHome.netShift >= MOMENTUM_STRONG_THRESHOLD ? risingTowardHome.classification === "STRONG_HOME" : true
  );

  const fallingTowardAway = computeMomentumTrend(playsWithWp([50, 46, 42, 38, 33, 28]));
  check("a real fall in home WP nets a negative shift", fallingTowardAway.netShift < 0);
  check(
    "a big enough negative shift classifies as an away lean or strong away",
    fallingTowardAway.classification === "LEAN_AWAY" || fallingTowardAway.classification === "STRONG_AWAY",
    fallingTowardAway.classification
  );

  // Early-game protection (whitepaper Section 24): too few plays to trust,
  // even if the few plays available show a big swing.
  const tooEarly = computeMomentumTrend(playsWithWp([50, 70]));
  check(
    "fewer deltas than the minimum stays EVEN regardless of the swing size",
    tooEarly.classification === "EVEN" && tooEarly.deltasConsidered < MOMENTUM_MIN_DELTAS_FOR_READ
  );

  // Threshold boundary sanity: a shift landing exactly on the lean threshold
  // (via whole-point integer steps, so the sum is exact - no floating-point
  // accumulation risk) classifies as a lean, not even or strong. Enough
  // steps to also clear the minimum-deltas gate regardless of how either
  // constant is tuned later.
  const leanSteps = Math.max(MOMENTUM_LEAN_THRESHOLD, MOMENTUM_MIN_DELTAS_FOR_READ);
  const exactlyLean = computeMomentumTrend(
    playsWithWp([50, ...Array.from({ length: leanSteps }, (_, i) => 50 + Math.min(i + 1, MOMENTUM_LEAN_THRESHOLD))])
  );
  check(
    "a shift landing on the lean threshold classifies as a lean, not even or strong",
    exactlyLean.classification === "LEAN_HOME",
    `netShift=${exactlyLean.netShift} class=${exactlyLean.classification}`
  );
}

// ---- currentPitcherForTeam: scans backward for each side's own pitcher ----
{
  const plays = [
    { isTopInning: true, currentPitcherId: 100 }, // away batting, home (100) pitching
    { isTopInning: true, currentPitcherId: 100 },
    { isTopInning: false, currentPitcherId: 200 }, // home batting, away (200) pitching
    { isTopInning: true, currentPitcherId: 101 }, // home has changed pitchers
  ];
  check("home's current pitcher is the most recent one credited while home fielded", currentPitcherForTeam(plays, "home") === 101);
  check("away's current pitcher is the most recent one credited while away fielded", currentPitcherForTeam(plays, "away") === 200);
  check("a team that hasn't fielded yet has no current pitcher", currentPitcherForTeam([], "home") === null);
}

// ---- Factors: each degrades to "unavailable" rather than fabricating a lean ----
{
  const noForm = recentFormFactor(
    { teamName: "Cubs", last10WinPct: null, streak: null },
    { teamName: "Brewers", last10WinPct: null, streak: null }
  );
  check("recentFormFactor is unavailable when neither team has data", noForm.lean === "unavailable");

  const formLeanHome = recentFormFactor(
    { teamName: "Cubs", last10WinPct: 0.7, streak: 3 },
    { teamName: "Brewers", last10WinPct: 0.4, streak: -2 }
  );
  check("recentFormFactor leans toward the better L10 record", formLeanHome.lean === "home");
  check("recentFormFactor detail names both teams", formLeanHome.detail.includes("Cubs") && formLeanHome.detail.includes("Brewers"));

  const noScoring = recentScoringFactor(
    { teamName: "Cubs", avgRunsLastN: null, gamesConsidered: 0 },
    { teamName: "Brewers", avgRunsLastN: null, gamesConsidered: 0 }
  );
  check("recentScoringFactor is unavailable with no finished games", noScoring.lean === "unavailable");

  const scoringLeanAway = recentScoringFactor(
    { teamName: "Cubs", avgRunsLastN: 3.2, gamesConsidered: 5 },
    { teamName: "Brewers", avgRunsLastN: 5.8, gamesConsidered: 5 }
  );
  check("recentScoringFactor leans toward the higher recent scoring average", scoringLeanAway.lean === "away");

  const noInGame = inGameScoringFactor("Cubs", "Brewers", []);
  check("inGameScoringFactor is unavailable with fewer than 2 plays", noInGame.lean === "unavailable");

  const inGameLeanHome = inGameScoringFactor("Cubs", "Brewers", [
    { homeScore: 1, awayScore: 1 },
    { homeScore: 4, awayScore: 1 },
  ]);
  check("inGameScoringFactor leans toward whoever outscored the other within the window", inGameLeanHome.lean === "home");

  const noBaseOut = baseOutFactor("Cubs", "Brewers", null);
  check("baseOutFactor is unavailable before the game starts", noBaseOut.lean === "unavailable");

  const rispThreat = baseOutFactor("Cubs", "Brewers", { isTopInning: true, outs: 1, runnersOnBase: ["2B"], inning: 5 });
  check("baseOutFactor leans toward the batting (away) team with RISP and <2 outs", rispThreat.lean === "away");

  const rispTwoOuts = baseOutFactor("Cubs", "Brewers", { isTopInning: true, outs: 2, runnersOnBase: ["2B"], inning: 5 });
  check("baseOutFactor does NOT lean with RISP but 2 outs already", rispTwoOuts.lean === "even");

  const noPitchers = startingPitcherFactor("Cubs", "Brewers", null, null);
  check("startingPitcherFactor is unavailable with no announced starters", noPitchers.lean === "unavailable");

  const pitcherLeanHome = startingPitcherFactor(
    "Cubs",
    "Brewers",
    { pitcherName: "Imanaga", era: 2.8 },
    { pitcherName: "Peralta", era: 4.5 }
  );
  check("startingPitcherFactor leans toward the lower-ERA starter", pitcherLeanHome.lean === "home");

  const noBullpenData = bullpenUsageFactor(
    "Cubs",
    "Brewers",
    { starterPitcherId: null, currentPitcherId: null },
    { starterPitcherId: null, currentPitcherId: null }
  );
  check("bullpenUsageFactor is unavailable before the game starts", noBullpenData.lean === "unavailable");

  const bullpenIn = bullpenUsageFactor(
    "Cubs",
    "Brewers",
    { starterPitcherId: 1, currentPitcherId: 2 },
    { starterPitcherId: 3, currentPitcherId: 3 }
  );
  check("bullpenUsageFactor never assigns a directional lean (informational only)", bullpenIn.lean === "even");
  check("bullpenUsageFactor detail reports the side that changed pitchers", bullpenIn.detail.includes("bullpen in"));
  check("bullpenUsageFactor detail reports the side whose starter is still in", bullpenIn.detail.includes("starter still going"));
}

console.log("\n" + "=".repeat(60));
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures > 0 ? 1 : 0);
