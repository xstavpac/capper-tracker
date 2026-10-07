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
// AMBIGUOUS_NICKNAMES line-shape collision today - the fixed-handicap leagues
// (MLB/KBO run line, NHL puck line) and the basketball / college-football
// ranges - plus NFL totals (a 6.5 or 8.5 "over" is a hockey/baseball number,
// never a football one). NFL SPREADS are deliberately left unbounded here.
// This is NOT a comprehensive per-league table for every sport
// parse-catalog.ts tracks, and it is NOT a betting model - it exists solely
// to catch a bet line that is flatly impossible for a given league, not to
// model realistic-but-unusual lines. See the PR description for the bound
// values themselves and which are estimates versus confirmed conventions.
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
const SPREAD_MAGNITUDE_BOUND: Partial<Record<string, number>> = {
  MLB: 2.5,
  KBO: 2.5,
  // NHL puck lines are +/-1.5, with +/-2.5 as the common alternate - the same
  // fixed-handicap shape as a run line. A "+7.5" or "+15.5" next to an NHL
  // candidate is a football/basketball spread.
  NHL: 2.5,
  // WNBA spreads realistically top out in the mid-teens; a -44 (a real
  // misresolution of an Indiana Hoosiers pick to the Fever) is essentially
  // impossible. DOMAIN ESTIMATE, not backtested - same caveat as above.
  WNBA: 20,
  // NBA spreads top out in the low-to-mid 20s; 30 leaves headroom. Covers
  // the third Indiana candidate (Pacers) so a -44 can narrow to NCAAF alone.
  NBA: 30,
  // NCAAF regularly sees 30-40+ point spreads (FBS-vs-FCS, ranked-vs-
  // unranked); past this is already an extreme outlier. Bounded so the
  // WNBA-vs-NCAAF "Indiana" collision can narrow in either direction.
  NCAAF: 65,
};

// MLB/KBO full-game totals conventionally cluster roughly 6.5-11 runs; the
// max leaves room for a Coors Field number.
// DOMAIN ESTIMATE, not backtested against this app's own historical odds
// data - same caveat as SPREAD_MAGNITUDE_BOUND above.
const TOTAL_LINE_BOUND: Partial<Record<string, { min: number; max: number }>> = {
  MLB: { min: 4, max: 14.5 },
  KBO: { min: 4, max: 14.5 },
  // NHL full-game totals sit at 5.5-6.5 almost every night; 4.5 and 8.5 are
  // the outer alternates.
  NHL: { min: 4.5, max: 8.5 },
  // WNBA full-game totals cluster roughly 150-175; NCAAF roughly 40-65 with
  // rare shootouts higher. Estimates, set well outside the normal range.
  WNBA: { min: 120, max: 200 },
  // NBA full-game totals cluster roughly 200-245.
  NBA: { min: 180, max: 280 },
  NCAAF: { min: 20, max: 100 },
  // NFL full-game totals run roughly 33-56; the lowest closing totals on
  // record sit around 28-30 and the highest in the low 60s. Set well outside
  // that: the point is that an "over 6.5" / "over 8.5" is never an NFL game.
  NFL: { min: 24, max: 75 },
};

// Full-game TEAM total floor, for the leagues where one is safe to state. An
// NFL team total is roughly 10-35; alternates reach lower, but nothing is
// posted near a hockey team total (2.5-3.5). Leagues absent here have no
// team-total floor - only the game maximum above applies to them.
// DOMAIN ESTIMATE, same caveat as the tables above.
const TEAM_TOTAL_MIN: Partial<Record<string, number>> = {
  NFL: 6,
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
// A candidate whose sport has no entry in the relevant bound table above (an
// NFL spread, or any league not involved in a confirmed cross-league
// line-shape collision) is never filtered out by this function - it has no known realistic range
// here to compare against, so it's left as plausible rather than guessed at.
//
// The total MINIMUM is a full-game, both-teams number, so it is only applied
// to a full-game TOTAL: a team total ("Panthers TT o2.5") or a partial-game
// total ("1P o1.5", "F5 u4.5") is legitimately far below it, and applying it
// would drop the very league the pick is about. The maximum still applies to
// both - no slice of a game outscores the whole game. A full-game team total
// has its own, lower floor where TEAM_TOTAL_MIN lists one. `partialGame` is
// the pick's own ambiguousPartialGame; omitted means a full-game bet.
//
// `betType` must be the pick's own parsed bet type (ambiguousBetType), never
// the stored ParsedPick.betType: an unresolved ambiguous pick stores a SPREAD
// placeholder there, and a 6.5 "over" checked as a spread would pass for NFL.
export function filterPlausibleCandidates(
  candidates: AmbiguousOption[],
  betType: ParsedPick["betType"] | undefined,
  line: number | null | undefined,
  partialGame = false
): AmbiguousOption[] {
  if (line === null || line === undefined || betType === undefined) return candidates;

  if (betType === "SPREAD") {
    return candidates.filter((c) => {
      const bound = SPREAD_MAGNITUDE_BOUND[c.sport];
      return bound === undefined || Math.abs(line) <= bound;
    });
  }

  if (betType === "TOTAL" || betType === "TEAM_TOTAL") {
    return candidates.filter((c) => {
      const range = TOTAL_LINE_BOUND[c.sport];
      if (range !== undefined && line > range.max) return false;
      if (partialGame) return true;
      const min = betType === "TOTAL" ? range?.min : TEAM_TOTAL_MIN[c.sport];
      return min === undefined || line >= min;
    });
  }

  return candidates;
}
