// Proof for resolvePlayerProp/gradePlayerProp's four new structured markets
// (PASS_YDS/RUSH_YDS/REC_YDS/RECEPTIONS - grading.ts) - PR 3 of 3 (schema
// [merged, #72] -> parser/categorization [merged, #73] -> grading [this PR]).
// TD-prop grading (resolveTouchdownProp) is completely untouched by this PR
// and already covered by its own tests; this file only exercises the 4 new
// markets and the resolvePlayerProp dispatcher that routes to them.
//
// Real, live-fetched ESPN box-score data for three real Week 1 2026 NFL
// games (same events nfl-passer-rows-acceptance-test.ts and
// nfl-rushing-receiving-rows-acceptance-test.ts already use), not fixtures -
// same "hits the real network" convention as resolveTouchdownProp's own
// tests (getNflPlayerTdStats does a live fetch too). Ground-truth numbers
// below were pulled directly from fetchNflPasserRows/
// fetchNflRushingReceivingRows against these event ids before writing this
// file - see the PR report for the raw dump.
//
//   401872660  HOU @ BUF   Josh Allen (BUF) passingYards 334, rushingYards 23
//                          C.J. Stroud (HOU) passingYards 274
//                          David Montgomery (HOU) rushingYards 60
//                          James Cook III (BUF) rushingYards 57, receptions 3, receivingYards 12 (multi-market)
//                          Nico Collins (HOU) rushingYards 7, receptions 7, receivingYards 75 (multi-market)
//                          Dalton Kincaid (BUF) receptions 5, receivingYards 130
//                          DJ Moore (BUF) receptions 5, receivingYards 100
//   401872658  PIT @ ATL   Aaron Rodgers (PIT) passingYards 221
//                          Bijan Robinson (ATL) rushingYards 83, receptions 8, receivingYards 90 (multi-market)
//                          Jaylen Warren (PIT) rushingYards 46, receptions 5, receivingYards 27 (multi-market)
//                          Pat Freiermuth (PIT) receptions 5, receivingYards 46
//   401872927  MIN @ GB    Carson Wentz (MIN) passingYards 133
//                          Justin Jefferson (MIN) receptions 8, receivingYards 92
//                          Christian Watson (GB) receptions 6, receivingYards 147
//
// Run with: npx tsx src/server/data/nfl-yardage-prop-grading-acceptance-test.ts
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
const MIN_GB = "401872927"; // Minnesota Vikings @ Green Bay Packers

