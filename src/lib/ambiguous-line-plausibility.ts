// Candidate-list filter for the catalog-import ambiguous-nickname
// disambiguation prompt (see ambiguous-hierarchy.ts). A bare nickname like
// "Giants" can collide across leagues whose bet lines look nothing alike -
// MLB/KBO run lines are effectively always +/-1.5, while NFL/NCAAF spreads
// range far wider. Offering a MLB/KBO option next to a +6.5 spread pick is
// actively misleading: no capper means the run-line team with a line that
// shape. This module narrows the candidate list by comparing a pick's own
// already-parsed line against each candidate's realistic range for that bet
// type.
//
// Deliberately dependency-free (no React/Prisma imports) so it loads under
// tsx in ambiguous-hierarchy-acceptance-test.ts, same constraint as
// ambiguous-hierarchy.ts and parse-catalog.ts.
//
// This module ONLY filters a candidate list - it never decides or
// auto-resolves anything itself. Whether a single surviving candidate is
// trustworthy enough to auto-resolve on (versus needing a cross-check
// against another hierarchy signal) is ambiguous-hierarchy.ts's call, not
// this module's - see its own "cross-check" step.
//
// Scoped ONLY to the leagues actually involved in a confirmed
// AMBIGUOUS_NICKNAMES run-line collision today - MLB and KBO (both use the
// same +/-1.5 run-line convention) versus NFL, whose spreads/totals run far
// wider and are deliberately left unbounded here. This is NOT a
// comprehensive per-league table for every sport parse-catalog.ts tracks,
// and it is NOT a betting model - it exists solely to catch a bet line that
// is flatly impossible for a given league, not to model realistic-but-
// unusual lines. See the PR description for the bound values themselves and
// which are estimates versus confirmed conventions.
import type { AmbiguousOption, ParsedPick } from "@/lib/parse-catalog";

// Real MLB/KBO run lines are, in practice, always exactly +/-1.5 pre-game -
// a capper posting a catalog pick never sees anything else as a run line
// (a wider number only ever shows up mid-blowout in live/in-play betting,
// never as the pre-game line a bulk-import paste is transcribing). 2.5
// leaves a little headroom above the real 1.5 convention so a genuine
// alternate run-line listing isn't wrongly excluded, while still solidly
// rejecting a number shaped like a real point spread (+6.5, -9, ...).
// DOMAIN ESTIMATE based on how MLB/KBO run lines are conventionally quoted -
// not backtested against this app's own historical odds data.
const RUN_LINE_SPREAD_BOUND: Partial<Record<string, number>> = {
  MLB: 2.5,
  KBO: 2.5,
};

// MLB/KBO full-game totals conventionally cluster roughly 6.5-11 runs.
// DOMAIN ESTIMATE, not backtested against this app's own historical odds
// data - same caveat as RUN_LINE_SPREAD_BOUND above.
const RUN_LINE_TOTAL_BOUND: Partial<Record<string, { min: number; max: number }>> = {
  MLB: { min: 4, max: 13 },
  KBO: { min: 4, max: 13 },
};

// `line` is the pick's own already-parsed numeric spread/total (ParsedPick's
// ambiguousLine, itself produced by parsePickText/extractLine at parse
// time - see parse-catalog.ts) - this function does no text parsing of its
// own. `betType` is the pick's own already-parsed ambiguousBetType. A pick
// with no numeric line (moneyline, player prop, or a line that couldn't be
// parsed) has nothing to filter on - every candidate passes through
// unchanged, on purpose: the silent-wrong-resolution risk for a moneyline
// pick is Bug 7's pick_context issue, a separate fix.
//
// A candidate whose sport has no entry in the bound tables above (NFL,
// NCAAF, or any league not involved in a confirmed run-line collision) is
// never filtered out by this function - it has no known realistic range
// here to compare against, so it's left as plausible rather than guessed at.
export function filterPlausibleCandidates(
  candidates: AmbiguousOption[],
  betType: ParsedPick["betType"] | undefined,
  line: number | null | undefined
): AmbiguousOption[] {
  if (line === null || line === undefined || betType === undefined) return candidates;

  if (betType === "SPREAD") {
    return candidates.filter((c) => {
      const bound = RUN_LINE_SPREAD_BOUND[c.sport];
      return bound === undefined || Math.abs(line) <= bound;
    });
  }

  if (betType === "TOTAL" || betType === "TEAM_TOTAL") {
    return candidates.filter((c) => {
      const range = RUN_LINE_TOTAL_BOUND[c.sport];
      return range === undefined || (line >= range.min && line <= range.max);
    });
  }

  return candidates;
}
