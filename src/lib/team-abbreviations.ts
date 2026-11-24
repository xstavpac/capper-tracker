// Display-only short names for pro teams ("Green Bay Packers" -> "GB"), for compact labels such as the review queue's
// candidate buttons. Never used to match anything: a team not listed here (college, KBO, CFL, a renamed franchise)
// is simply shown by its full name.

const TABLE: Record<string, string> = {
  // NFL
  "Arizona Cardinals": "ARI", "Atlanta Falcons": "ATL", "Baltimore Ravens": "BAL", "Buffalo Bills": "BUF", "Carolina Panthers": "CAR",
  "Chicago Bears": "CHI", "Cincinnati Bengals": "CIN", "Cleveland Browns": "CLE", "Dallas Cowboys": "DAL", "Denver Broncos": "DEN",
  "Detroit Lions": "DET", "Green Bay Packers": "GB", "Houston Texans": "HOU", "Indianapolis Colts": "IND", "Jacksonville Jaguars": "JAX",
  "Kansas City Chiefs": "KC", "Las Vegas Raiders": "LV", "Los Angeles Chargers": "LAC", "Los Angeles Rams": "LAR", "Miami Dolphins": "MIA",
  "Minnesota Vikings": "MIN", "New England Patriots": "NE", "New Orleans Saints": "NO", "New York Giants": "NYG", "New York Jets": "NYJ",
  "Philadelphia Eagles": "PHI", "Pittsburgh Steelers": "PIT", "San Francisco 49ers": "SF", "Seattle Seahawks": "SEA",
  "Tampa Bay Buccaneers": "TB", "Tennessee Titans": "TEN", "Washington Commanders": "WSH",
  // NBA
  "Atlanta Hawks": "ATL", "Boston Celtics": "BOS", "Brooklyn Nets": "BKN", "Charlotte Hornets": "CHA", "Chicago Bulls": "CHI",
  "Cleveland Cavaliers": "CLE", "Dallas Mavericks": "DAL", "Denver Nuggets": "DEN", "Detroit Pistons": "DET", "Golden State Warriors": "GS",
  "Houston Rockets": "HOU", "Indiana Pacers": "IND", "LA Clippers": "LAC", "Los Angeles Clippers": "LAC", "Los Angeles Lakers": "LAL",
  "Memphis Grizzlies": "MEM", "Miami Heat": "MIA", "Milwaukee Bucks": "MIL", "Minnesota Timberwolves": "MIN", "New Orleans Pelicans": "NO",
  "New York Knicks": "NY", "Oklahoma City Thunder": "OKC", "Orlando Magic": "ORL", "Philadelphia 76ers": "PHI", "Phoenix Suns": "PHX",
  "Portland Trail Blazers": "POR", "Sacramento Kings": "SAC", "San Antonio Spurs": "SA", "Toronto Raptors": "TOR", "Utah Jazz": "UTA",
  "Washington Wizards": "WSH",
  // NHL
  "Anaheim Ducks": "ANA", "Boston Bruins": "BOS", "Buffalo Sabres": "BUF", "Calgary Flames": "CGY", "Carolina Hurricanes": "CAR",
  "Chicago Blackhawks": "CHI", "Colorado Avalanche": "COL", "Columbus Blue Jackets": "CBJ", "Dallas Stars": "DAL", "Detroit Red Wings": "DET",
  "Edmonton Oilers": "EDM", "Florida Panthers": "FLA", "Los Angeles Kings": "LA", "Minnesota Wild": "MIN", "Montreal Canadiens": "MTL",
  "Nashville Predators": "NSH", "New Jersey Devils": "NJ", "New York Islanders": "NYI", "New York Rangers": "NYR", "Ottawa Senators": "OTT",
  "Philadelphia Flyers": "PHI", "Pittsburgh Penguins": "PIT", "San Jose Sharks": "SJ", "Seattle Kraken": "SEA", "St Louis Blues": "STL",
  "Tampa Bay Lightning": "TB", "Toronto Maple Leafs": "TOR", "Utah Hockey Club": "UTAH", "Utah Mammoth": "UTAH", "Vancouver Canucks": "VAN",
  "Vegas Golden Knights": "VGK", "Washington Capitals": "WSH", "Winnipeg Jets": "WPG",
  // MLB
  "Arizona Diamondbacks": "ARI", "Atlanta Braves": "ATL", "Baltimore Orioles": "BAL", "Boston Red Sox": "BOS", "Chicago Cubs": "CHC",
  "Chicago White Sox": "CHW", "Cincinnati Reds": "CIN", "Cleveland Guardians": "CLE", "Colorado Rockies": "COL", "Detroit Tigers": "DET",
  "Houston Astros": "HOU", "Kansas City Royals": "KC", "Los Angeles Angels": "LAA", "Los Angeles Dodgers": "LAD", "Miami Marlins": "MIA",
  "Milwaukee Brewers": "MIL", "Minnesota Twins": "MIN", "New York Mets": "NYM", "New York Yankees": "NYY", "Athletics": "ATH",
  "Oakland Athletics": "ATH", "Philadelphia Phillies": "PHI", "Pittsburgh Pirates": "PIT", "San Diego Padres": "SD", "San Francisco Giants": "SF",
  "Seattle Mariners": "SEA", "St Louis Cardinals": "STL", "Tampa Bay Rays": "TB", "Texas Rangers": "TEX", "Toronto Blue Jays": "TOR",
  "Washington Nationals": "WSH",
  // WNBA
  "Atlanta Dream": "ATL", "Chicago Sky": "CHI", "Connecticut Sun": "CON", "Dallas Wings": "DAL", "Golden State Valkyries": "GSV",
  "Indiana Fever": "IND", "Las Vegas Aces": "LV", "Los Angeles Sparks": "LA", "Minnesota Lynx": "MIN", "New York Liberty": "NY",
  "Phoenix Mercury": "PHX", "Seattle Storm": "SEA", "Washington Mystics": "WSH", "Toronto Tempo": "TOR", "Portland Fire": "POR",
};

// Accents folded, "St." == "St", case and spacing ignored: the score feed and the odds feed spell a few teams differently.
function key(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Built per league-agnostic name: a name that two leagues share (none today) would keep the first entry.
const LOOKUP = new Map<string, string>();
for (const [name, abbr] of Object.entries(TABLE)) if (!LOOKUP.has(key(name))) LOOKUP.set(key(name), abbr);

/** The team's short name when it is a listed pro team, else the name exactly as given. */
export function teamShortName(name: string): string {
  return LOOKUP.get(key(name)) ?? name;
}
