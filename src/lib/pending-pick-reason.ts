import { periodLabel } from "@/lib/bet-line";
import { NCAAB_SPORT_KEY } from "@/lib/final-pick-gate";

// Why a pick whose game matched still can't grade, for the segment-scoped
// cases (picks.ts getPendingPicksForUser calls this once resolveOutcome has
// returned null). Returns null for a full-game pick so the caller falls
// through to its text-based reasons. Pure - no DB - so the wording is pinned by
// pending-pick-reason-acceptance-test.ts.
//
// `scope` is betScope() of the pick text (NRFI passes FULL_GAME); `period` is the
// stored Period; `firstHalfPrefix` is the sport-aware label prefix.
export function segmentUnmatchedReason(
  scope: string,
  period: string,
  sportKey: string | undefined,
  firstHalfPrefix: "F5" | "1H" | "1H / F5"
): string | null {
  if (scope === "UNSUPPORTED_SEGMENT") {
    return "matched game, but this bet is scoped to a game segment the grader can't resolve (e.g. a single inning outside MLB) - needs manual grading";
  }
  // Same condition as resolveOutcome's NCAAB period guard (grading.ts): NCAAB
  // grades FULL_GAME, FIRST_HALF and SECOND_HALF only, so for any other stored
  // period "score isn't posted yet" would be wrong forever. A half pick falls
  // through to the normal wording below.
  if (sportKey === NCAAB_SPORT_KEY && period !== "FULL_GAME" && period !== "FIRST_HALF" && period !== "SECOND_HALF") {
    return "NCAAB grading covers full game and halves only - needs manual grading";
  }
  if (scope !== "FULL_GAME" && scope !== period) {
    return "matched game, but this " + periodLabel(scope, firstHalfPrefix) + " pick predates segment grading - needs manual grading or re-import";
  }
  if (scope !== "FULL_GAME") {
    return "matched game, but the " + periodLabel(scope, firstHalfPrefix) + " score isn't posted for this game yet";
  }
  return null;
}
