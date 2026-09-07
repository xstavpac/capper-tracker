import type { PickStatus } from "@prisma/client";

// Pure decision core for "stuck parlay leg" triage - no DB I/O, so the rule
// set can be exercised directly by parlay-leg-triage-acceptance-test.ts
// without a database, the same way parlay-grading.ts keeps resolveParlayStatus
// pure and picks.ts keeps gradePick/resolveOutcome pure. getPendingLegsForUser
// (picks.ts) does the Prisma reads and the per-leg re-grade probe, then feeds
// the results here.
//
// Issue #23: a parlay leg can sit PENDING forever with no visibility. But NOT
// every PENDING leg is a problem - when a parlay loses on its first losing
// leg, recomputeParlayBetStatus (parlay-grading.ts) deliberately freezes the
// parent at LOSS and leaves every remaining leg PENDING by design, never
// re-touched. Those trailing legs are working as intended and must never be
// surfaced as "stuck." A leg is only genuinely stuck when all three hold:
//   1. the leg itself is still PENDING,
//   2. its parent ParlayBet is ALSO still PENDING overall (rules out the
//      trailing-loss legs above), and
//   3. the leg's game finished long enough ago that grading should have
//      happened by now.

// Same 6h-past-start grace getPendingPicksForUser uses (UNMATCHED_CHECK_DELAY_
// HOURS in picks.ts) before it treats a missing game match as a real problem
// rather than "the game just isn't final yet." Kept as its own named constant
// here because this module is the pure, DB-free home for the triage rule.
export const STUCK_LEG_MIN_AGE_HOURS = 6;

export function gameShouldHaveGradedByNow(ageHours: number): boolean {
  return ageHours > STUCK_LEG_MIN_AGE_HOURS;
}

// The three-part filter. `ageHours` is now - leg.gameTime in hours (can be
// negative for a game that hasn't started).
export function isStuckParlayLeg(input: {
  legStatus: PickStatus;
  parentParlayStatus: PickStatus;
  ageHours: number;
}): boolean {
  return (
    input.legStatus === "PENDING" &&
    input.parentParlayStatus === "PENDING" &&
    gameShouldHaveGradedByNow(input.ageHours)
  );
}

// The outcome of re-running the existing pure grading functions against one
// stuck leg, reduced to the few facts computeStuckLegReason needs. Built by
// getPendingLegsForUser from findMatchingGameResult / resolveTouchdownProp /
// resolveOutcome - the same calls getPendingPicksForUser makes per pending
// pick - so the reason strings a stuck leg gets are the same class of
// human-readable strings a stuck standalone pick already gets.
export type LegGradeProbe = {
  // false when the leg's sport has no free score source wired up at all
  // (see RESOLVABLE_SPORT_KEYS) - it will never auto-grade.
  resolvable: boolean;
  // findMatchingGameResult returned a game (null otherwise).
  matched: boolean;
  isPlayerProp: boolean;
  // resolveTouchdownProp's `reason` when it couldn't grade the prop, else
  // null (prop graded fine, or not a player-prop leg at all).
  touchdownPropReason: string | null;
  // resolveOutcome produced a WIN/LOSS/PUSH (false when the game matched but
  // the bet text had no gradable number).
  outcomeResolved: boolean;
};

// Mirrors the reason ladder inside getPendingPicksForUser exactly, just as a
// pure function fed the already-computed probe results instead of making the
// async calls inline. null means "nothing obviously wrong - grading just
// hasn't run yet," which is still a legitimately stuck leg worth showing.
export function computeStuckLegReason(probe: LegGradeProbe): string | null {
  if (!probe.resolvable) return "sport not tracked";
  if (!probe.matched) return "no matching game found";
  if (probe.isPlayerProp) {
    return probe.touchdownPropReason ? "matched game, but " + probe.touchdownPropReason : null;
  }
  if (!probe.outcomeResolved) {
    return "matched game, but couldn't parse a gradable number from the bet text";
  }
  return null;
}
