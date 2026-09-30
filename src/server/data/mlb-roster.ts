// MLB roster fetch + extraction (live MLB Stats API call) - the MLB twin of nhl-roster.ts,
// used by ONE caller: scripts/load-mlb-roster.ts, run by hand to (re)populate the
// mlb_roster_players cache table. Nothing in the request path fetches rosters; catalog-import
// recovery and MLB prop grading read the cache (mlb-roster-cache.ts).
//
// Endpoint: statsapi.mlb.com/api/v1/teams/{id}/roster?rosterType=40Man&season=YYYY&hydrate=person
// (verified 2026-09-30). 40Man, not `active`/`fullSeason`: it covers ~98% of the players who
// appeared in Sep 10-29 box scores (active ~90%, fullSeason 100% but 186 ids sit on 2+ teams after
// trades), and gives exactly one current team per player. Player ids are the SAME person ids the
// box score reports (teams.*.players."ID<id>".person.id) - which is what makes id-verified matching
// and the did-not-play check in mlb-prop-grading.ts possible.
//
// hydrate=person adds firstName/lastName/useName. firstName stored is the USE name ("Alex"), not
// the legal one ("Alexander"): it is what the box score's fullName and cappers use.
//
// team is the Stats API team.name - byte-identical to GameResult.homeTeam/awayTeam for MLB (both come
// from the same API), so a resolved roster hit can feed teamNicknames exactly like NFL/NHL.
import type { RosterPlayer } from "@/server/data/nfl-roster";

// All 30 franchises: Stats API team id + name. Verified live against /teams?sportId=1 on 2026-09-30.
export const MLB_TEAM_IDS: [mlbTeamId: string, teamName: string][] = [
  ["109", "Arizona Diamondbacks"],
  ["144", "Atlanta Braves"],
  ["110", "Baltimore Orioles"],
  ["111", "Boston Red Sox"],
  ["112", "Chicago Cubs"],
  ["145", "Chicago White Sox"],
  ["113", "Cincinnati Reds"],
  ["114", "Cleveland Guardians"],
  ["115", "Colorado Rockies"],
  ["116", "Detroit Tigers"],
  ["117", "Houston Astros"],
  ["118", "Kansas City Royals"],
  ["108", "Los Angeles Angels"],
  ["119", "Los Angeles Dodgers"],
  ["146", "Miami Marlins"],
  ["158", "Milwaukee Brewers"],
  ["142", "Minnesota Twins"],
  ["121", "New York Mets"],
  ["147", "New York Yankees"],
  ["133", "Athletics"],
  ["143", "Philadelphia Phillies"],
  ["134", "Pittsburgh Pirates"],
  ["135", "San Diego Padres"],
  ["137", "San Francisco Giants"],
  ["136", "Seattle Mariners"],
  ["138", "St. Louis Cardinals"],
  ["139", "Tampa Bay Rays"],
  ["140", "Texas Rangers"],
  ["141", "Toronto Blue Jays"],
  ["120", "Washington Nationals"],
];

type RawRosterEntry = {
  person?: { id?: number; fullName?: string; firstName?: string; lastName?: string; useName?: string };
  position?: { abbreviation?: string };
};

// Flattens one team's 40-man response into RosterPlayers. Every position is kept (pitchers AND
// hitters are prop subjects); position is the Stats API abbreviation (P, C, 1B..RF, OF, DH, TWP).
export function extractMlbRosterPlayers(team: string, response: unknown): RosterPlayer[] {
  const roster = (response as { roster?: RawRosterEntry[] } | null)?.roster;
  if (!Array.isArray(roster)) return [];
  const out: RosterPlayer[] = [];
  for (const r of roster) {
    const p = r.person;
    const position = r.position?.abbreviation;
    const lastName = p?.lastName;
    const firstName = p?.useName || p?.firstName;
    if (!p || p.id === undefined || !p.fullName || !firstName || !lastName || !position) continue;
    out.push({
      playerName: p.fullName,
      firstName,
      lastName,
      team,
      position,
      externalPlayerId: String(p.id),
    });
  }
  return out;
}

// Never throws: a failed team returns [] (logged), so one outage can't take down the league fetch -
// and a player on a failed team simply isn't indexed this cycle, leaving their line unresolved,
// never misreported. (The loader additionally refuses to COMMIT a partial league.)
async function fetchMlbTeamRoster(mlbTeamId: string, team: string, season: number): Promise<RosterPlayer[]> {
  try {
    const res = await fetch(
      `https://statsapi.mlb.com/api/v1/teams/${mlbTeamId}/roster?rosterType=40Man&season=${season}&hydrate=person`,
      { next: { revalidate: 3600 } }
    );
    if (!res.ok) {
      console.error(`fetchMlbTeamRoster: Stats API roster fetch failed for ${team} (${res.status})`);
      return [];
    }
    return extractMlbRosterPlayers(team, await res.json());
  } catch (err) {
    console.error(`fetchMlbTeamRoster: Stats API roster fetch threw for ${team}`, err);
    return [];
  }
}

export async function fetchMlbLeagueRoster(season: number): Promise<RosterPlayer[]> {
  const perTeam = await Promise.all(MLB_TEAM_IDS.map(([id, team]) => fetchMlbTeamRoster(id, team, season)));
  return perTeam.flat();
}
