// Structural-validation proof for three NCAAF grading-correctness fixes -
// run with `npx tsx src/server/data/grading-correctness-acceptance-test.ts`.
// Not a general test suite (this repo has no test runner configured yet, see
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
// Part 3: gradePick's school-name fallback (added during the pre-launch
// NCAAF grading investigation) - the text-match fallback used to only ever
// check the MASCOT (teamNickname(), last word of the full team name), so a
// manually-entered pick written with the SCHOOL name ("Alabama ML") - the
// overwhelmingly normal way people actually talk about college football,
// unlike NFL/MLB/NBA where the mascot IS the short form - stayed ungraded
// forever even though the identical bet written as "Crimson Tide ML" graded
// fine. Fixed by also matching against ncaafSchoolKey(homeTeam/awayTeam) via
// NCAAF_CANONICAL_SUFFIX. Covers: the fix working for an ordinary matchup,
// the fix working for a SAME-MASCOT matchup (Duke/Arizona State both reduce
// to "devils" but their school names don't collide, so "Duke ML" can now
// auto-grade something "Devils ML" correctly still can't and shouldn't), the
// same-mascot guard still refusing to guess off the bare mascot post-fix,
// and the nested-school-name ambiguity the fix has to resolve on its own
// (Arizona vs Arizona State - "arizona" is a whole word inside "arizona
// state", the grading-time equivalent of the West Virginia/Virginia bug
// parse-catalog.ts's import-time resolver already guards against).
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

// ---- School-name fallback: an ordinary (non-collision) NCAAF matchup ----

expect(
  "school-name ML on an ordinary matchup: 'Alabama ML' grades correctly, not just 'Crimson Tide ML'",
  gradePick("MONEYLINE", "Alabama ML", null, "Alabama Crimson Tide", "Georgia Bulldogs", 27, 24),
  "WIN"
);

expect(
  "school-name SPREAD on an ordinary matchup: 'Georgia +3.5' grades correctly",
  gradePick("SPREAD", "Georgia +3.5", 3.5, "Alabama Crimson Tide", "Georgia Bulldogs", 27, 24),
  "WIN"
);

// ---- School-name fallback on a SAME-MASCOT matchup: Duke (Blue Devils) and
// Arizona State (Sun Devils) both reduce to "devils" via teamNickname(), so
// the mascot guard still (correctly) refuses "Devils ML" - but their SCHOOL
// names don't collide at all, so "Duke ML"/"Arizona State ML" can and must
// still auto-grade without needing pickedSide. ----

expect(
  "same-mascot game, school-name text: 'Duke ML' grades correctly even though 'Devils ML' can't",
  gradePick("MONEYLINE", "Duke ML", null, "Duke Blue Devils", "Arizona State Sun Devils", 20, 27),
  "LOSS"
);

expect(
  "same-mascot game, school-name text: 'Arizona State ML' grades correctly for the other side",
  gradePick("MONEYLINE", "Arizona State ML", null, "Duke Blue Devils", "Arizona State Sun Devils", 20, 27),
  "WIN"
);

expect(
  "same-mascot guard regression: bare 'Devils ML' with no pickedSide is STILL ungraded post-fix - the school-name fallback must never override it",
  gradePick("MONEYLINE", "Devils ML", null, "Duke Blue Devils", "Arizona State Sun Devils", 20, 27),
  null
);

// ---- Nested-school-name ambiguity the fallback has to resolve on its own:
// Arizona (Wildcats) vs Arizona State (Sun Devils) - "arizona" is a whole
// word inside "arizona state", same family of bug as West Virginia/Virginia
// in parse-catalog.ts's import-time resolver, but this is the grading-time
// fallback's own version of it (it never reuses that resolver). A match on
// the shorter name must not fire when the longer name is what's actually
// present, in both directions. ----

expect(
  "nested school names: 'Arizona State ML' resolves to Arizona State only, not confused with Arizona",
  gradePick("MONEYLINE", "Arizona State ML", null, "Arizona Wildcats", "Arizona State Sun Devils", 17, 25),
  "WIN"
);

expect(
  "nested school names: 'Arizona ML' (the shorter, different school) resolves to Arizona",
  gradePick("MONEYLINE", "Arizona ML", null, "Arizona Wildcats", "Arizona State Sun Devils", 17, 25),
  "LOSS"
);

expect(
  "nested school names: 'Arizona State -7' (school-name spread) resolves to the away side only",
  gradePick("SPREAD", "Arizona State -7", -7, "Arizona Wildcats", "Arizona State Sun Devils", 17, 25),
  "WIN"
);

expect(
  "school-name fallback is a no-op for non-NCAAF teams: unaffected by full team names that don't appear in NCAAF_CANONICAL_SUFFIX",
  gradePick("MONEYLINE", "Chiefs ML", null, "Kansas City Chiefs", "Denver Broncos", 24, 17),
  "WIN"
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
    { outcome: null, reason: "player-prop grading is NFL-only; this NCAAF pick needs manual grading" }
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
