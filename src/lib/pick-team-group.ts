import { findGroupingNickname, teamGroupAliases, teamPhraseRegex, normalizeForGrouping } from "@/lib/parse-catalog";

export type PickTeamGroup = "AWAY" | "HOME" | "OTHER";

// Only moneyline and spread bets are actually resolved by which team wins/
// covers - totals, NRFI, and player props are decided by something else
// entirely, so they never belong to a team group no matter what team name
// happens to appear in betDetail (e.g. an over/under with both team
// nicknames in its annotation).
const TEAM_TIED_BET_TYPES = new Set(["MONEYLINE", "SPREAD"]);

// Which side of the matchup a pick is on, inferred from betDetail text
// against each team's nicknames - similar in spirit to the "does betDetail
// mention this team's nickname" check matchPicksToGame (server/data/picks.ts)
// uses to decide whether a pick belongs to a game at all (applied to each
// side separately instead of OR'd together).
//
// Checks betDetail against the team's WHOLE alias set (teamGroupAliases), not
// a single nickname: for NCAAF one school ("Florida International Panthers")
// has several keys ("florida international", "fiu"), and a capper writing the
// one this view didn't derive from the schedule name was landing in "Totals
// & other markets". Uses teamPhraseRegex (word boundaries), not includes(),
// so a 3-letter alias like "fiu"/"ecu"/"usf" can't false-match inside an
// unrelated word - the same reason matchPicksToGame switched off includes().
// betDetail is diacritic/apostrophe-folded to line up with the ascii alias
// keys ("San José State" -> "san jose state").
export function classifyPickTeamGroup(
  pick: { betType: string; betDetail: string | null },
  game: { homeTeam: string; awayTeam: string },
  sportName: string
): PickTeamGroup {
  if (!TEAM_TIED_BET_TYPES.has(pick.betType)) return "OTHER";

  const text = normalizeForGrouping(pick.betDetail ?? "");
  const mentions = (aliases: string[]) => aliases.some((a) => teamPhraseRegex(a).test(text));

  if (mentions(teamGroupAliases(game.awayTeam, sportName))) return "AWAY";
  if (mentions(teamGroupAliases(game.homeTeam, sportName))) return "HOME";

  return "OTHER";
}

// "Pittsburgh Pirates" -> "Pirates" for a group header short enough to sit
// next to a pick count - falls back to the full name on the rare team whose
// nickname isn't in the lookup tables rather than showing nothing.
export function shortTeamName(fullName: string, sportName: string): string {
  const nickname = findGroupingNickname(fullName, sportName);
  if (!nickname) return fullName;
  return nickname
    .split(" ")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}
