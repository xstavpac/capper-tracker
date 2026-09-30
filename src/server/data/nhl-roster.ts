// NHL roster fetch + extraction (live ESPN call) - the NHL twin of
// nfl-roster.ts, used by ONE caller: scripts/load-nhl-roster.ts, run by hand to
// (re)populate the nhl_roster_players cache table. Nothing in the request path
// fetches ESPN rosters; catalog-import recovery and NHL prop grading read the
// cache (nhl-roster-cache.ts). NFL roster code is deliberately NOT shared or
// touched - ESPN player ids are per-league, and a separate table keeps the live
// NFL loader's espnPlayerId @unique and stale-row cleanup exactly as they were.
//
// ESPN endpoint: site.api.espn.com/apis/site/v2/sports/hockey/nhl/teams/{id}/roster
// (verified 2026-09-30: groups Centers / Left Wings / Right Wings / Defense /
// Goalies, athletes[].items[] with id/displayName/firstName/lastName/position).
// The player ids are the SAME ids the summary box score reports
// (boxscore.players[].statistics[].athletes[].athlete.id) - checked for Crosby,
// Koivunen, Robertson, Silovs - which is what makes id-verified matching and the
// did-not-play check in nhl-prop-grading.ts possible.
import type { RosterPlayer } from "@/server/data/nfl-roster";

const RELEVANT_POSITIONS = new Set(["C", "LW", "RW", "D", "G"]);

// All 32 current franchises: ESPN numeric team id + displayName, which is
// byte-identical to the box score's team.displayName and to
// GameResult.homeTeam/awayTeam's spelling (ESPN-sourced), so a resolved roster
// hit can be used as a teamNickname via team.toLowerCase() exactly like NFL.
// Verified live against /teams?limit=50 on 2026-09-30. Keyed by ESPN's numeric
// id (Seattle 124292 and Utah 129764 are not small integers).
export const NHL_ESPN_TEAM_IDS: [espnTeamId: string, teamName: string][] = [
  ["25", "Anaheim Ducks"],
  ["1", "Boston Bruins"],
  ["2", "Buffalo Sabres"],
  ["3", "Calgary Flames"],
  ["7", "Carolina Hurricanes"],
  ["4", "Chicago Blackhawks"],
  ["17", "Colorado Avalanche"],
  ["29", "Columbus Blue Jackets"],
  ["9", "Dallas Stars"],
  ["5", "Detroit Red Wings"],
  ["6", "Edmonton Oilers"],
  ["26", "Florida Panthers"],
  ["8", "Los Angeles Kings"],
  ["30", "Minnesota Wild"],
  ["10", "Montreal Canadiens"],
  ["27", "Nashville Predators"],
  ["11", "New Jersey Devils"],
  ["12", "New York Islanders"],
  ["13", "New York Rangers"],
  ["14", "Ottawa Senators"],
  ["15", "Philadelphia Flyers"],
  ["16", "Pittsburgh Penguins"],
  ["18", "San Jose Sharks"],
  ["124292", "Seattle Kraken"],
  ["19", "St. Louis Blues"],
  ["20", "Tampa Bay Lightning"],
  ["21", "Toronto Maple Leafs"],
  ["129764", "Utah Mammoth"],
  ["22", "Vancouver Canucks"],
  ["37", "Vegas Golden Knights"],
  ["23", "Washington Capitals"],
  ["28", "Winnipeg Jets"],
];

// Flattens ESPN's position-grouped roster response into one flat list for
// `team`, keeping only C/LW/RW/D/G (every position a supported NHL prop can be
// about - skaters for goals/shots/points/assists, goalies for saves).
export function extractNhlRosterPlayers(team: string, espnRosterResponse: unknown): RosterPlayer[] {
  const groups = (
    espnRosterResponse as {
      athletes?: {
        items?: { id?: string; displayName?: string; firstName?: string; lastName?: string; position?: { abbreviation?: string } }[];
      }[];
    } | null
  )?.athletes;
  if (!Array.isArray(groups)) return [];

  const out: RosterPlayer[] = [];
  for (const group of groups) {
    for (const item of group.items ?? []) {
      const position = item.position?.abbreviation;
      if (!item.displayName || !item.id || !item.firstName || !item.lastName || !position) continue;
      if (!RELEVANT_POSITIONS.has(position)) continue;
      out.push({
        playerName: item.displayName,
        firstName: item.firstName,
        lastName: item.lastName,
        team,
        position,
        espnPlayerId: item.id,
      });
    }
  }
  return out;
}

// Never throws: a failed team returns [] (logged), so one outage can't take
// down the league fetch - and a player on a failed team simply isn't indexed
// this cycle, leaving their line unresolved, never misreported.
async function fetchNhlTeamRoster(espnTeamId: string, team: string): Promise<RosterPlayer[]> {
  try {
    const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/teams/${espnTeamId}/roster`, {
      next: { revalidate: 3600 },
    });
    if (!res.ok) {
      console.error(`fetchNhlTeamRoster: ESPN roster fetch failed for ${team} (${res.status})`);
      return [];
    }
    return extractNhlRosterPlayers(team, await res.json());
  } catch (err) {
    console.error(`fetchNhlTeamRoster: ESPN roster fetch threw for ${team}`, err);
    return [];
  }
}

export async function fetchNhlLeagueRoster(): Promise<RosterPlayer[]> {
  const perTeam = await Promise.all(NHL_ESPN_TEAM_IDS.map(([id, team]) => fetchNhlTeamRoster(id, team)));
  return perTeam.flat();
}
