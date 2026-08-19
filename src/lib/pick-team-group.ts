import { findGroupingNickname } from "@/lib/parse-catalog";

export type PickTeamGroup = "AWAY" | "HOME" | "OTHER";

// Only moneyline and spread bets are actually resolved by which team wins/
// covers - totals, NRFI, and player props are decided by something else
// entirely, so they never belong to a team group no matter what team name
// happens to appear in betDetail (e.g. an over/under with both team
// nicknames in its annotation).
const TEAM_TIED_BET_TYPES = new Set(["MONEYLINE", "SPREAD"]);

// Which side of the matchup a pick is on, inferred from betDetail text
// against each team's nickname - similar in spirit to the "does betDetail
// mention this team's nickname" check matchPicksToGame (server/data/picks.ts)
// uses to decide whether a pick belongs to a game at all (applied to each
// side separately instead of OR'd together), but deliberately using
// findGroupingNickname instead of matchPicksToGame's findTeamNickname - see
// findGroupingNickname's comment in parse-catalog.ts for why those can't be
// the same lookup.
export function classifyPickTeamGroup(
  pick: { betType: string; betDetail: string | null },
  game: { homeTeam: string; awayTeam: string },
  sportName: string
): PickTeamGroup {
  if (!TEAM_TIED_BET_TYPES.has(pick.betType)) return "OTHER";

  const text = (pick.betDetail ?? "").toLowerCase();

  const awayNickname = findGroupingNickname(game.awayTeam, sportName);
  if (awayNickname && text.includes(awayNickname)) return "AWAY";

  const homeNickname = findGroupingNickname(game.homeTeam, sportName);
  if (homeNickname && text.includes(homeNickname)) return "HOME";

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
