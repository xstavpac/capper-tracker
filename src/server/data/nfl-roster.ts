// NFL current-roster lookup: given a bare player name with no team prefix
// ("Patrick Mahomes Over 225 Passing Yards" - no "Chiefs" in the text),
// resolve which team they're currently on, so a bulk-import line like that
// can resolve at all instead of landing in `unresolved`. See
// player-roster-fallback.ts for the actual name-matching logic this feeds -
// this file is fetch + extraction only.
//
// Uses ESPN's team roster endpoint (site.api.espn.com/.../teams/{id}/roster)
// - the same "site API" domain nfl-passer-rows.ts/nfl-rushing-receiving-
// rows.ts already fetch from, just a different endpoint. Deliberately NOT
// the box-score endpoints those files use: a roster is available regardless
// of whether any game has been played yet, and a bulk-import paste happens
// BEFORE kickoff, when no box score for that week exists.
//
// Investigated and ruled out first: NflPasserRow/NflRushingRow/
// NflReceivingRow (schema.prisma) look like a ready-made roster source -
// they carry exactly playerName/team/espnPlayerId - but persistNflPasserRows/
// persistNflRushingRows/persistNflReceivingRows are only ever called from
// their own acceptance tests, never from grading.ts or any other production
// path, so those tables are unpopulated in practice (confirmed by grep
// during the 2026-09 bulk-import roster investigation). Even if they were
// populated, they only gain a player after a graded game - too late for a
// pre-kickoff pick. Hence this new, separate fetch instead of reusing them.
export type RosterPlayer = { playerName: string; team: string; espnPlayerId: string };

// All 32 current NFL franchises' ESPN numeric team id + canonical full name.
// The canonical name matches GameResult.homeTeam/awayTeam's spelling exactly
// (verified live 2026-09-15 against ESPN's own /teams list, whose
// `displayName` for every team is byte-identical to nfl-team-stats.ts's
// NFL_TEAM_NAMES_BY_ABBR values) - so a resolved roster hit can be used as a
// teamNickname (via team.toLowerCase()) with no further translation, same as
// live-team-fallback.ts's resolved `nickname` already is.
//
// Deliberately keyed by ESPN's numeric id, NOT reusing NFL_TEAM_NAMES_BY_ABBR's
// abbreviation keys - ESPN's own abbreviation differs from nflverse's for two
// teams (confirmed live): the Rams are "LAR" here vs nflverse's "LA", and the
// Commanders are "WSH" here vs nflverse's "WAS" (nfl-team-stats.ts's own
// comment already flags this same WAS/WSH mismatch). The numeric id has no
// such ambiguity and is what ESPN's roster endpoint actually keys on.
export const NFL_ESPN_TEAM_IDS: [espnTeamId: string, teamName: string][] = [
  ["22", "Arizona Cardinals"],
  ["1", "Atlanta Falcons"],
  ["33", "Baltimore Ravens"],
  ["2", "Buffalo Bills"],
  ["29", "Carolina Panthers"],
  ["3", "Chicago Bears"],
  ["4", "Cincinnati Bengals"],
  ["5", "Cleveland Browns"],
  ["6", "Dallas Cowboys"],
  ["7", "Denver Broncos"],
  ["8", "Detroit Lions"],
  ["9", "Green Bay Packers"],
  ["34", "Houston Texans"],
  ["11", "Indianapolis Colts"],
  ["30", "Jacksonville Jaguars"],
  ["12", "Kansas City Chiefs"],
  ["13", "Las Vegas Raiders"],
  ["24", "Los Angeles Chargers"],
  ["14", "Los Angeles Rams"],
  ["15", "Miami Dolphins"],
  ["16", "Minnesota Vikings"],
  ["17", "New England Patriots"],
  ["18", "New Orleans Saints"],
  ["19", "New York Giants"],
  ["20", "New York Jets"],
  ["21", "Philadelphia Eagles"],
  ["23", "Pittsburgh Steelers"],
  ["25", "San Francisco 49ers"],
  ["26", "Seattle Seahawks"],
  ["27", "Tampa Bay Buccaneers"],
  ["10", "Tennessee Titans"],
  ["28", "Washington Commanders"],
];

// Pure - flattens ESPN's position-grouped roster response
// (athletes[].items[], each an athlete with displayName/id) into one flat
// list for `team`. displayName is used as-is, including any generational
// suffix ESPN includes ("Kenneth Walker III" - confirmed live) -
// player-roster-fallback.ts strips that before comparing against a capper's
// typed name, not this function; this stays a faithful, unopinionated
// extraction, same "no selection/filtering here" convention as
// extractPasserRows/extractRushingRows/extractReceivingRows.
export function extractRosterPlayers(team: string, espnRosterResponse: unknown): RosterPlayer[] {
  const groups = (espnRosterResponse as { athletes?: { items?: { id?: string; displayName?: string }[] }[] } | null)
    ?.athletes;
  if (!Array.isArray(groups)) return [];

  const out: RosterPlayer[] = [];
  for (const group of groups) {
    for (const item of group.items ?? []) {
      if (!item.displayName || !item.id) continue;
      out.push({ playerName: item.displayName, team, espnPlayerId: item.id });
    }
  }
  return out;
}

// Fetch wrapper for one team - never throws: a network failure or non-OK
// response returns an empty list (logged, not silent) rather than rejecting,
// so one team's outage can't take down the whole league fetch below. This is
// the "fail safely" side of the roster fallback - a player on a team whose
// fetch failed simply isn't in the index this cycle, so their line stays
// `unresolved` (the same terminal state it was in before this feature
// existed), never misreported as "not on any roster."
async function fetchNflTeamRoster(espnTeamId: string, team: string): Promise<RosterPlayer[]> {
  try {
    const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${espnTeamId}/roster`, {
      next: { revalidate: 3600 },
    });
    if (!res.ok) {
      console.error(`fetchNflTeamRoster: ESPN roster fetch failed for ${team} (${res.status})`);
      return [];
    }
    return extractRosterPlayers(team, await res.json());
  } catch (err) {
    console.error(`fetchNflTeamRoster: ESPN roster fetch threw for ${team}`, err);
    return [];
  }
}

// The full-league index player-roster-fallback.ts matches a bare player name
// against - all 32 teams fetched in parallel, each independently fault-
// tolerant (see fetchNflTeamRoster above), so a handful of failed teams
// degrades coverage rather than the whole lookup.
export async function fetchNflLeagueRoster(): Promise<RosterPlayer[]> {
  const perTeam = await Promise.all(NFL_ESPN_TEAM_IDS.map(([id, team]) => fetchNflTeamRoster(id, team)));
  return perTeam.flat();
}
