// Post-resolution safety net for the catalog-import ambiguous-nickname
// hierarchy (ambiguous-hierarchy.ts). A pick can clear every step of that
// hierarchy (schedule / season / pick-context / remembered) and still land on
// the wrong league if the signal that decided it (a live game today, a
// calendar window) happened to point the wrong way - the resolved league is
// a *guess dressed as a decision*, not a certainty. This module catches the
// case where the pick's own bet line is implausible for the league it just
// resolved to, e.g. a -44 spread landing on WNBA (WNBA spreads are
// realistically single digits, rarely into the teens; a spread that size is
// unremarkable in NCAAF, where 30-40+ point blowouts are common).
//
// Deliberately dependency-free (no React/Prisma imports) so it loads under
// tsx in ambiguous-hierarchy-acceptance-test.ts, same constraint as
// ambiguous-hierarchy.ts itself.
//
// Scoped ONLY to the leagues actually involved in a confirmed
// AMBIGUOUS_NICKNAMES collision today - WNBA vs NCAAF (the "indiana" key:
// Fever vs Hoosiers). This is deliberately not a comprehensive per-league
// table for every sport parse-catalog.ts tracks; see the PR description for
// other collisions (bucs: NFL vs MLB run line, jets: NFL vs NHL puck line)
// that would likely benefit from the same idea but aren't implemented here.
//
// Bounds are reasonable estimates from general knowledge of each league's
// typical line distribution, NOT backtested against this app's own
// historical odds data - they're set well outside the normal range
// specifically so a plausible-but-unusual line (a WNBA blowout, a close
// NCAAF game) is never flagged, only the genuinely implausible cross-league
// case. See the PR description for the reasoning and an explicit flag that
// these are estimates, not verified historical figures.
const SPREAD_MAGNITUDE_BOUNDS: Record<string, number> = {
  // WNBA spreads realistically top out in the mid-teens; -44 (a real
  // misresolution this fix addresses) is essentially impossible.
  WNBA: 20,
  // NCAAF regularly sees 30-40+ point spreads in FBS-vs-FCS or ranked-vs-
  // unranked blowouts; anything past this is already an extreme outlier.
  NCAAF: 65,
};

const TOTAL_LINE_BOUNDS: Record<string, { min: number; max: number }> = {
  // WNBA full-game totals cluster roughly 150-175.
  WNBA: { min: 120, max: 200 },
  // NCAAF full-game totals cluster roughly 40-65, with rare shootouts higher.
  NCAAF: { min: 20, max: 100 },
};

export type PlausibilityResult =
  | { plausible: true }
  | { plausible: false; reason: string };

// `line` is the numeric spread/total pulled from the pick's text (bet-line.ts's
// extractLine) - null when the bet type has no such line (moneyline, player
// prop) or none could be parsed, in which case there's nothing to check and
// the resolution passes through untouched.
export function checkResolutionPlausibility(
  sport: string,
  betType: "SPREAD" | "MONEYLINE" | "TOTAL" | "TEAM_TOTAL" | "PLAYER_PROP" | "NRFI",
  line: number | null
): PlausibilityResult {
  if (line === null) return { plausible: true };

  if (betType === "SPREAD") {
    const bound = SPREAD_MAGNITUDE_BOUNDS[sport];
    if (bound !== undefined && Math.abs(line) > bound) {
      return {
        plausible: false,
        reason: `${sport} spread of ${line} exceeds the realistic bound (±${bound}) for that league`,
      };
    }
    return { plausible: true };
  }

  if (betType === "TOTAL" || betType === "TEAM_TOTAL") {
    const range = TOTAL_LINE_BOUNDS[sport];
    if (range && (line < range.min || line > range.max)) {
      return {
        plausible: false,
        reason: `${sport} total of ${line} falls outside the realistic range (${range.min}-${range.max}) for that league`,
      };
    }
    return { plausible: true };
  }

  return { plausible: true };
}
