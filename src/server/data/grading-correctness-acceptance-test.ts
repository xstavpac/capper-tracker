// Structural-validation proof for gradePick's same-mascot guard - run with
// `npx tsx src/server/data/grading-correctness-acceptance-test.ts`. Not a
// general test suite (this repo has no test runner configured yet, see
// parlay-grading-acceptance-test.ts for the same pattern); a standalone,
// runnable proof that a same-mascot NCAAF matchup (e.g. Clemson Tigers @
// LSU Tigers) can never silently mis-grade off whichever of pickedHome/
// pickedAway happens to be checked first, while every other combination
// (different mascots, a same-mascot tie, a same-mascot TOTAL pick) keeps
// grading exactly as it did before the guard. Exits non-zero if any
// assertion fails.
import { gradePick } from "./grading";

let failures = 0;

function expect(label: string, actual: unknown, expected: unknown) {
  const pass = actual === expected;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} - expected=${expected} actual=${actual}`);
  if (!pass) failures++;
}

// ---- Same-mascot guard: the actual bug this fixes ----

expect(
  "same-mascot ML, home team actually won: stays ungraded, not a guessed WIN/LOSS",
  gradePick("MONEYLINE", "Tigers ML", null, "LSU Tigers", "Clemson Tigers", 30, 20),
  null
);

expect(
  "same-mascot ML, away team actually won: stays ungraded, not a guessed WIN/LOSS",
  gradePick("MONEYLINE", "Tigers ML", null, "LSU Tigers", "Clemson Tigers", 17, 24),
  null
);

expect(
  "same-mascot SPREAD: stays ungraded rather than guessing a side",
  gradePick("SPREAD", "Tigers -7", -7, "LSU Tigers", "Clemson Tigers", 30, 20),
  null
);

// ---- A same-mascot game is still gradeable when the outcome doesn't
// depend on which side was picked ----

expect(
  "same-mascot ML, tied score: still PUSH - no side identity needed to know this",
  gradePick("MONEYLINE", "Tigers ML", null, "LSU Tigers", "Clemson Tigers", 21, 21),
  "PUSH"
);

expect(
  "same-mascot TOTAL: still grades normally - TOTAL never depended on pickedHome/pickedAway",
  gradePick("TOTAL", "Over 55.5", 55.5, "LSU Tigers", "Clemson Tigers", 30, 30),
  "WIN"
);

// ---- Regression: every currently-supported sport has no mascot collision,
// so the guard must be a true no-op for them ----

expect(
  "different-mascot ML unaffected: real winner still grades correctly",
  gradePick("MONEYLINE", "Chiefs ML", null, "Kansas City Chiefs", "Denver Broncos", 24, 17),
  "WIN"
);

expect(
  "different-mascot SPREAD unaffected",
  gradePick("SPREAD", "Broncos +7", 7, "Kansas City Chiefs", "Denver Broncos", 24, 20),
  "WIN"
);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
