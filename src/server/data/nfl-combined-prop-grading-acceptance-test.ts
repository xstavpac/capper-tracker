// Proof for resolvePlayerProp/gradePlayerProp's two combined-category
// markets (RUSH_REC_YDS/PASS_RUSH_YDS - grading.ts), run with:
//   npx tsx src/server/data/nfl-combined-prop-grading-acceptance-test.ts
//
// Companion to nfl-yardage-prop-grading-acceptance-test.ts (the original
// 4-market PR) - reuses the exact same real, live-fetched Week 1 2026 NFL
// box scores that file already established ground truth for, so the sums
// below are independently checkable against that file's own header:
//
//   401872660  HOU @ BUF   Josh Allen (BUF) passingYards 334, rushingYards 23
//                            -> pass+rush = 357
//                          James Cook III (BUF) rushingYards 57,
//                          receivingYards 12 -> rush+rec = 69
//   401872658  PIT @ ATL   Bijan Robinson (ATL) rushingYards 83,
//                          receivingYards 90 -> rush+rec = 173
//                          Jaylen Warren (PIT) rushingYards 46,
//                          receivingYards 27 -> rush+rec = 73
//                          Cooper Rush (ATL) passingYards 143, no carries at
//                          all this game - genuinely absent from
//                          extractRushingRows, not a zero-yard row -
//                          confirmed by a separate live check of this same
//                          event's ESPN summary response (not reused from
//                          nfl-yardage-prop-grading-acceptance-test.ts,
//                          which never needed this player) -> pass+rush =
//                          143 + 0 = 143
//
// Run with: npx tsx src/server/data/nfl-combined-prop-grading-acceptance-test.ts
import { resolvePlayerProp, type PlayerPropResolution } from "@/server/data/grading";

let failures = 0;

