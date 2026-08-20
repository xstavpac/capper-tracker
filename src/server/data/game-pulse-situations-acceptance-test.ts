// Correctness proof for the situational-question evaluators in
// game-pulse-situations.ts, run with:
//   npx tsx src/server/data/game-pulse-situations-acceptance-test.ts
// Not a general test suite (see grading-correctness-acceptance-test.ts for
// the same pattern - this repo has no test runner configured).
//
// Fixtures here are small hand-constructed edge cases (ties, not-yet-played
// halves, threshold boundaries, same-inning-both-score chronology) chosen to
// exercise specific branches - they are deliberately synthetic, not pulled
// from a real game. Real-data verification (does this logic behave sanely
// against actual live/final MLB linescores fetched fresh) was done
// separately as a standalone script, not checked in here, since hardcoding
// a remembered real game's per-inning breakdown risks silently transcribing
// it wrong.
//
// Exits non-zero if any assertion fails.
import { SITUATIONAL_QUESTIONS, type SituationalQuestionKey } from "./game-pulse-situations";

let failures = 0;

function question(key: SituationalQuestionKey) {
  const q = SITUATIONAL_QUESTIONS.find((q) => q.key === key);
  if (!q) throw new Error("missing question " + key);
  return q;
}

function expect(label: string, actual: unknown, expected: unknown) {
  const pass = actual === expected;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} - expected=${expected} actual=${actual}`);
  if (!pass) failures++;
}

// ---- scoredFirst ----

expect("scoredFirst: nobody has scored yet - null, not defaulted to either side", question("scoredFirst").evaluate([0, 0], [0, 0]), null);

expect(
  "scoredFirst: away scores in an earlier inning than home - away",
  question("scoredFirst").evaluate([0, 1, 0], [1, 0, 0]),
  "away"
);

expect(
  "scoredFirst: home scores in an earlier inning than away - home",
  question("scoredFirst").evaluate([1, 0, 0], [0, 1, 0]),
  "home"
);

expect(
  "scoredFirst: both teams score in the SAME inning number - away bats first (top half) within any inning, so away is first chronologically even though home's entry is also >0",
  question("scoredFirst").evaluate([2, 0], [3, 0]),
  "away"
);

expect(
  "scoredFirst: away's half of the current inning hasn't been played yet (null) and nobody has scored so far - can't determine yet, not a guess",
  question("scoredFirst").evaluate([0, 0], [0, null]),
  null
);

expect(
  "scoredFirst: away already scored 0 this inning, home's half not yet played (null) - can't look past it to later innings",
  question("scoredFirst").evaluate([null], [0]),
  null
);

// ---- leadingAfter(N) / trailingAfter(N) ----

expect("leadingAfter5: home ahead through 5 completed innings - home", question("leadingAfter5").evaluate([1, 0, 1, 0, 0], [0, 0, 0, 0, 0]), "home");

expect(
  "leadingAfter5: tied through 5 - null, not an arbitrary pick",
  question("leadingAfter5").evaluate([1, 0, 1, 0, 0], [0, 1, 0, 1, 0]),
  null
);

expect(
  "leadingAfter5: inning 5 not fully played yet (home half still null) - not yet determinable",
  question("leadingAfter5").evaluate([1, 0, 1, 0, null], [0, 0, 0, 0, 0]),
  null
);

expect(
  "leadingAfter7: only 5 innings of data exist so far (array too short) - can't evaluate an inning-7 checkpoint yet",
  question("leadingAfter7").evaluate([1, 0, 1, 0, 0], [0, 0, 0, 0, 0]),
  null
);

expect(
  "trailingAfter7: away is behind after 7 - away (the mirror of leadingAfter7, not the same team)",
  question("trailingAfter7").evaluate([1, 0, 1, 0, 0, 0, 1], [0, 0, 0, 0, 0, 0, 0]),
  "away"
);

// ---- bigInning ----

expect(
  "bigInning: exactly at the 3-run threshold counts",
  question("bigInning").evaluate([0, 3], [0, 0]),
  "home"
);

expect("bigInning: 2 runs in an inning does not qualify - null", question("bigInning").evaluate([0, 2], [0, 2]), null);

expect(
  "bigInning: away's qualifying inning happens before home's later one - away (first to qualify, chronologically)",
  question("bigInning").evaluate([0, 0, 4], [3, 0, 0]),
  "away"
);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
if (failures > 0) process.exit(1);
