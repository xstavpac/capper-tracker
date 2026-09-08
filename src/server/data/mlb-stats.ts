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

// Stat-feed team abbreviation -> the canonical full name above. The MLB
// analog of nfl-team-stats.ts's NFL_TEAM_NAMES_BY_ABBR: a user-uploaded
// Charts CSV (Baseball Savant, ESPN, Baseball-Reference exports) keys teams
// by a 2-3 letter code, not the full "City Nickname" the Charts team
// selector and every snapshot table use.
//
// Multiple codes map to one team on purpose - the feeds disagree: Baseball
// Savant's own `home_team` field writes "AZ" / "ATH" / "CWS" / "WSH" where
// Baseball-Reference writes "ARI" / "OAK" / "CHW" / "WSN", and Retrosheet
// adds a third set ("CHN", "SLN", "NYA"). All the common spellings are
// accepted; each resolves to exactly one team.
//
// Genuinely ambiguous bare codes are deliberately absent (no entry, so
// resolution returns null and the importer asks the user rather than
// guessing): "LA" (Angels vs Dodgers), "NY" (Yankees vs Mets), "CHI"/"CH"
// (Cubs vs White Sox), "SOX", "SD"/"SF" are fine (one team each) but "STL"
// is the Cardinals only. Keep this list curated the same way MLB_TEAM_IDS
// is - add a code only when it's confirmed in a real export and collides
// with nothing.
const MLB_TEAM_NAME_BY_CODE: Record<string, string> = {
  AZ: "Arizona Diamondbacks", ARI: "Arizona Diamondbacks", AZD: "Arizona Diamondbacks",
  ATH: "Athletics", OAK: "Athletics", ATHL: "Athletics",
  ATL: "Atlanta Braves",
  BAL: "Baltimore Orioles",
  BOS: "Boston Red Sox",
  CHC: "Chicago Cubs", CHN: "Chicago Cubs",
  CWS: "Chicago White Sox", CHW: "Chicago White Sox", CHA: "Chicago White Sox",
  CIN: "Cincinnati Reds",
  CLE: "Cleveland Guardians",
  COL: "Colorado Rockies",
  DET: "Detroit Tigers",
  HOU: "Houston Astros",
  KC: "Kansas City Royals", KCR: "Kansas City Royals", KCA: "Kansas City Royals",
  LAA: "Los Angeles Angels", ANA: "Los Angeles Angels",
  LAD: "Los Angeles Dodgers", LAN: "Los Angeles Dodgers",
  MIA: "Miami Marlins", FLA: "Miami Marlins",
  MIL: "Milwaukee Brewers",
  MIN: "Minnesota Twins",
  NYM: "New York Mets", NYN: "New York Mets",
  NYY: "New York Yankees", NYA: "New York Yankees",
  PHI: "Philadelphia Phillies",
  PIT: "Pittsburgh Pirates",
  SD: "San Diego Padres", SDP: "San Diego Padres", SDN: "San Diego Padres",
  SF: "San Francisco Giants", SFG: "San Francisco Giants", SFN: "San Francisco Giants",
  SEA: "Seattle Mariners",
  STL: "St. Louis Cardinals", SLN: "St. Louis Cardinals",
  TB: "Tampa Bay Rays", TBR: "Tampa Bay Rays", TBA: "Tampa Bay Rays", TBD: "Tampa Bay Rays",
  TEX: "Texas Rangers",
  TOR: "Toronto Blue Jays",
  WSH: "Washington Nationals", WSN: "Washington Nationals", WAS: "Washington Nationals",
};

// Fold case, accents and "St."/"St" so a full name that differs only
// cosmetically ("st louis cardinals", "ST. LOUIS CARDINALS") still matches.
// Kept local rather than importing lib/team-name-match.ts so this module
// stays dependency-free (same reason nfl-team-stats.ts only pulls in dates).
function foldName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const MLB_CANONICAL_BY_FOLDED: Record<string, string> = Object.fromEntries(
  Object.keys(MLB_TEAM_IDS).map((name) => [foldName(name), name])
);

// A team identifier from an uploaded CSV -> the canonical full MLB name, or
// null if it can't be resolved unambiguously. Tries, in order: exact
// canonical name, cosmetic fold (case/accent/"St."), then the abbreviation
// map above.
export function normalizeMlbTeamName(input: string): string | null {
  const raw = input.trim();
  if (raw === "") return null;
  if (MLB_TEAM_IDS[raw] !== undefined) return raw;
  const folded = MLB_CANONICAL_BY_FOLDED[foldName(raw)];
  if (folded) return folded;
  return MLB_TEAM_NAME_BY_CODE[raw.toUpperCase()] ?? null;
}

export function currentMlbSeason(): number {
  return new Date().getFullYear();
}
