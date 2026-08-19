// Structural-validation proof for two NCAAF grading-correctness fixes - run
// with `npx tsx src/server/data/grading-correctness-acceptance-test.ts`. Not
// a general test suite (this repo has no test runner configured yet, see
// parlay-grading-acceptance-test.ts for the same pattern).
//
// Part 1: gradePick's same-mascot guard - a same-mascot NCAAF matchup (e.g.
// Clemson Tigers @ LSU Tigers) can never silently mis-grade off whichever of
// pickedHome/pickedAway happens to be checked first, while every other
// combination (different mascots, a same-mascot tie, a same-mascot TOTAL
// pick) keeps grading exactly as it did before the guard.
//
// Part 2: resolveTouchdownProp's sport guard - touchdown-prop grading is
// hardcoded to ESPN's NFL box-score endpoint, so a non-NFL sportName must be
// rejected before any of that NFL-specific logic runs, while NFL itself is
// provably unaffected (still reaches its own pre-existing "not a recognized
// touchdown prop" check, not blocked by the new guard).
//
// Exits non-zero if any assertion fails.
import { gradePick, resolveTouchdownProp } from "./grading";

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

// ---- Layer 2: pickedSide is authoritative when present, and is what
// actually lets a same-mascot NCAAF pick auto-grade instead of staying
// PENDING forever under Layer 1's guard alone. ----

expect(
  "same-mascot ML with pickedSide=HOME: grades correctly even though text-match alone can't tell the sides apart",
  gradePick("MONEYLINE", "Tigers ML", null, "LSU Tigers", "Clemson Tigers", 30, 20, "HOME"),
  "WIN"
);

expect(
  "same-mascot ML with pickedSide=AWAY: grades correctly for the other side of the same matchup",
  gradePick("MONEYLINE", "Tigers ML", null, "LSU Tigers", "Clemson Tigers", 30, 20, "AWAY"),
  "LOSS"
);

expect(
  "same-mascot SPREAD with pickedSide=AWAY: grades correctly",
  gradePick("SPREAD", "Tigers +7", 7, "LSU Tigers", "Clemson Tigers", 20, 17, "AWAY"),
  "WIN"
);

expect(
  "pickedSide is authoritative even when it contradicts the betDetail text - not just 'also considered'",
  gradePick("MONEYLINE", "this text says nothing about either team", null, "Kansas City Chiefs", "Denver Broncos", 24, 17, "AWAY"),
  "LOSS"
);

async function expectAsync<T>(label: string, actual: Promise<T>, expected: T) {
  const resolved = await actual;
  const pass = JSON.stringify(resolved) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} - expected=${JSON.stringify(expected)} actual=${JSON.stringify(resolved)}`);
  if (!pass) failures++;
}

async function main() {
  // ---- TD-prop sport guard: rejected before any NFL-specific logic runs,
  // for any sport that isn't NFL. Uses an obviously-fake eventId - if the
  // guard didn't fire first, this would attempt a real network fetch and the
  // test would hang/fail on that instead, which is itself proof the guard is
  // doing its job.
  await expectAsync(
    "NCAAF touchdown prop: rejected by the sport guard, not silently graded against NFL's box score",
    resolveTouchdownProp(
      { betDetail: "Ryan Williams Anytime TD", homeTeam: "Alabama Crimson Tide", awayTeam: "Texas Longhorns" },
      "fake-event-id",
      "NCAAF"
    ),
    { outcome: null, reason: "touchdown-prop grading isn't available for NCAAF yet" }
  );

  // ---- Regression: NFL is unaffected - it must still reach its own
  // pre-existing "not a recognized touchdown prop" check, proving the new
  // guard only blocks non-NFL sports, not NFL itself.
  await expectAsync(
    "NFL non-TD-prop text: reaches the existing parseTouchdownProp check unblocked, not the new sport guard",
    resolveTouchdownProp(
      { betDetail: "Chiefs ML", homeTeam: "Kansas City Chiefs", awayTeam: "Denver Broncos" },
      "fake-event-id",
      "NFL"
    ),
    { outcome: null, reason: "this bet text isn't a recognized touchdown prop" }
  );

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
