// Real per-team primary colors - a small color accent next to a team's name
// (the Live scoreboard bar, the /live game-card pick-list section headers)
// instead of a logo image: team colors are public brand facts, not
// copyrighted artwork, unlike the actual logo marks (see the removed
// team-logos.ts, which pulled real logo images from ESPN's CDN and was
// dropped for lack of licensing rights to display them).
//
// Matched by suffix against the full team string the odds/schedule sources
// return - same convention findTeamNickname/resolveGameForNickname use. The
// pro leagues key by bare nickname ("chiefs" ends "Kansas City Chiefs"); the
// NCAAF table keys by the full canonical school name, since bare college
// mascots collide across schools (see its own comment below).

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
  // "Action Green" (PMS 368 C), not "College Navy" #002244. Navy is listed
  // first in the Seahawks' official palette, but it is identical to the
  // Patriots' primary - two headers side by side rendered the same dark blue -
  // and green is how the team is actually identified.
  seahawks: "#69BE28",
  buccaneers: "#D50A0A",
  titans: "#4B92DB",
  commanders: "#5A1414",
};

const NBA_TEAM_COLORS: Record<string, string> = {
  hawks: "#E03A3E",
  celtics: "#007A33",
  nets: "#000000",
  hornets: "#1D1160",
  bulls: "#CE1141",
  cavaliers: "#860038",
  mavericks: "#00538C",
  nuggets: "#0E2240",
  pistons: "#C8102E",
  warriors: "#1D428A",
  rockets: "#CE1141",
  pacers: "#002D62",
  clippers: "#C8102E",
  lakers: "#552583",
  grizzlies: "#5D76A9",
  heat: "#98002E",
  bucks: "#00471B",
  timberwolves: "#0C2340",
  pelicans: "#0C2340",
  knicks: "#006BB6",
  thunder: "#007AC1",
  magic: "#0077C0",
  "76ers": "#006BB6",
  sixers: "#006BB6",
  suns: "#1D1160",
  "trail blazers": "#E03A3E",
  blazers: "#E03A3E",
  spurs: "#000000",
  raptors: "#CE1141",
  jazz: "#002B5C",
  wizards: "#002B5C",
};

// NHL - keyed by bare nickname like the other pro tables. "coyotes" and
// "mammoth" are the same franchise (Arizona -> Utah, 2024): "coyotes" keeps
// the final Arizona brick-red for picks that reference the old name;
// "mammoth" is the current Utah identity. Verified against teamcolorcodes.com
// (which lists each team's Pantone from the official style guide), cross-
// checked with ESPN's core color API; a few not on teamcolorcodes (Kraken,
// Mammoth, Golden Knights, Capitals) were verified against the team's brand
// release + a second aggregator. Where a team's official palette lists a dark
// color first but its identity reads as a brighter one (Wild, Senators,
// Capitals, Penguins), the PR notes the call.
export const NHL_TEAM_COLORS: Record<string, string> = {
  ducks: "#F47A38",
  coyotes: "#8C2633",
  bruins: "#FFB81C",
  sabres: "#003087",
  flames: "#D2001C",
  hurricanes: "#CE1126",
  blackhawks: "#CF0A2C",
  avalanche: "#6F263D",
  "blue jackets": "#002654",
  stars: "#006847",
  "red wings": "#CE1126",
  oilers: "#041E42",
  panthers: "#041E42",
  kings: "#111111",
  wild: "#154734",
  canadiens: "#AF1E2D",
  predators: "#FFB81C",
  devils: "#CE1126",
  islanders: "#00539B",
  rangers: "#0038A8",
  senators: "#DA1A32",
  flyers: "#F74902",
  penguins: "#000000",
  sharks: "#006D75",
  kraken: "#001628",
  blues: "#002F87",
  lightning: "#002868",
  "maple leafs": "#00205B",
  mammoth: "#000000",
  canucks: "#00205B",
  "golden knights": "#B4975A",
  capitals: "#C8102E",
  jets: "#041E42",
};

// WNBA (2026 season). Same verification. Portland Fire and Toronto Tempo -
// both 2026 expansion - are intentionally absent: neither has published hex
// values for its brand colors yet, and the team-color test allows that gap
// explicitly. They fall back to the neutral-gray dot until real values exist.
export const WNBA_TEAM_COLORS: Record<string, string> = {
  dream: "#C8102E",
  sky: "#418FDE",
  sun: "#DC4405",
  wings: "#0C2340",
  valkyries: "#AD96DC",
  fever: "#C8102E",
  aces: "#BA0C2F",
  sparks: "#702F8A",
  lynx: "#0C2340",
  liberty: "#6ECEB2",
  mercury: "#201747",
  storm: "#2C5234",
  mystics: "#C8102E",
};

