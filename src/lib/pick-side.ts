import { classifyPickTeamGroup } from "@/lib/pick-team-group";

export type PickSide = "HOME" | "AWAY";

// Runtime replacement for reading Pick.pickedSide - for a pick where that
// column is null (no backfill exists or is planned for it - see the
// pickedSide field comment in schema.prisma), derive which side of the game
// the pick is on by matching betDetail against game.homeTeam/game.awayTeam,
// the same way the Live tab already does for its AWAY/HOME/OTHER grouping.
// Reuses classifyPickTeamGroup (pick-team-group.ts) rather than a second
// text-matching implementation: that function already handles the real
// formatting gap between the two sides - betDetail is written as a bare
// mascot ("Pirates Moneyline"), never the "City Mascot" form homeTeam/
// awayTeam are stored in ("Pittsburgh Pirates") - via teamGroupAliases'
// nickname lookup, plus case/diacritic/apostrophe folding
// (normalizeForGrouping) and word-boundary phrase matching (teamPhraseRegex)
// so a short alias ("FIU", "Hawaii") can't false-match inside unrelated text.
//
// Verified against a production snapshot (4,984 picks, restored from a prod
// dump dated 2026-09-15): of the 1,451 MONEYLINE/SPREAD picks with a null
// pickedSide, 94.8% (1,376) resolved to HOME/AWAY here. Of those, only 8.2%
// would have matched a naive `betDetail.includes(fullTeamName)` check -
// 86.6% needed exactly this nickname normalization (e.g. matching "Yankees"
// in betDetail against homeTeam "New York Yankees"). The remaining 5.2%
// (75 picks) couldn't be resolved at all, and correctly so: every one is
// either an individual-competitor pick (ATP tennis - homeTeam holds the raw
// betDetail text and awayTeam is a literal "-" placeholder, since there's no
// second "team" and no nickname table for player names) or a synthetic
// fixture row (betDetail "ML" naming no team at all). Returning null for
// these is the correct outcome, not a normalization gap to close.
//
// Only MONEYLINE/SPREAD picks are resolvable at all - a TOTAL, NRFI, or
// TEAM_TOTAL pick isn't decided by which side wins/covers, so it never has a
// "side" no matter what team name its betDetail happens to mention
// (classifyPickTeamGroup returns OTHER for every other betType by design).
export function derivePickSide(
  pick: { betType: string; betDetail: string | null },
  game: { homeTeam: string; awayTeam: string },
  sportName: string
): PickSide | null {
  const group = classifyPickTeamGroup(pick, game, sportName);
  return group === "OTHER" ? null : group;
}

// The actual team name the pick is on ("Pittsburgh Pirates"), for comparing
// two picks - possibly from different games - for "same team" logic (e.g.
// Contrarian fading a capper's exact team pick). null under the same
// conditions derivePickSide returns null.
export function derivePickTeamName(
  pick: { betType: string; betDetail: string | null },
  game: { homeTeam: string; awayTeam: string },
  sportName: string
): string | null {
  const side = derivePickSide(pick, game, sportName);
  if (!side) return null;
  return side === "HOME" ? game.homeTeam : game.awayTeam;
}

// The OTHER team in the pick's own game, for Auto Hedge (the pick that
// covers the opposite side of the same matchup). null under the same
// conditions derivePickSide returns null.
export function deriveOpposingTeamName(
  pick: { betType: string; betDetail: string | null },
  game: { homeTeam: string; awayTeam: string },
  sportName: string
): string | null {
  const side = derivePickSide(pick, game, sportName);
  if (!side) return null;
  return side === "HOME" ? game.awayTeam : game.homeTeam;
}
