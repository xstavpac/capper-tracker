// MLB team-name/id mapping - the free MLB Stats API's own endpoints (used by
// stat-snapshots.ts and the Charts workspace) return a shorter "club name"
// per team than the rest of this app's naming convention (GameResult,
// OddsSnapshot, TeamTendency - all sourced from The Odds API/ESPN), so this
// keeps one canonical id<->name mapping to normalize against.

const MLB_TEAM_IDS: Record<string, number> = {
  Athletics: 133,
  "Pittsburgh Pirates": 134,
  "San Diego Padres": 135,
  "Seattle Mariners": 136,
  "San Francisco Giants": 137,
  "St. Louis Cardinals": 138,
  "Tampa Bay Rays": 139,
  "Texas Rangers": 140,
  "Toronto Blue Jays": 141,
  "Minnesota Twins": 142,
  "Philadelphia Phillies": 143,
  "Atlanta Braves": 144,
  "Chicago White Sox": 145,
  "Miami Marlins": 146,
  "New York Yankees": 147,
  "Milwaukee Brewers": 158,
  "Los Angeles Angels": 108,
  "Arizona Diamondbacks": 109,
  "Baltimore Orioles": 110,
  "Boston Red Sox": 111,
  "Chicago Cubs": 112,
  "Cincinnati Reds": 113,
  "Cleveland Guardians": 114,
  "Colorado Rockies": 115,
  "Detroit Tigers": 116,
  "Houston Astros": 117,
  "Kansas City Royals": 118,
  "Los Angeles Dodgers": 119,
  "Washington Nationals": 120,
  "New York Mets": 121,
};

export function mlbTeamId(teamName: string): number | null {
  return MLB_TEAM_IDS[teamName] ?? null;
}

const MLB_TEAM_NAMES_BY_ID: Record<number, string> = Object.fromEntries(
  Object.entries(MLB_TEAM_IDS).map(([name, id]) => [id, name])
);

// The canonical full team name this app uses everywhere else (GameResult,
// OddsSnapshot, TeamTendency - all sourced from The Odds API/ESPN, e.g.
// "Toronto Blue Jays"), keyed by MLB's own numeric team id. Needed because
// MLB Stats API's own endpoints (standings, team stats) return a shorter
// "club name" for the same team (e.g. "Blue Jays", "D-backs") - stat-
// snapshots.ts uses this to normalize captured rows to the one naming
// convention the rest of the app joins on, instead of silently storing a
// second, incompatible spelling per team.
export function mlbTeamNameById(id: number): string | null {
  return MLB_TEAM_NAMES_BY_ID[id] ?? null;
}

// Every active MLB team's canonical full name, alphabetical - backs the
// Charts workspace's entity selector (a fixed, known list, unlike pitchers
// which have no equivalent static catalog).
export function getAllMlbTeamNames(): string[] {
  return Object.keys(MLB_TEAM_IDS).sort();
}

export function currentMlbSeason(): number {
  return new Date().getFullYear();
}
