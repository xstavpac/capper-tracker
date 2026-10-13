// NBA roster fetch + extraction (live ESPN call) - the NBA twin of
// nhl-roster.ts, used by ONE caller: scripts/load-nba-roster.ts, run by hand to
// (re)populate the nba_roster_players cache table. Nothing in the request path
// fetches ESPN rosters; readers use the cache (nba-roster-cache.ts). A separate
// table and module from NFL/NHL for the same reason those are separate: ESPN
// player ids are per-league.
//
// ESPN endpoint: site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/{id}/roster
// (verified 2026-10-13, all 30 teams, 625 athletes). Unlike NHL's response,
// `athletes` is a FLAT list - one entry per player with id / displayName /
// firstName / lastName / position.abbreviation - not position groups with an
// `items` array each. Every athlete had all five fields; positions are G, F
// and C only.
//
// The player ids are the SAME ids the summary box score reports
// (boxscore.players[].statistics[].athletes[].athlete.id). Checked 2026-10-13
// against all 16 completed preseason games of 10-10 to 10-12: of 564 box-score
// athletes on NBA teams, 557 were on a current roster under the same id, with
// the same displayName and the same team; the other 7 were on no roster at all
// (camp players since waived) - none appeared on a roster under a different
// id. That is what id-verified matching and a did-not-play check need.
import type { RosterPlayer } from "@/server/data/nfl-roster";

// All 30 franchises: ESPN numeric team id + displayName, which is
// byte-identical to the roster response's own team.displayName, to the box
// score's team.displayName and to GameResult.homeTeam/awayTeam's spelling
// (ESPN-sourced) - note "LA Clippers", not "Los Angeles Clippers". Verified
// live against /teams?limit=50 on 2026-10-13.
export const NBA_ESPN_TEAM_IDS: [espnTeamId: string, teamName: string][] = [
  ["1", "Atlanta Hawks"],
  ["2", "Boston Celtics"],
  ["17", "Brooklyn Nets"],
  ["30", "Charlotte Hornets"],
  ["4", "Chicago Bulls"],
  ["5", "Cleveland Cavaliers"],
  ["6", "Dallas Mavericks"],
  ["7", "Denver Nuggets"],
  ["8", "Detroit Pistons"],
  ["9", "Golden State Warriors"],
  ["10", "Houston Rockets"],
  ["11", "Indiana Pacers"],
  ["12", "LA Clippers"],
  ["13", "Los Angeles Lakers"],
  ["29", "Memphis Grizzlies"],
  ["14", "Miami Heat"],
  ["15", "Milwaukee Bucks"],
  ["16", "Minnesota Timberwolves"],
  ["3", "New Orleans Pelicans"],
  ["18", "New York Knicks"],
  ["25", "Oklahoma City Thunder"],
  ["19", "Orlando Magic"],
  ["20", "Philadelphia 76ers"],
  ["21", "Phoenix Suns"],
  ["22", "Portland Trail Blazers"],
  ["23", "Sacramento Kings"],
  ["24", "San Antonio Spurs"],
  ["28", "Toronto Raptors"],
  ["26", "Utah Jazz"],
  ["27", "Washington Wizards"],
];

// One flat list for `team` from ESPN's flat roster response. Every position
// is kept - any rostered player can have a prop. An entry missing a field the
// cache needs is skipped, never guessed at.
export function extractNbaRosterPlayers(team: string, espnRosterResponse: unknown): RosterPlayer[] {
  const athletes = (
    espnRosterResponse as {
      athletes?: { id?: string; displayName?: string; firstName?: string; lastName?: string; position?: { abbreviation?: string } }[];
    } | null
  )?.athletes;
  if (!Array.isArray(athletes)) return [];

  const out: RosterPlayer[] = [];
  for (const item of athletes) {
    const position = item?.position?.abbreviation;
    if (!item?.displayName || !item.id || !item.firstName || !item.lastName || !position) continue;
    out.push({
      playerName: item.displayName,
      firstName: item.firstName,
      lastName: item.lastName,
      team,
      position,
      externalPlayerId: String(item.id),
    });
  }
  return out;
}

// Never throws: a failed team returns [] (logged), so one outage can't take
// down the league fetch - the loader sees fewer than 30 teams and refuses to
// write (see nba-roster-load.ts).
async function fetchNbaTeamRoster(espnTeamId: string, team: string): Promise<RosterPlayer[]> {
  try {
    const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${espnTeamId}/roster`, {
      next: { revalidate: 3600 },
    });
    if (!res.ok) {
      console.error(`fetchNbaTeamRoster: ESPN roster fetch failed for ${team} (${res.status})`);
      return [];
    }
    return extractNbaRosterPlayers(team, await res.json());
  } catch (err) {
    console.error(`fetchNbaTeamRoster: ESPN roster fetch threw for ${team}`, err);
    return [];
  }
}

export async function fetchNbaLeagueRoster(): Promise<RosterPlayer[]> {
  const perTeam = await Promise.all(NBA_ESPN_TEAM_IDS.map(([id, team]) => fetchNbaTeamRoster(id, team)));
  return perTeam.flat();
}
