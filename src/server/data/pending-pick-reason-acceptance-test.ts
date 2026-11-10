// Pins the Pending Picks "unmatched" wording for segment-scoped picks - run with:
//   npx tsx src/server/data/pending-pick-reason-acceptance-test.ts
//
// No DB: segmentUnmatchedReason (lib/pending-pick-reason.ts) is pure, and the
// grader cross-check uses resolveOutcome on an in-memory game row.
//
// Bug pinned: an NCAAB "Boston College 1H moneyline" pick (game final, 71-55)
// read "the 1st half / F5 score isn't posted for this game yet" - wrong twice:
// F5 is baseball, and NCAAB half grading is blocked on purpose (NCAAB-PR-C in
// grading.ts resolveOutcome) so that score is never going to be "posted".

import { segmentUnmatchedReason } from "@/lib/pending-pick-reason";
import { firstHalfLabelPrefixForChipSet } from "@/lib/bet-type-filter";
import { betScope } from "@/lib/bet-line";
import { resolveOutcome } from "./grading";
import { chipSetForLeague } from "./stats";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = actual === expected;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

const NCAAB = "basketball_ncaab";
const NEW_MSG = "NCAAB grading covers full game and halves only - needs manual grading";
const prefix = (sport: string) => firstHalfLabelPrefixForChipSet(chipSetForLeague(sport));

// The reported pick: NCAAB, text "Boston College 1H moneyline", stored FIRST_HALF.
// NCAAB first halves grade now (linescore[0]), so while the row still lacks its
// first-half score this reads the normal "not posted yet" wording.
const bcText = "Boston College 1H moneyline";
const bcScope = betScope(bcText, "NCAAB");
expect("BC pick text scopes to FIRST_HALF", bcScope, "FIRST_HALF");
expect(
  "NCAAB FIRST_HALF pick -> normal 'not posted yet' wording",
  segmentUnmatchedReason(bcScope, "FIRST_HALF", NCAAB, prefix("NCAAB")),
  "matched game, but the " + (prefix("NCAAB") === "1H / F5" ? "1st half / F5" : "1st half") + " score isn't posted for this game yet"
);
expect("NCAAB SECOND_HALF pick -> normal 'not posted yet' wording", segmentUnmatchedReason("SECOND_HALF", "SECOND_HALF", NCAAB, prefix("NCAAB")), "matched game, but the 2nd half score isn't posted for this game yet");
expect("NCAAB quarter-stored pick -> new message", segmentUnmatchedReason("FIRST_QUARTER", "FIRST_QUARTER", NCAAB, prefix("NCAAB")), NEW_MSG);
// Legacy row: text says 1H but stored FULL_GAME -> the NCAAB guard is keyed on the
// STORED period (same as the grader), so this keeps the "predates" wording.
expect(
  "NCAAB pick stored FULL_GAME but text says 1H -> predates wording (unchanged)",
  segmentUnmatchedReason("FIRST_HALF", "FULL_GAME", NCAAB, prefix("NCAAB")),
  "matched game, but this 1st half pick predates segment grading - needs manual grading or re-import"
);
expect("NCAAB full-game pick -> null (falls through to text reasons)", segmentUnmatchedReason("FULL_GAME", "FULL_GAME", NCAAB, prefix("NCAAB")), null);

// Other sports are unchanged apart from the sport-aware label.
expect(
  "NCAAF 1H -> 'score isn't posted' with 1st half label, no F5",
  segmentUnmatchedReason("FIRST_HALF", "FIRST_HALF", "americanfootball_ncaaf", prefix("NCAAF")),
  "matched game, but the 1st half score isn't posted for this game yet"
);
expect(
  "NFL 1H -> 1st half label",
  segmentUnmatchedReason("FIRST_HALF", "FIRST_HALF", "americanfootball_nfl", prefix("NFL")),
  "matched game, but the 1st half score isn't posted for this game yet"
);
expect(
  "NBA 1H -> 1st half label",
  segmentUnmatchedReason("FIRST_HALF", "FIRST_HALF", "basketball_nba", prefix("NBA")),
  "matched game, but the 1st half score isn't posted for this game yet"
);
expect(
  "MLB F5 -> F5 label",
  segmentUnmatchedReason("FIRST_HALF", "FIRST_HALF", "baseball_mlb", prefix("MLB")),
  "matched game, but the F5 score isn't posted for this game yet"
);
expect(
  "NHL 2nd period unchanged",
  segmentUnmatchedReason("SECOND_PERIOD", "SECOND_PERIOD", "icehockey_nhl", prefix("NHL")),
  "matched game, but the 2nd period score isn't posted for this game yet"
);
expect(
  "NCAAF mismatched stored period -> predates wording with 1st half",
  segmentUnmatchedReason("FIRST_HALF", "FULL_GAME", "americanfootball_ncaaf", prefix("NCAAF")),
  "matched game, but this 1st half pick predates segment grading - needs manual grading or re-import"
);
expect(
  "UNSUPPORTED_SEGMENT unchanged (even for NCAAB)",
  segmentUnmatchedReason("UNSUPPORTED_SEGMENT", "FULL_GAME", NCAAB, prefix("NCAAB")),
  "matched game, but this bet is scoped to a game segment the grader can't resolve (e.g. a single inning outside MLB) - needs manual grading"
);
expect("full-game pick, no sport key -> null", segmentUnmatchedReason("FULL_GAME", "FULL_GAME", undefined, prefix("NCAAF")), null);

// Cross-check against the real grader: an NCAAB 1H pick with a first-half score
// on the row grades like any other sport's, so it never reaches the reason code;
// a SECOND_HALF one grades too; a quarter pick is still held by the guard.
const game = {
  homeTeam: "Boston College",
  awayTeam: "Opponent",
  homeScore: 71,
  awayScore: 55,
  firstFiveHomeScore: 35,
  firstFiveAwayScore: 28,
  firstInningHomeScore: null,
  firstInningAwayScore: null,
  linescoreJson: null,
};
const pick = { betType: "MONEYLINE", period: "FIRST_HALF", betDetail: bcText, homeTeam: "Boston College", line: null };
expect("resolveOutcome: NCAAB 1H grades with a first-half score present (WIN)", resolveOutcome(pick, { ...game, sportKey: NCAAB }), "WIN");
expect(
  "resolveOutcome: NCAAB 2H grades with a first-half score present (36-27 -> WIN)",
  resolveOutcome({ ...pick, period: "SECOND_HALF", betDetail: "Boston College 2H moneyline" }, { ...game, sportKey: NCAAB }),
  "WIN"
);
expect(
  "resolveOutcome: NCAAB quarter pick still null with the score present (guard)",
  resolveOutcome({ ...pick, period: "FIRST_QUARTER", betDetail: "Boston College 1Q moneyline" }, { ...game, sportKey: NCAAB }),
  null
);
expect("resolveOutcome: NCAAF 1H on the same row grades (WIN)", resolveOutcome(pick, { ...game, sportKey: "americanfootball_ncaaf" }), "WIN");

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nAll passed");
