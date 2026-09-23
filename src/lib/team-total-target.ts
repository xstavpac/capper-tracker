import { teamGroupAliases, teamPhraseRegex, normalizeForGrouping } from "@/lib/parse-catalog";

// Which team a TEAM_TOTAL pick's total is for, e.g. "Yankees Over 4.5" on a
// Yankees @ Red Sox game -> "New York Yankees". pick-side.ts's
// classifyPickTeamGroup deliberately returns "OTHER" for TEAM_TOTAL (only
// MONEYLINE/SPREAD are "team-tied" there - see its own comment), so this
// doesn't touch pick-side.ts or change derivePickSide's behavior at all; it's
// a sibling lookup for the one betType pick-side.ts explicitly excludes.
//
// Reuses the exact same nickname-matching primitives classifyPickTeamGroup
// itself calls (teamGroupAliases / teamPhraseRegex / normalizeForGrouping
// from parse-catalog.ts) - not a new parsing heuristic. Checks the away
// team's aliases before the home team's, same order classifyPickTeamGroup
// uses for its own AWAY/HOME check.
//
// The parlay relationship classifier needs this to tell whether two
// TEAM_TOTAL picks share the "same total" (R1/R3/R5) or target different
// teams (UNCLASSIFIED) - see src/lib/parlay/relationship-classifier.ts.
// Returns null when the text doesn't match either team's alias set (a real,
// if rare, gap - an unregistered nickname/alias) - never a guess.
export function deriveTeamTotalTarget(
  pick: { betType: string; betDetail: string | null },
  game: { homeTeam: string; awayTeam: string },
  sportName: string
): string | null {
  if (pick.betType !== "TEAM_TOTAL") return null;

  const text = normalizeForGrouping(pick.betDetail ?? "");
  const mentions = (aliases: string[]) => aliases.some((a) => teamPhraseRegex(a).test(text));

  if (mentions(teamGroupAliases(game.awayTeam, sportName))) return game.awayTeam;
  if (mentions(teamGroupAliases(game.homeTeam, sportName))) return game.homeTeam;
  return null;
}
