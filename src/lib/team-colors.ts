// Real per-team primary colors, used as a small color bar next to each
// team's name on the Live scoreboard instead of a logo image - team colors
// are public brand facts, not copyrighted artwork, unlike the actual logo
// marks (see the removed team-logos.ts, which pulled real logo images from
// ESPN's CDN and was dropped for lack of licensing rights to display them).
//
// Matched by nickname suffix against the full "City Nickname" string the
// odds/schedule sources return (e.g. "Kansas City Chiefs") - same convention
// findTeamNickname/resolveGameForNickname use elsewhere for this data.

const MLB_TEAM_COLORS: Record<string, string> = {
  diamondbacks: "#A71930",
  braves: "#CE1141",
  orioles: "#DF4601",
  "red sox": "#BD3039",
  cubs: "#0E3386",
  "white sox": "#27251F",
  reds: "#C6011F",
  guardians: "#E31937",
  rockies: "#33006F",
  tigers: "#0C2340",
  astros: "#EB6E1F",
  royals: "#004687",
  angels: "#BA0021",
  dodgers: "#005A9C",
  marlins: "#00A3E0",
  brewers: "#12284B",
  twins: "#002B5C",
  mets: "#002D72",
  yankees: "#003087",
  athletics: "#003831",
  phillies: "#E81828",
  pirates: "#FDB827",
  padres: "#2F241D",
  giants: "#FD5A1E",
  mariners: "#0C2C56",
  cardinals: "#C41E3A",
  rays: "#092C5C",
  rangers: "#003278",
  "blue jays": "#134A8E",
  nationals: "#AB0003",
};

const NFL_TEAM_COLORS: Record<string, string> = {
  cardinals: "#97233F",
  falcons: "#A71930",
  ravens: "#241773",
  bills: "#00338D",
  panthers: "#0085CA",
  bears: "#0B162A",
  bengals: "#FB4F14",
  browns: "#311D00",
  cowboys: "#003594",
  broncos: "#FB4F14",
  lions: "#0076B6",
  packers: "#203731",
  texans: "#03202F",
  colts: "#002C5F",
  jaguars: "#101820",
  chiefs: "#E31837",
  raiders: "#000000",
  chargers: "#0080C6",
  rams: "#003594",
  dolphins: "#008E97",
  vikings: "#4F2683",
  patriots: "#002244",
  saints: "#D3BC8D",
  giants: "#0B2265",
  jets: "#125740",
  eagles: "#004C54",
  steelers: "#FFB612",
  "49ers": "#AA0000",
  seahawks: "#002244",
  buccaneers: "#D50A0A",
  titans: "#4B92DB",
  commanders: "#5A1414",
};

export function getTeamColor(sportKey: string, teamName: string): string | null {
  const table = sportKey === "baseball_mlb" ? MLB_TEAM_COLORS : sportKey === "americanfootball_nfl" ? NFL_TEAM_COLORS : null;
  if (!table) return null;

  const lower = teamName.toLowerCase();
  for (const [nickname, hex] of Object.entries(table)) {
    if (lower.endsWith(nickname)) return hex;
  }
  return null;
}
