// Structural-validation proof for resolveParlayStatus - run with
// `npx tsx src/server/data/parlay-grading-acceptance-test.ts`. Not a general
// test suite (this repo has no test runner configured yet, see model-
// engine/acceptance-test.ts for the same pattern); a standalone, runnable
// proof that the parent-recompute decision rules (short-circuit-on-LOSS,
// not-resolvable-while-PENDING, recalculate-at-N-1-legs-on-PUSH) all resolve
// the way the schema comments and grading design intend, before trusting
// recomputeParlayBetStatus to write real ParlayBet rows. Exits non-zero if
// any assertion fails.
import type { PickStatus } from "@prisma/client";
import { resolveParlayStatus } from "./parlay-grading";

let failures = 0;

function expect(label: string, legStatuses: PickStatus[], expected: PickStatus | null) {
  const actual = resolveParlayStatus(legStatuses);
  const pass = actual === expected;
  console.log(
    `${pass ? "PASS" : "FAIL"}: ${label} - legs=[${legStatuses.join(",")}] expected=${expected} actual=${actual}`
  );
  if (!pass) failures++;
}

// All legs still waiting on their games - nothing to resolve yet.
expect("all pending", ["PENDING", "PENDING", "PENDING"], null);

// Some decided, none lost yet, at least one still pending - still not
// resolvable. This is the case that most needs the "not just any decided
// leg" rule: a capper going 2-for-2 so far on a 3-leg parlay is NOT a win
// yet.
expect("partial progress, no loss, still pending", ["WIN", "WIN", "PENDING"], null);

// The core short-circuit rule: one LOSS decides the whole parlay
// immediately, even while another leg's game hasn't been played yet.
expect("loss short-circuits despite a still-pending leg", ["LOSS", "PENDING"], "LOSS");
expect("loss short-circuits despite a still-pending leg (loss first)", ["PENDING", "LOSS"], "LOSS");

// Every leg decided, all won.
expect("all legs win", ["WIN", "WIN", "WIN"], "WIN");

// Every leg decided, one loss among wins - loss wins regardless of position
// or how many other legs won.
expect("one loss among wins", ["WIN", "LOSS", "WIN"], "LOSS");

// A push removes that leg from the parlay ("recalculates at N-1 legs") -
// the parlay still wins on the remaining winning legs.
expect("push recalculates at N-1, remaining legs win", ["WIN", "PUSH", "WIN"], "WIN");

// A cancelled leg is excluded the same way a pushed leg is.
expect("cancelled leg excluded like a push", ["WIN", "CANCELLED", "WIN"], "WIN");

// If literally every leg pushed/cancelled, there's no bet left standing -
// the whole parlay pushes, it doesn't silently disappear or win by default.
expect("all legs push", ["PUSH", "PUSH"], "PUSH");
expect("all legs cancelled", ["CANCELLED", "CANCELLED"], "PUSH");
expect("mixed push and cancelled, none won", ["PUSH", "CANCELLED"], "PUSH");

// A push/cancel does NOT resolve the parlay early on its own - still needs
// every other leg decided (or a loss) first.
expect("push alongside a still-pending leg", ["PUSH", "PENDING"], null);

// No legs at all (shouldn't happen in practice - a parlay is created with
// its legs - but resolveParlayStatus should not crash or guess).
expect("no legs", [], null);

console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
