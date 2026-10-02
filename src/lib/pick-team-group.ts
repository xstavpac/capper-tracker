import { findGroupingNickname, teamGroupAliases, teamPhraseRegex, normalizeForGrouping } from "@/lib/parse-catalog";
import type { PickedSide } from "@prisma/client";

export type PickTeamGroup = "AWAY" | "HOME" | "TOTALS" | "OTHER";

// Shared labels for the two non-team groups - GamePicksExpander (Standard
// Live), GameDetailPanel (Grid Live) and /live/[gameId] all render these same
// groups under these same labels, so they live here rather than in any view.
// TOTALS is game/team over-unders only; OTHER is player props, NRFI, and any
// team-tied bet whose betDetail didn't text-match either side.
export const TOTALS_GROUP_LABEL = "Totals";
export const OTHER_GROUP_LABEL = "Other markets";

// Classified strictly from the resolved betType stored at import - never from
// "over"/"under" wording or the presence of a line, since a player prop
// ("Over 5.5 Ks") has both but is not a game total.
const TOTALS_BET_TYPES = new Set(["TOTAL", "TEAM_TOTAL"]);

// Only moneyline and spread bets are actually resolved by which team wins/
// covers - totals, NRFI, and player props are decided by something else
// entirely, so they never belong to a team group no matter what team name
// happens to appear in betDetail (e.g. an over/under with both team
// nicknames in its annotation).
const TEAM_TIED_BET_TYPES = new Set(["MONEYLINE", "SPREAD"]);

// Which side of the matchup a pick is on. Prefers pick.pickedSide - captured
// once at import time from the specific matched game (resolveGameAndOdds in
// bulk-picks.ts) - over re-deriving it from betDetail text here, since
// pickedSide already reflects whatever matching actually resolved the pick to
// its game (e.g. live-team-fallback.ts's dynamically-generated prefix keys),
// which can succeed off the pick's homeTeam/awayTeam columns even when
// teamGroupAliases' smaller, curated vocabulary wouldn't recognize the raw
// text (a bare city name like "Tampa Bay" with no mascot, or "Kent" for Kent
// State, which teamGroupAliases only keys as "kent state").
//
// Falls back to the text heuristic below when pickedSide is null - same-
// mascot NCAAF matchups where side genuinely can't be determined from the
// pick alone, or picks that never went through resolveGameAndOdds.
//
// Text-heuristic fallback: which side of the matchup a pick is on, inferred
// from betDetail text against each team's nicknames - similar in spirit to
// the "does betDetail mention this team's nickname" check matchPicksToGame
// (server/data/picks.ts) uses to decide whether a pick belongs to a game at
// all (applied to each side separately instead of OR'd together).
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
  pick: { betType: string; betDetail: string | null; pickedSide?: PickedSide | null },
  game: { homeTeam: string; awayTeam: string },
  sportName: string
): PickTeamGroup {
  if (TOTALS_BET_TYPES.has(pick.betType)) return "TOTALS";
  if (!TEAM_TIED_BET_TYPES.has(pick.betType)) return "OTHER";

  if (pick.pickedSide === "HOME") return "HOME";
  if (pick.pickedSide === "AWAY") return "AWAY";

  const text = normalizeForGrouping(pick.betDetail ?? "");
  const mentions = (aliases: string[]) => aliases.some((a) => teamPhraseRegex(a).test(text));

  if (mentions(teamGroupAliases(game.awayTeam, sportName))) return "AWAY";
  if (mentions(teamGroupAliases(game.homeTeam, sportName))) return "HOME";

  return "OTHER";
}

// Order inside the Totals group: full-game game totals, then period totals
// (half/quarter/inning/period), then team totals. Stable for ties, so picks
// keep their incoming order within each rank.
function totalsRank(pick: { betType: string; period: string }): number {
  if (pick.betType === "TEAM_TOTAL") return 2;
  return pick.period === "FULL_GAME" ? 0 : 1;
}

export function sortTotalsPicks<T extends { betType: string; period: string }>(picks: T[]): T[] {
  return [...picks].sort((a, b) => totalsRank(a) - totalsRank(b));
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