async function expectAsync(label: string, actual: Promise<PlayerPropResolution>, expected: PlayerPropResolution) {
  const resolved = await actual;
  const pass = JSON.stringify(resolved) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} - expected=${JSON.stringify(expected)} actual=${JSON.stringify(resolved)}`);
  if (!pass) failures++;
}

const HOU_BUF = "401872660"; // Houston Texans @ Buffalo Bills
const PIT_ATL = "401872658"; // Pittsburgh Steelers @ Atlanta Falcons

function structuredPick(opts: {
  betDetail: string;
  propMarket: "RUSH_REC_YDS" | "PASS_RUSH_YDS";
  playerName: string;
  homeTeam: string;
  awayTeam: string;
}) {
  return { ...opts, homeTeam: opts.homeTeam, awayTeam: opts.awayTeam };
}

function legacyPick(betDetail: string, homeTeam: string, awayTeam: string) {
  return { betDetail, propMarket: null, playerName: null, homeTeam, awayTeam };
}

async function main() {
  // =====================================================================
  // RUSH_REC_YDS
  // =====================================================================

  // Clear WIN, sum of two real box-score categories: 57 + 12 = 69, well
  // over a 55.5 line.
  await expectAsync(
    "RUSH_REC_YDS clear WIN: James Cook III Over 55.5 Rushing and Receiving Yards (actual 57+12=69)",
    resolvePlayerProp(
      legacyPick("Bills James Cook III Over 55.5 Rushing and Receiving Yards", "Buffalo Bills", "Houston Texans"),
      HOU_BUF,
      "NFL"
    ),
    { outcome: "WIN" }
  );

  // Clear LOSS: Under bet, actual (83+90=173) exceeds the line.
  await expectAsync(
    "RUSH_REC_YDS clear LOSS: Bijan Robinson Under 150.5 Rush + Rec Yards (actual 83+90=173)",
    resolvePlayerProp(
      legacyPick("Falcons Bijan Robinson Under 150.5 Rush + Rec Yards", "Atlanta Falcons", "Pittsburgh Steelers"),
      PIT_ATL,
      "NFL"
    ),
    { outcome: "LOSS" }
  );

  // Real PUSH on a capper-typed whole-number line: Jaylen Warren's real sum
  // is 46 + 27 = 73 exactly.
  await expectAsync(
    "RUSH_REC_YDS real PUSH on a whole-number line: Jaylen Warren Over 73 Rush and Rec Yards (actual 46+27=73 exactly)",
    resolvePlayerProp(
      legacyPick("Steelers Jaylen Warren Over 73 Rush and Rec Yards", "Pittsburgh Steelers", "Atlanta Falcons"),
      PIT_ATL,
      "NFL"
    ),
    { outcome: "PUSH" }
  );

  // Structured (propMarket-populated) vs legacy (propMarket null) resolve
  // identically for the same real pick/game.
  await expectAsync(
    "RUSH_REC_YDS structured path matches legacy path",
    resolvePlayerProp(
      structuredPick({
        betDetail: "Bills James Cook III Over 55.5 Rushing and Receiving Yards",
        propMarket: "RUSH_REC_YDS",
        playerName: "Bills James Cook III",
        homeTeam: "Buffalo Bills",
        awayTeam: "Houston Texans",
      }),
      HOU_BUF,
      "NFL"
    ),
    { outcome: "WIN" }
  );

  // =====================================================================
  // PASS_RUSH_YDS
  // =====================================================================

  // Clear WIN: Josh Allen's real sum is 334 + 23 = 357, well over 300.5.
  await expectAsync(
    "PASS_RUSH_YDS clear WIN: Josh Allen Over 300.5 Passing and Rushing Yards (actual 334+23=357)",
    resolvePlayerProp(
      legacyPick("Bills Josh Allen Over 300.5 Passing and Rushing Yards", "Buffalo Bills", "Houston Texans"),
      HOU_BUF,
      "NFL"
    ),
    { outcome: "WIN" }
  );

  // Same real pick, using the "passing and receiving" typo phrasing this PR
  // maps straight to PASS_RUSH_YDS - must resolve identically to the
  // correctly-worded phrase above, not decline or grade against a
  // nonexistent pass+receiving stat.
  await expectAsync(
    "PASS_RUSH_YDS typo phrasing resolves identically: Josh Allen Over 300.5 Passing and Receiving Yards (actual 334+23=357)",
    resolvePlayerProp(
      legacyPick("Bills Josh Allen Over 300.5 Passing and Receiving Yards", "Buffalo Bills", "Houston Texans"),
      HOU_BUF,
      "NFL"
    ),
    { outcome: "WIN" }
  );

  // Missing-side-is-zero case: Cooper Rush threw for 143 and had zero
  // carries this game (genuinely absent from extractRushingRows entirely,
  // not a zero-yard row) - a real player still gradeable via PASS_RUSH_YDS,
  // proving "not in the rushing rows" is read as 0 rush yards, not as
  // "player not found in the box score" (which would decline instead).
  await expectAsync(
    "PASS_RUSH_YDS missing-side-is-zero: Cooper Rush Over 130.5 Passing and Rushing Yards (actual 143+0=143)",
    resolvePlayerProp(
      legacyPick("Falcons Cooper Rush Over 130.5 Passing and Rushing Yards", "Atlanta Falcons", "Pittsburgh Steelers"),
      PIT_ATL,
      "NFL"
    ),
    { outcome: "WIN" }
  );
  await expectAsync(
    "PASS_RUSH_YDS missing-side-is-zero, other direction: Cooper Rush Under 150.5 Passing and Rushing Yards (actual 143+0=143)",
    resolvePlayerProp(
      legacyPick("Falcons Cooper Rush Under 150.5 Passing and Rushing Yards", "Atlanta Falcons", "Pittsburgh Steelers"),
      PIT_ATL,
      "NFL"
    ),
    { outcome: "WIN" }
  );

  // Structured vs legacy, same real pick.
  await expectAsync(
    "PASS_RUSH_YDS structured path matches legacy path",
    resolvePlayerProp(
      structuredPick({
        betDetail: "Bills Josh Allen Over 300.5 Passing and Rushing Yards",
        propMarket: "PASS_RUSH_YDS",
        playerName: "Bills Josh Allen",
        homeTeam: "Buffalo Bills",
        awayTeam: "Houston Texans",
      }),
      HOU_BUF,
      "NFL"
    ),
    { outcome: "WIN" }
  );

  // =====================================================================
  // Edge cases
  // =====================================================================

  await expectAsync(
    "RUSH_REC_YDS: player not in this game's box score at all (neither rushing nor receiving rows) -> null + reason, not a guess",
    resolvePlayerProp(
      legacyPick("Bills Patrick Mahomes Over 50.5 Rushing and Receiving Yards", "Buffalo Bills", "Houston Texans"),
      HOU_BUF,
      "NFL"
    ),
    { outcome: null, reason: 'couldn\'t find "Patrick Mahomes" in the box score' }
  );

  await expectAsync(
    "PASS_RUSH_YDS: non-NFL sport -> same NFL-only guard every other market uses",
    resolvePlayerProp(
      structuredPick({
        betDetail: "Team Player Over 100.5 Passing and Rushing Yards",
        propMarket: "PASS_RUSH_YDS",
        playerName: "Player",
        homeTeam: "Alabama Crimson Tide",
        awayTeam: "Texas Longhorns",
      }),
      "fake-event-id",
      "NCAAF"
    ),
    { outcome: null, reason: "player-prop grading is NFL-only; this NCAAF pick needs manual grading" }
  );

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
