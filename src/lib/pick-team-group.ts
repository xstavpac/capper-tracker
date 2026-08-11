import { findTeamNickname } from "@/lib/parse-catalog";

export type PickTeamGroup = "AWAY" | "HOME" | "OTHER";

// Only moneyline and spread bets are actually resolved by which team wins/
// covers - totals, NRFI, and player props are decided by something else
// entirely, so they never belong to a team group no matter what team name
// happens to appear in betDetail (e.g. an over/under with both team
// nicknames in its annotation).
const TEAM_TIED_BET_TYPES = new Set(["MONEYLINE", "SPREAD"]);

// Which side of the matchup a pick is on, inferred from betDetail text
// against each team's nickname - the same "does betDetail mention this
// team's nickname" check matchPicksToGame (server/data/picks.ts) already
// uses to decide whether a pick belongs to a game at all, just applied to
// each side separately instead of OR'd together.
export function classifyPickTeamGroup(
  pick: { betType: string; betDetail: string | null },
  game: { homeTeam: string; awayTeam: string },
  sportName: string
): PickTeamGroup {
  if (!TEAM_TIED_BET_TYPES.has(pick.betType)) return "OTHER";

  const text = (pick.betDetail ?? "").toLowerCase();

  const awayNickname = findTeamNickname(game.awayTeam, sportName);
  if (awayNickname && text.includes(awayNickname)) return "AWAY";

  const homeNickname = findTeamNickname(game.homeTeam, sportName);
  if (homeNickname && text.includes(homeNickname)) return "HOME";

  return "OTHER";
}

// "Pittsburgh Pirates" -> "Pirates" for a group header short enough to sit
// next to a pick count - falls back to the full name on the rare team whose
// nickname isn't in the lookup tables rather than showing nothing.
export function shortTeamName(fullName: string, sportName: string): string {
  const nickname = findTeamNickname(fullName, sportName);
  if (!nickname) return fullName;
  return nickname
    .split(" ")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}