// All 138 FBS schools (plus Tennessee State, an FCS money-game opponent) -
// exactly the canonical school-name set in NCAAF_SCHOOLS / NCAAF_CANONICAL_SUFFIX
// (parse-catalog.ts). Keyed by the FULL canonical name, not the bare mascot:
// college mascots collide heavily (five "Tigers", four "Bulldogs", three
// "Wildcats"...), so only the whole "<School> <Mascot>" string is unambiguous.
// team-colors-acceptance-test.ts asserts every key here is a real
// NCAAF_SCHOOLS canonical and that all of them are covered, so the two lists
// can't drift.
//
// Each value is the school's ACTUAL official primary brand color, verified
// against at least two independent brand sources (the Wikipedia
// "Module:College color/data" table, which cites each school's official
// identity guide; teamcolorcodes.com; and, where those disagreed, the
// school's own athletics/brand page). ESPN's team-color API was used only as
// an error-check, never as a source - it frequently returns a school's dark UI
// color rather than its brand primary. Where a school's identity is genuinely
// "<bright color> and black" the brand-primary value is used (e.g. Bowling
// Green orange, Miami orange); schools whose football identity really is black
// keep black (Iowa, Army, Vanderbilt, UCF...). See the PR for per-school
// source notes and the handful of judgment calls.
export const NCAAF_TEAM_COLORS: Record<string, string> = {
  "air force falcons": "#003594",
  "akron zips": "#041E42",
  "alabama crimson tide": "#9E1B32",
  "app state mountaineers": "#222222",
  "arizona state sun devils": "#8C1D40",
  "arizona wildcats": "#AB0520",
  "arkansas razorbacks": "#A41F35",
  "arkansas state red wolves": "#CC092F",
  "army black knights": "#000000",
  "auburn tigers": "#0C2340",
  "ball state cardinals": "#BA0C2F",
  "baylor bears": "#154734",
  "boise state broncos": "#0033A0",
  "boston college eagles": "#8C2232",
  "bowling green falcons": "#FE5000",
  "buffalo bulls": "#005BBB",
  "byu cougars": "#002E5D",
  "california golden bears": "#003262",
  "central michigan chippewas": "#6A0032",
  "charlotte 49ers": "#005035",
  "cincinnati bearcats": "#E00122",
  "clemson tigers": "#F56600",
  "coastal carolina chanticleers": "#006F71",
  "colorado buffaloes": "#000000",
  "colorado state rams": "#1E4D2B",
  "delaware blue hens": "#00539F",
  "duke blue devils": "#013088",
  "east carolina pirates": "#582C83",
  "eastern michigan eagles": "#046A38",
  "florida atlantic owls": "#003366",
  "florida gators": "#0021A5",
  "florida international panthers": "#081E3F",
  "florida state seminoles": "#782F40",
  "fresno state bulldogs": "#C41230",
  "georgia bulldogs": "#BA0C2F",
  "georgia southern eagles": "#041E42",
  "georgia state panthers": "#0039A6",
  "georgia tech yellow jackets": "#B39051",
  "hawai'i rainbow warriors": "#024731",
  "houston cougars": "#C8102E",
  "illinois fighting illini": "#13294B",
  "indiana hoosiers": "#990000",
  "iowa hawkeyes": "#000000",
  "iowa state cyclones": "#C8102E",
  "jacksonville state gamecocks": "#CC0000",
  "james madison dukes": "#450084",
  "kansas jayhawks": "#0051BA",
  "kansas state wildcats": "#512888",
  "kennesaw state owls": "#0B1315",
  "kent state golden flashes": "#002664",
  "kentucky wildcats": "#0033A0",
  "liberty flames": "#0A254E",
  "louisiana ragin' cajuns": "#CE181E",
  "louisiana tech bulldogs": "#003087",
  "louisville cardinals": "#C9001F",
  "lsu tigers": "#461D7C",
  "marshall thundering herd": "#00B140",
  "maryland terrapins": "#E21833",
  "massachusetts minutemen": "#971B2F",
  "memphis tigers": "#004991",
  "miami (oh) redhawks": "#B61E2E",
  "miami hurricanes": "#F47321",
  "michigan state spartans": "#173F35",
  "michigan wolverines": "#00274C",
  "middle tennessee blue raiders": "#0066CC",
  "minnesota golden gophers": "#7A0019",
  "mississippi state bulldogs": "#5D1725",
  "missouri state bears": "#5E0009",
  "missouri tigers": "#000000",
  "navy midshipmen": "#00225B",
  "nc state wolfpack": "#CC0000",
  "nebraska cornhuskers": "#E41C38",
  "nevada wolf pack": "#041E42",
  "new mexico lobos": "#BA0C2F",
  "new mexico state aggies": "#7E141B",
  "north carolina tar heels": "#7BAFD4",
  "north dakota state bison": "#00583D",
  "north texas mean green": "#00853E",
  "northern illinois huskies": "#BA0C2F",
  "northwestern wildcats": "#4E2A84",
  "notre dame fighting irish": "#0C2340",
  "ohio bobcats": "#00694E",
  "ohio state buckeyes": "#BA0C2F",
  "oklahoma sooners": "#841617",
  "oklahoma state cowboys": "#FE5C00",
  "old dominion monarchs": "#003767",
  "ole miss rebels": "#14213D",
  "oregon ducks": "#154733",
  "oregon state beavers": "#D73F09",
  "penn state nittany lions": "#001E44",
  "pittsburgh panthers": "#003594",
  "purdue boilermakers": "#000000",
  "rice owls": "#00205B",
  "rutgers scarlet knights": "#CC0033",
  "sacramento state hornets": "#043927",
  "sam houston bearkats": "#F56423",
  "san diego state aztecs": "#A6192E",
  "san josé state spartans": "#0038A8",
  "smu mustangs": "#C8102E",
  "south alabama jaguars": "#00205B",
  "south carolina gamecocks": "#73000A",
  "south florida bulls": "#006747",
  "southern miss golden eagles": "#000000",
  "stanford cardinal": "#8C1515",
  "syracuse orange": "#F76900",
  "tcu horned frogs": "#4D1979",
  "temple owls": "#9D2235",
  "tennessee state tigers": "#171796",
  "tennessee volunteers": "#FF8200",
  "texas a&m aggies": "#500000",
  "texas longhorns": "#BF5700",
  "texas state bobcats": "#501214",
  "texas tech red raiders": "#CC0000",
  "toledo rockets": "#0B2240",
  "troy trojans": "#862633",
  "tulane green wave": "#006548",
  "tulsa golden hurricane": "#003595",
  "uab blazers": "#1A5632",
  "ucf knights": "#000000",
  "ucla bruins": "#2774AE",
  "uconn huskies": "#000E2F",
  "ul monroe warhawks": "#860029",
  "unlv rebels": "#CF0A2C",
  "usc trojans": "#9D2235",
  "utah state aggies": "#00263A",
  "utah utes": "#BE0000",
  "utep miners": "#041E42",
  "utsa roadrunners": "#0B2240",
  "vanderbilt commodores": "#000000",
  "virginia cavaliers": "#232D4B",
  "virginia tech hokies": "#861F41",
  "wake forest demon deacons": "#2C2A29",
  "washington huskies": "#4B2E83",
  "washington state cougars": "#981E32",
  "west virginia mountaineers": "#002855",
  "western kentucky hilltoppers": "#C60C30",
  "western michigan broncos": "#532E1F",
  "wisconsin badgers": "#C5050C",
  "wyoming cowboys": "#492F24",
};

export function getTeamColor(sportKey: string, teamName: string): string | null {
  const table =
    sportKey === "baseball_mlb"
      ? MLB_TEAM_COLORS
      : sportKey === "americanfootball_nfl"
        ? NFL_TEAM_COLORS
        : sportKey === "basketball_nba"
          ? NBA_TEAM_COLORS
          : sportKey === "americanfootball_ncaaf"
            ? NCAAF_TEAM_COLORS
            : sportKey === "icehockey_nhl"
              ? NHL_TEAM_COLORS
              : sportKey === "basketball_wnba"
                ? WNBA_TEAM_COLORS
                : null;
  if (!table) return null;

  const lower = teamName.toLowerCase();
  for (const [nickname, hex] of Object.entries(table)) {
    if (lower.endsWith(nickname)) return hex;
  }
  return null;
}
