// Which side of an NCAAB game a pick's text names, for classifyPickTeamGroup's
// text fallback (used only when Pick.pickedSide is null).
//
// College basketball has no entry in GROUPING_TEAM_NICKNAMES (parse-catalog.ts), so
// teamGroupAliases() answered [] for every NCAAB team and every NCAAB spread or
// moneyline fell to "OTHER" - "Couldn't tell which team this pick is on" in Send to
// FanDuel. Rather than hand-adding nicknames, the team on the game is looked up in
// the same Division I school list import reads (NCAAB_SCHOOLS), through the shared
// teamNamesMatch, so either feed's spelling of the game's team finds its school
// ("Sam Houston St Bearkats", "Fort Wayne Mastodons", "South Dakota St Jackrabbits").
//
// The school's whole key set is the alias set. When both teams' keys appear in the
// text, the LONGER match wins ("South Dakota State +10" in South Dakota @ South Dakota
// State is State's: "south dakota state" beats "south dakota"); a tie names no side.
import { NCAAB_D1_TEAMS } from "@/lib/generated/college-teams.generated";
import { NCAAB_SCHOOLS } from "@/lib/college-teams";
import { teamNamesMatch } from "@/lib/team-name-match";
import { normalizeForGrouping, teamPhraseRegex } from "@/lib/parse-catalog";

const NCAAB_KEY = "basketball_ncaab";

const KEYS_BY_CANONICAL = new Map<string, string[]>();
for (const [key, canonical] of NCAAB_SCHOOLS) KEYS_BY_CANONICAL.set(canonical, [...(KEYS_BY_CANONICAL.get(canonical) ?? []), key]);

const memo = new Map<string, string[]>();

// Every phrase a capper might type for the school a game's team name is, folded
// like the pick text (normalizeForGrouping). [] when the name is no D1 school.
export function ncaabTeamAliases(teamName: string): string[] {
  const hit = memo.get(teamName);
  if (hit) return hit;
  const school = NCAAB_D1_TEAMS.find((t) => teamNamesMatch(t.name, teamName, NCAAB_KEY));
  const keys = school ? (KEYS_BY_CANONICAL.get(school.name.toLowerCase()) ?? []) : [];
  const folded = keys.flatMap((k) => {
    const n = normalizeForGrouping(k);
    // "State" is also written "St" ("South Dakota St +10").
    return /\bstate\b/.test(n) ? [n, n.replace(/\bstate\b/g, "st")] : [n];
  });
  const aliases = Array.from(new Set(folded));
  memo.set(teamName, aliases);
  return aliases;
}

// The longest alias of the team that the (already folded) text contains, 0 for none.
function longestMention(text: string, aliases: string[]): number {
  return aliases.reduce((best, a) => (a.length > best && teamPhraseRegex(a).test(text) ? a.length : best), 0);
}

export function ncaabSideFromText(text: string, game: { homeTeam: string; awayTeam: string }): "HOME" | "AWAY" | null {
  const away = longestMention(text, ncaabTeamAliases(game.awayTeam));
  const home = longestMention(text, ncaabTeamAliases(game.homeTeam));
  if (away === home) return null;
  return away > home ? "AWAY" : "HOME";
}
