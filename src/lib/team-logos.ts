// The Odds API's game/odds response has no branding assets, just team names
// and lines - ESPN's team-logo CDN is free/unauthenticated (same "no API
// key" pattern already used for NBA/WNBA live scores in server/data/odds.ts),
// so team names get mapped by hand to ESPN's own abbreviation scheme.
//
// Only MLB is mapped for now (the current ask) - a future sport just needs
// its own nickname->abbreviation table added here and a branch below.
const MLB_ESPN_ABBR: Record<string, string> = {
  diamondbacks: "ari",
  braves: "atl",
  orioles: "bal",
  "red sox": "bos",
  cubs: "chc",
  "white sox": "cws",
  reds: "cin",
  guardians: "cle",
  rockies: "col",
  tigers: "det",
  astros: "hou",
  royals: "kc",
  angels: "laa",
  dodgers: "lad",
  marlins: "mia",
  brewers: "mil",
  twins: "min",
  mets: "nym",
  yankees: "nyy",
  athletics: "ath",
  phillies: "phi",
  pirates: "pit",
  padres: "sd",
  giants: "sf",
  mariners: "sea",
  cardinals: "stl",
  rays: "tb",
  rangers: "tex",
  "blue jays": "tor",
  nationals: "wsh",
};

// `teamName` is the full "City Nickname" string The Odds API returns (e.g.
// "New York Yankees") - matched by nickname suffix, same convention
// findTeamNickname/resolveGameForNickname already use elsewhere for this data.
export function getTeamLogoUrl(sportKey: string, teamName: string): string | null {
  if (sportKey !== "baseball_mlb") return null;

  const lower = teamName.toLowerCase();
  for (const [nickname, abbr] of Object.entries(MLB_ESPN_ABBR)) {
    if (lower.endsWith(nickname)) {
      return "https://a.espncdn.com/i/teamlogos/mlb/500/" + abbr + ".png";
    }
  }
  return null;
}
