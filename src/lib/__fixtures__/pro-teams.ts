// Every pro team as the score feed (ESPN) names it: [league, full name, the
// city forms a capper writes in front of the nickname, nickname]. Typed out
// here, not derived from parse-catalog's tables, so the audit checks them.
export type ProTeam = [string, string, string[], string];
const t = (lg: string, name: string, nick: string, extra: string[] = []): ProTeam => {
  const city = name.slice(0, name.length - nick.length).trim();
  return [lg, name, [...(city ? [city] : []), ...extra], nick];
};
export const PRO_TEAMS: ProTeam[] = [
  // NFL
  t("NFL", "Arizona Cardinals", "Cardinals", ["ARI", "AZ"]), t("NFL", "Atlanta Falcons", "Falcons", ["ATL"]), t("NFL", "Baltimore Ravens", "Ravens", ["BAL"]),
  t("NFL", "Buffalo Bills", "Bills", ["BUF"]), t("NFL", "Carolina Panthers", "Panthers", ["CAR"]), t("NFL", "Chicago Bears", "Bears", ["CHI"]),
  t("NFL", "Cincinnati Bengals", "Bengals", ["CIN", "Cincy"]), t("NFL", "Cleveland Browns", "Browns", ["CLE"]), t("NFL", "Dallas Cowboys", "Cowboys", ["DAL"]),
  t("NFL", "Denver Broncos", "Broncos", ["DEN"]), t("NFL", "Detroit Lions", "Lions", ["DET"]), t("NFL", "Green Bay Packers", "Packers", ["GB"]),
  t("NFL", "Houston Texans", "Texans", ["HOU"]), t("NFL", "Indianapolis Colts", "Colts", ["IND", "Indy"]), t("NFL", "Jacksonville Jaguars", "Jaguars", ["JAX"]),
  t("NFL", "Kansas City Chiefs", "Chiefs", ["KC"]), t("NFL", "Las Vegas Raiders", "Raiders", ["Vegas", "LV"]), t("NFL", "Los Angeles Chargers", "Chargers", ["LA"]),
  t("NFL", "Los Angeles Rams", "Rams", ["LA"]), t("NFL", "Miami Dolphins", "Dolphins", ["MIA"]), t("NFL", "Minnesota Vikings", "Vikings", ["MIN", "Minny"]),
  t("NFL", "New England Patriots", "Patriots", ["NE"]), t("NFL", "New Orleans Saints", "Saints", ["NOLA", "NO"]), t("NFL", "New York Giants", "Giants", ["NY"]),
  t("NFL", "New York Jets", "Jets", ["NY"]), t("NFL", "Philadelphia Eagles", "Eagles", ["Philly", "PHI"]), t("NFL", "Pittsburgh Steelers", "Steelers", ["PIT"]),
  t("NFL", "San Francisco 49ers", "49ers", ["SF", "San Fran"]), t("NFL", "Seattle Seahawks", "Seahawks", ["SEA"]), t("NFL", "Tampa Bay Buccaneers", "Buccaneers", ["Tampa", "TB"]),
  t("NFL", "Tennessee Titans", "Titans", ["TEN"]), t("NFL", "Washington Commanders", "Commanders", ["WAS", "DC"]),
  // NBA
  t("NBA", "Atlanta Hawks", "Hawks", ["ATL"]), t("NBA", "Boston Celtics", "Celtics", ["BOS"]), t("NBA", "Brooklyn Nets", "Nets", ["BKN"]),
  t("NBA", "Charlotte Hornets", "Hornets", ["CHA"]), t("NBA", "Chicago Bulls", "Bulls", ["CHI"]), t("NBA", "Cleveland Cavaliers", "Cavaliers", ["CLE"]),
  t("NBA", "Dallas Mavericks", "Mavericks", ["DAL"]), t("NBA", "Denver Nuggets", "Nuggets", ["DEN"]), t("NBA", "Detroit Pistons", "Pistons", ["DET"]),
  t("NBA", "Golden State Warriors", "Warriors", ["GS"]), t("NBA", "Houston Rockets", "Rockets", ["HOU"]), t("NBA", "Indiana Pacers", "Pacers", ["IND", "Indy"]),
  t("NBA", "LA Clippers", "Clippers", ["Los Angeles"]), t("NBA", "Los Angeles Lakers", "Lakers", ["LA"]), t("NBA", "Memphis Grizzlies", "Grizzlies", ["MEM"]),
  t("NBA", "Miami Heat", "Heat", ["MIA"]), t("NBA", "Milwaukee Bucks", "Bucks", ["MIL"]), t("NBA", "Minnesota Timberwolves", "Timberwolves", ["MIN", "Minny"]),
  t("NBA", "New Orleans Pelicans", "Pelicans", ["NOLA", "NO"]), t("NBA", "New York Knicks", "Knicks", ["NY"]), t("NBA", "Oklahoma City Thunder", "Thunder", ["OKC"]),
  t("NBA", "Orlando Magic", "Magic", ["ORL"]), t("NBA", "Philadelphia 76ers", "76ers", ["Philly", "PHI"]), t("NBA", "Phoenix Suns", "Suns", ["PHX"]),
  t("NBA", "Portland Trail Blazers", "Trail Blazers", ["POR"]), t("NBA", "Sacramento Kings", "Kings", ["SAC"]), t("NBA", "San Antonio Spurs", "Spurs", ["SA"]),
  t("NBA", "Toronto Raptors", "Raptors", ["TOR"]), t("NBA", "Utah Jazz", "Jazz", []), t("NBA", "Washington Wizards", "Wizards", ["WAS", "DC"]),
  // NHL
  t("NHL", "Anaheim Ducks", "Ducks", ["ANA"]), t("NHL", "Boston Bruins", "Bruins", ["BOS"]), t("NHL", "Buffalo Sabres", "Sabres", ["BUF"]),
  t("NHL", "Calgary Flames", "Flames", ["CGY"]), t("NHL", "Carolina Hurricanes", "Hurricanes", ["CAR"]), t("NHL", "Chicago Blackhawks", "Blackhawks", ["CHI"]),
  t("NHL", "Colorado Avalanche", "Avalanche", ["COL"]), t("NHL", "Columbus Blue Jackets", "Blue Jackets", ["CBJ"]), t("NHL", "Dallas Stars", "Stars", ["DAL"]),
  t("NHL", "Detroit Red Wings", "Red Wings", ["DET"]), t("NHL", "Edmonton Oilers", "Oilers", ["EDM"]), t("NHL", "Florida Panthers", "Panthers", ["FLA"]),
  t("NHL", "Los Angeles Kings", "Kings", ["LA"]), t("NHL", "Minnesota Wild", "Wild", ["MIN", "Minny"]), t("NHL", "Montreal Canadiens", "Canadiens", ["MTL"]),
  t("NHL", "Nashville Predators", "Predators", ["NSH"]), t("NHL", "New Jersey Devils", "Devils", ["NJ"]), t("NHL", "New York Islanders", "Islanders", ["NY"]),
  t("NHL", "New York Rangers", "Rangers", ["NY"]), t("NHL", "Ottawa Senators", "Senators", ["OTT"]), t("NHL", "Philadelphia Flyers", "Flyers", ["Philly", "PHI"]),
  t("NHL", "Pittsburgh Penguins", "Penguins", ["PIT"]), t("NHL", "San Jose Sharks", "Sharks", ["SJ"]), t("NHL", "Seattle Kraken", "Kraken", ["SEA"]),
  t("NHL", "St. Louis Blues", "Blues", ["St Louis", "STL"]), t("NHL", "Tampa Bay Lightning", "Lightning", ["Tampa", "TB"]), t("NHL", "Toronto Maple Leafs", "Maple Leafs", ["TOR"]),
  t("NHL", "Utah Mammoth", "Mammoth", []), t("NHL", "Vancouver Canucks", "Canucks", ["VAN"]), t("NHL", "Vegas Golden Knights", "Golden Knights", ["Las Vegas", "LV"]),
  t("NHL", "Washington Capitals", "Capitals", ["WAS", "DC"]), t("NHL", "Winnipeg Jets", "Jets", ["WPG"]),
  // MLB
  t("MLB", "Arizona Diamondbacks", "Diamondbacks", ["ARI", "AZ"]), t("MLB", "Athletics", "Athletics", ["Oakland", "Sacramento"]), t("MLB", "Atlanta Braves", "Braves", ["ATL"]),
  t("MLB", "Baltimore Orioles", "Orioles", ["BAL"]), t("MLB", "Boston Red Sox", "Red Sox", ["BOS"]), t("MLB", "Chicago Cubs", "Cubs", ["CHI"]),
  t("MLB", "Chicago White Sox", "White Sox", ["CHI"]), t("MLB", "Cincinnati Reds", "Reds", ["CIN", "Cincy"]), t("MLB", "Cleveland Guardians", "Guardians", ["CLE"]),
  t("MLB", "Colorado Rockies", "Rockies", ["COL"]), t("MLB", "Detroit Tigers", "Tigers", ["DET"]), t("MLB", "Houston Astros", "Astros", ["HOU"]),
  t("MLB", "Kansas City Royals", "Royals", ["KC"]), t("MLB", "Los Angeles Angels", "Angels", ["LA"]), t("MLB", "Los Angeles Dodgers", "Dodgers", ["LA"]),
  t("MLB", "Miami Marlins", "Marlins", ["MIA"]), t("MLB", "Milwaukee Brewers", "Brewers", ["MIL"]), t("MLB", "Minnesota Twins", "Twins", ["MIN", "Minny"]),
  t("MLB", "New York Mets", "Mets", ["NY"]), t("MLB", "New York Yankees", "Yankees", ["NY"]), t("MLB", "Philadelphia Phillies", "Phillies", ["Philly", "PHI"]),
  t("MLB", "Pittsburgh Pirates", "Pirates", ["PIT"]), t("MLB", "San Diego Padres", "Padres", ["SD"]), t("MLB", "San Francisco Giants", "Giants", ["SF", "San Fran"]),
  t("MLB", "Seattle Mariners", "Mariners", ["SEA"]), t("MLB", "St. Louis Cardinals", "Cardinals", ["St Louis", "STL"]), t("MLB", "Tampa Bay Rays", "Rays", ["Tampa", "TB"]),
  t("MLB", "Texas Rangers", "Rangers", ["TEX"]), t("MLB", "Toronto Blue Jays", "Blue Jays", ["TOR"]), t("MLB", "Washington Nationals", "Nationals", ["WAS", "DC"]),
  // WNBA
  t("WNBA", "Atlanta Dream", "Dream", ["ATL"]), t("WNBA", "Chicago Sky", "Sky", ["CHI"]), t("WNBA", "Connecticut Sun", "Sun", ["CONN"]),
  t("WNBA", "Dallas Wings", "Wings", ["DAL"]), t("WNBA", "Golden State Valkyries", "Valkyries", ["GS"]), t("WNBA", "Indiana Fever", "Fever", ["IND", "Indy"]),
  t("WNBA", "Las Vegas Aces", "Aces", ["Vegas", "LV"]), t("WNBA", "Los Angeles Sparks", "Sparks", ["LA"]), t("WNBA", "Minnesota Lynx", "Lynx", ["MIN", "Minny"]),
  t("WNBA", "New York Liberty", "Liberty", ["NY"]), t("WNBA", "Phoenix Mercury", "Mercury", ["PHX"]), t("WNBA", "Portland Fire", "Fire", ["POR"]),
  t("WNBA", "Seattle Storm", "Storm", ["SEA"]), t("WNBA", "Toronto Tempo", "Tempo", ["TOR"]), t("WNBA", "Washington Mystics", "Mystics", ["WAS", "DC"]),
];