function structuredPick(opts: {
  betDetail: string;
  propMarket: "PASS_YDS" | "RUSH_YDS" | "REC_YDS" | "RECEPTIONS" | "TD";
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
  // PASS_YDS
  // =====================================================================

  // Clear WIN: Josh Allen threw for 334, well over 275.5.
  await expectAsync(
    "PASS_YDS clear WIN: Josh Allen Over 275.5 Passing Yards (actual 334)",
    resolvePlayerProp(
      legacyPick("Bills Josh Allen Over 275.5 Passing Yards", "Buffalo Bills", "Houston Texans"),
      HOU_BUF,
      "NFL"
    ),
    { outcome: "WIN" }
  );

  // Clear LOSS: Carson Wentz threw for only 133, well under 200.5.
  await expectAsync(
    "PASS_YDS clear LOSS: Carson Wentz Over 200.5 Passing Yards (actual 133)",
    resolvePlayerProp(
      legacyPick("Vikings Carson Wentz Over 200.5 Passing Yards", "Minnesota Vikings", "Green Bay Packers"),
      MIN_GB,
      "NFL"
    ),
    { outcome: "LOSS" }
  );

  // Edge-case-close line: Aaron Rodgers threw for exactly 221 - a 220.5 Over
  // wins by the narrowest possible margin (half a yard).
  await expectAsync(
    "PASS_YDS edge case: Aaron Rodgers Over 220.5 Passing Yards (actual 221, wins by 0.5)",
    resolvePlayerProp(
      legacyPick("Steelers Aaron Rodgers Over 220.5 Passing Yards", "Pittsburgh Steelers", "Atlanta Falcons"),
      PIT_ATL,
      "NFL"
    ),
    { outcome: "WIN" }
  );
  await expectAsync(
    "PASS_YDS edge case, other side: Aaron Rodgers Under 221.5 Passing Yards (actual 221, wins by 0.5)",
    resolvePlayerProp(
      legacyPick("Steelers Aaron Rodgers Under 221.5 Passing Yards", "Pittsburgh Steelers", "Atlanta Falcons"),
      PIT_ATL,
      "NFL"
    ),
    { outcome: "WIN" }
  );

  // Structured (propMarket-populated) vs legacy (propMarket null) resolve
  // identically for the same real pick/game.
  await expectAsync(
    "PASS_YDS structured path: propMarket=PASS_YDS, playerName='Josh Allen' -> same WIN as the legacy text-parse path",
    resolvePlayerProp(
      structuredPick({
        betDetail: "Bills Josh Allen Over 275.5 Passing Yards",
        propMarket: "PASS_YDS",
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
  // RUSH_YDS
  // =====================================================================

  // Clear WIN.
  await expectAsync(
    "RUSH_YDS clear WIN: David Montgomery Over 45.5 Rushing Yards (actual 60)",
    resolvePlayerProp(
      legacyPick("Texans David Montgomery Over 45.5 Rushing Yards", "Houston Texans", "Buffalo Bills"),
      HOU_BUF,
      "NFL"
    ),
    { outcome: "WIN" }
  );

  // Clear LOSS: Under bet, actual exceeds the line.
  await expectAsync(
    "RUSH_YDS clear LOSS: Bijan Robinson Under 70.5 Rushing Yards (actual 83)",
    resolvePlayerProp(
      legacyPick("Falcons Bijan Robinson Under 70.5 Rushing Yards", "Atlanta Falcons", "Pittsburgh Steelers"),
      PIT_ATL,
      "NFL"
    ),
    { outcome: "LOSS" }
  );

  // Real PUSH: Jaylen Warren rushed for exactly 46 yards, a capper-typed
  // whole-number line (not the X.5 a real sportsbook would post).
  await expectAsync(
    "RUSH_YDS real PUSH on a whole-number line: Jaylen Warren Over 46 Rushing Yards (actual 46 exactly)",
    resolvePlayerProp(
      legacyPick("Steelers Jaylen Warren Over 46 Rushing Yards", "Pittsburgh Steelers", "Atlanta Falcons"),
      PIT_ATL,
      "NFL"
    ),
    { outcome: "PUSH" }
  );

  // Structured vs legacy, same real pick.
  await expectAsync(
    "RUSH_YDS structured path matches legacy path",
    resolvePlayerProp(
      structuredPick({
        betDetail: "Texans David Montgomery Over 45.5 Rushing Yards",
        propMarket: "RUSH_YDS",
        playerName: "Texans David Montgomery",
        homeTeam: "Houston Texans",
        awayTeam: "Buffalo Bills",
      }),
      HOU_BUF,
      "NFL"
    ),
    { outcome: "WIN" }
  );

  // =====================================================================
  // REC_YDS
  // =====================================================================

  await expectAsync(
    "REC_YDS clear WIN: Dalton Kincaid Over 99.5 Receiving Yards (actual 130)",
    resolvePlayerProp(
      legacyPick("Bills Dalton Kincaid Over 99.5 Receiving Yards", "Buffalo Bills", "Houston Texans"),
      HOU_BUF,
      "NFL"
    ),
    { outcome: "WIN" }
  );

  await expectAsync(
    "REC_YDS clear LOSS: DJ Moore Under 89.5 Receiving Yards (actual 100)",
    resolvePlayerProp(
      legacyPick("Bills DJ Moore Under 89.5 Receiving Yards", "Buffalo Bills", "Houston Texans"),
      HOU_BUF,
      "NFL"
    ),
    { outcome: "LOSS" }
  );

  await expectAsync(
    "REC_YDS structured path matches legacy path",
    resolvePlayerProp(
      structuredPick({
        betDetail: "Bills Dalton Kincaid Over 99.5 Receiving Yards",
        propMarket: "REC_YDS",
        playerName: "Bills Dalton Kincaid",
        homeTeam: "Buffalo Bills",
        awayTeam: "Houston Texans",
      }),
      HOU_BUF,
      "NFL"
    ),
    { outcome: "WIN" }
  );

  // =====================================================================
  // RECEPTIONS
  // =====================================================================

  await expectAsync(
    "RECEPTIONS clear WIN: Justin Jefferson Over 5.5 Receptions (actual 8)",
    resolvePlayerProp(
      legacyPick("Vikings Justin Jefferson Over 5.5 Receptions", "Minnesota Vikings", "Green Bay Packers"),
      MIN_GB,
      "NFL"
    ),
    { outcome: "WIN" }
  );

  await expectAsync(
    "RECEPTIONS clear LOSS: Christian Watson Under 5.5 Receptions (actual 6)",
    resolvePlayerProp(
      legacyPick("Packers Christian Watson Under 5.5 Receptions", "Green Bay Packers", "Minnesota Vikings"),
      MIN_GB,
      "NFL"
    ),
    { outcome: "LOSS" }
  );

  await expectAsync(
    "RECEPTIONS structured path matches legacy path",
    resolvePlayerProp(
      structuredPick({
        betDetail: "Vikings Justin Jefferson Over 5.5 Receptions",
        propMarket: "RECEPTIONS",
        playerName: "Vikings Justin Jefferson",
        homeTeam: "Minnesota Vikings",
        awayTeam: "Green Bay Packers",
      }),
      MIN_GB,
      "NFL"
    ),
    { outcome: "WIN" }
  );

  // =====================================================================
  // Multi-market player: James Cook III both rushed (57 yds) AND caught
  // passes (3 rec, 12 yds) in the same game - each market must read the
  // correct row set for the same player/game, not conflate the two.
  // =====================================================================

  await expectAsync(
    "Multi-market player, rushing side: James Cook III Over 45.5 Rushing Yards (actual 57)",
    resolvePlayerProp(
      legacyPick("Bills James Cook III Over 45.5 Rushing Yards", "Buffalo Bills", "Houston Texans"),
      HOU_BUF,
      "NFL"
    ),
    { outcome: "WIN" }
  );
  await expectAsync(
    "Multi-market player, receptions side, same player/game: James Cook III Over 2.5 Receptions (actual 3)",
    resolvePlayerProp(
      legacyPick("Bills James Cook III Over 2.5 Receptions", "Buffalo Bills", "Houston Texans"),
      HOU_BUF,
      "NFL"
    ),
    { outcome: "WIN" }
  );
  // Same player would LOSE a receiving-yards line set above his real total -
  // proves the receiving-yards resolver reads receivingYards (12), not
  // receptions (3) or rushingYards (57).
  await expectAsync(
    "Multi-market player, receiving-yards side (distinct from receptions/rushing): James Cook III Over 20.5 Receiving Yards (actual 12) -> LOSS",
    resolvePlayerProp(
      legacyPick("Bills James Cook III Over 20.5 Receiving Yards", "Buffalo Bills", "Houston Texans"),
      HOU_BUF,
      "NFL"
    ),
    { outcome: "LOSS" }
  );

  // Second multi-market player, other game: Bijan Robinson rushed for 83 AND
  // caught 8 passes for 90 yards.
  await expectAsync(
    "Multi-market player (2nd game): Bijan Robinson Over 75.5 Receiving Yards (actual 90)",
    resolvePlayerProp(
      legacyPick("Falcons Bijan Robinson Over 75.5 Receiving Yards", "Atlanta Falcons", "Pittsburgh Steelers"),
      PIT_ATL,
      "NFL"
    ),
    { outcome: "WIN" }
  );

  // =====================================================================
  // Fuzzy-match: a real typo in the capper's text still resolves against
  // the real box-score name, same tolerance resolveTouchdownProp already
  // relies on (isLikelyDuplicateName).
  // =====================================================================
  await expectAsync(
    "Fuzzy match: 'Jsoh Allen' (transposed letters) still matches 'Josh Allen'",
    resolvePlayerProp(
      legacyPick("Bills Jsoh Allen Over 275.5 Passing Yards", "Buffalo Bills", "Houston Texans"),
      HOU_BUF,
      "NFL"
    ),
    { outcome: "WIN" }
  );

  // =====================================================================
  // Edge cases / unresolvable inputs
  // =====================================================================

  await expectAsync(
    "Player not in this game's box score at all -> null + reason, not a guess",
    resolvePlayerProp(
      legacyPick("Bills Patrick Mahomes Over 275.5 Passing Yards", "Buffalo Bills", "Houston Texans"),
      HOU_BUF,
      "NFL"
    ),
    { outcome: null, reason: 'couldn\'t find "Patrick Mahomes" in the box score' }
  );

  await expectAsync(
    "No Over/Under line anywhere in the text -> null + reason",
    resolvePlayerProp(
      legacyPick("Bills Josh Allen Passing Yards", "Buffalo Bills", "Houston Texans"),
      HOU_BUF,
      "NFL"
    ),
    { outcome: null, reason: "couldn't find an Over/Under line in this bet text" }
  );

  await expectAsync(
    "Non-NFL sport -> same NFL-only guard resolveTouchdownProp uses, before any fetch",
    resolvePlayerProp(
      structuredPick({
        betDetail: "Team Player Over 100.5 Passing Yards",
        propMarket: "PASS_YDS",
        playerName: "Player",
        homeTeam: "Alabama Crimson Tide",
        awayTeam: "Texas Longhorns",
      }),
      "fake-event-id",
      "NCAAF"
    ),
    { outcome: null, reason: "player-prop grading is NFL-only; this NCAAF pick needs manual grading" }
  );

  // Regression: TD props still route to resolveTouchdownProp unchanged, both
  // via propMarket="TD" and via the legacy null-propMarket text fallback.
  await expectAsync(
    "TD prop still resolves via resolveTouchdownProp (unaffected by this PR): legacy null propMarket",
    resolvePlayerProp(legacyPick("Bills Josh Allen Anytime TD", "Buffalo Bills", "Houston Texans"), HOU_BUF, "NFL"),
    { outcome: "WIN" } // Josh Allen scored 2 rushing TDs in this real game.
  );
  await expectAsync(
    "TD prop still resolves via resolveTouchdownProp (unaffected by this PR): structured propMarket=TD",
    resolvePlayerProp(
      structuredPick({
        betDetail: "Bills Josh Allen Anytime TD",
        propMarket: "TD",
        playerName: "Bills Josh Allen",
        homeTeam: "Buffalo Bills",
        awayTeam: "Houston Texans",
      }),
      HOU_BUF,
      "NFL"
    ),
    { outcome: "WIN" }
  );

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
