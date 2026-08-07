export type ParsedPick = {
  capperName: string;
  sportName: string;
  description: string;
  betType: "SPREAD" | "MONEYLINE" | "TOTAL" | "PLAYER_PROP";
  odds: number;
  hasExplicitOdds: boolean;
  totalSide?: "over" | "under";
  units: number;
  isFirstFive: boolean;
  raw: string;
  ambiguous?: string[];
};

type TeamEntry = [string, string];

const KNOWN_SPORTS = [
  "WNBA", "NCAAF", "NCAAB", "MLB", "NBA", "NHL", "NFL", "MLS", "UFC", "MMA",
  "PGA", "ATP", "WTA", "EPL", "LA LIGA", "SERIE A", "BUNDESLIGA", "LIGUE 1",
  "CHAMPIONS LEAGUE",
];

const MLB_TEAMS = [
  "diamondbacks", "braves", "orioles", "red sox", "cubs", "white sox", "reds",
  "guardians", "rockies", "tigers", "astros", "royals", "angels", "dodgers",
  "marlins", "brewers", "twins", "mets", "yankees", "athletics", "phillies",
  "pirates", "padres", "mariners", "cardinals", "rays", "blue jays", "nationals",
];

const NBA_TEAMS = [
  "hawks", "celtics", "nets", "hornets", "bulls", "cavaliers", "mavericks",
  "nuggets", "pistons", "warriors", "rockets", "pacers", "clippers", "lakers",
  "grizzlies", "heat", "bucks", "timberwolves", "pelicans", "knicks", "thunder",
  "magic", "76ers", "sixers", "suns", "trail blazers", "blazers", "spurs",
  "raptors", "jazz", "wizards",
];

const NFL_TEAMS = [
  "falcons", "ravens", "bills", "panthers", "bears", "bengals", "browns",
  "cowboys", "broncos", "lions", "packers", "texans", "colts", "jaguars",
  "chiefs", "raiders", "chargers", "rams", "dolphins", "vikings", "patriots",
  "saints", "jets", "eagles", "steelers", "49ers", "niners", "seahawks",
  "buccaneers", "titans", "commanders",
];

const NHL_TEAMS = [
  "ducks", "coyotes", "bruins", "sabres", "flames", "hurricanes", "blackhawks",
  "avalanche", "blue jackets", "stars", "red wings", "oilers", "wild",
  "canadiens", "predators", "devils", "islanders", "senators", "flyers",
  "penguins", "sharks", "kraken", "blues", "lightning", "maple leafs",
  "canucks", "golden knights", "capitals", "jets",
];

const WNBA_TEAMS = [
  "dream", "sky", "sun", "fever", "aces", "mercury", "lynx", "liberty",
  "valkyries", "wings", "mystics", "storm",
];

const AMBIGUOUS_NICKNAMES: Record<string, string[]> = {
  cardinals: ["St. Louis Cardinals (MLB)", "Arizona Cardinals (NFL)"],
  rangers: ["Texas Rangers (MLB)", "New York Rangers (NHL)"],
  kings: ["Sacramento Kings (NBA)", "Los Angeles Kings (NHL)"],
  panthers: ["Carolina Panthers (NFL)", "Florida Panthers (NHL)"],
  giants: ["San Francisco Giants (MLB)", "New York Giants (NFL)"],
};

const DISAMBIGUATED_TEAMS: TeamEntry[] = [
  ["texas rangers", "MLB"],
  ["new york rangers", "NHL"],
  ["ny rangers", "NHL"],
  ["sacramento kings", "NBA"],
  ["los angeles kings", "NHL"],
  ["la kings", "NHL"],
  ["st louis cardinals", "MLB"],
  ["st. louis cardinals", "MLB"],
  ["arizona cardinals", "NFL"],
  ["carolina panthers", "NFL"],
  ["florida panthers", "NHL"],
  ["san francisco giants", "MLB"],
  ["sf giants", "MLB"],
  ["new york giants", "NFL"],
  ["ny giants", "NFL"],
];

const TEAM_SPORT_ENTRIES: TeamEntry[] = [
  ...DISAMBIGUATED_TEAMS,
  ...MLB_TEAMS.map((t): TeamEntry => [t, "MLB"]),
  ...NBA_TEAMS.map((t): TeamEntry => [t, "NBA"]),
  ...NFL_TEAMS.map((t): TeamEntry => [t, "NFL"]),
  ...NHL_TEAMS.map((t): TeamEntry => [t, "NHL"]),
  ...WNBA_TEAMS.map((t): TeamEntry => [t, "WNBA"]),
].sort((a, b) => b[0].length - a[0].length);

function detectSport(text: string): { sportName: string; rest: string } {
  for (const code of KNOWN_SPORTS) {
    const re = new RegExp("\\b" + code.replace(/ /g, "\\s+") + "\\b", "i");
    const match = text.match(re);
    if (match && match.index !== undefined) {
      const rest = text.slice(match.index + match[0].length).replace(/^[:\s]+/, "");
      return { sportName: code, rest };
    }
  }

  const lower = text.toLowerCase();
  for (const entry of TEAM_SPORT_ENTRIES) {
    const phrase = entry[0];
    const sport = entry[1];
    const re = new RegExp("\\b" + phrase.replace(/ /g, "\\s+") + "\\b", "i");
    if (re.test(lower)) {
      return { sportName: sport, rest: text };
    }
  }

  return { sportName: "", rest: text };
}

function parsePickText(description: string): {
  betType: ParsedPick["betType"];
  odds: number | null;
  units: number;
  isFirstFive: boolean;
  cleanDescription: string;
  totalSide?: "over" | "under";
} {
  let odds: number | null = null;
  let units: number | null = null;
  const parens = [...description.matchAll(/\(([^)]+)\)/g)];
  for (const p of parens) {
    const val = p[1].trim();
    if (/u$/i.test(val)) {
      units = parseFloat(val);
    } else if (/^[+-]?\d+$/.test(val)) {
      odds = parseInt(val, 10);
    }
  }

  const cleanDescription = description.replace(/\([^)]*\)/g, "").trim();
  const isFirstFive = /\bF5\b/i.test(cleanDescription) || /1st\s*5/i.test(cleanDescription);

  let betType: ParsedPick["betType"] = "SPREAD";
  let totalSide: "over" | "under" | undefined;
  if (/\bML\b/i.test(cleanDescription) || /moneyline/i.test(cleanDescription)) {
    betType = "MONEYLINE";
  } else if (/\bover\b/i.test(cleanDescription)) {
    betType = "TOTAL";
    totalSide = "over";
  } else if (/\bunder\b/i.test(cleanDescription)) {
    betType = "TOTAL";
    totalSide = "under";
  } else if (/\btotal\b/i.test(cleanDescription)) {
    betType = "TOTAL";
  }

  return { betType, odds, units: units ?? 1, isFirstFive, cleanDescription, totalSide };
}

function findAmbiguousNickname(text: string): string[] | undefined {
  const lower = text.toLowerCase();
  for (const [nickname, options] of Object.entries(AMBIGUOUS_NICKNAMES)) {
    const re = new RegExp("\\b" + nickname + "\\b", "i");
    if (re.test(lower)) return options;
  }
  return undefined;
}

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function findTeamNickname(text: string, sportName: string): string | undefined {
  const lower = text.toLowerCase();
  for (const [phrase, sport] of TEAM_SPORT_ENTRIES) {
    if (sport !== sportName) continue;
    const re = new RegExp("\\b" + phrase.replace(/ /g, "\\s+") + "\\b", "i");
    if (re.test(lower)) return phrase;
  }
  return undefined;
}

export function parseCatalog(text: string, knownCapperNames: string[] = []): ParsedPick[] {
  const sortedNames = [...knownCapperNames].sort((a, b) => b.length - a.length);
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const results: ParsedPick[] = [];
  let currentCapper = "";

  for (const line of lines) {
    const lower = line.toLowerCase();
    const inlineMatch = sortedNames.find((name) => {
      const nameLower = name.toLowerCase();
      return (
        lower === nameLower ||
        (lower.startsWith(nameLower) && /[\s:.-]/.test(line[name.length] ?? " "))
      );
    });

    if (inlineMatch) {
      const remainder = line.slice(inlineMatch.length).replace(/^[\s:.-]+/, "").trim();
      if (!remainder) {
        currentCapper = inlineMatch;
        continue;
      }
      const detected = detectSport(remainder);
      if (!detected.sportName) {
        const ambiguous = findAmbiguousNickname(remainder);
        if (ambiguous) {
          results.push({
            capperName: inlineMatch,
            sportName: "",
            description: remainder,
            betType: "SPREAD",
            odds: -110,
            hasExplicitOdds: false,
            units: 1,
            isFirstFive: false,
            raw: line,
            ambiguous,
          });
        }
        continue;
      }
      const parsed = parsePickText(detected.rest);
      results.push({
        capperName: inlineMatch,
        sportName: detected.sportName,
        description: parsed.cleanDescription,
        betType: parsed.betType,
        odds: parsed.odds ?? -110,
        hasExplicitOdds: parsed.odds !== null,
        totalSide: parsed.totalSide,
        units: parsed.units,
        isFirstFive: parsed.isFirstFive,
        raw: line,
      });
      continue;
    }

    const strippedText = line.replace(/^[*-]\s*/, "").trim();
    const detected = detectSport(strippedText);

    if (detected.sportName) {
      const parsed = parsePickText(detected.rest);
      results.push({
        capperName: currentCapper || "Unknown",
        sportName: detected.sportName,
        description: parsed.cleanDescription,
        betType: parsed.betType,
        odds: parsed.odds ?? -110,
        hasExplicitOdds: parsed.odds !== null,
        totalSide: parsed.totalSide,
        units: parsed.units,
        isFirstFive: parsed.isFirstFive,
        raw: strippedText,
      });
      continue;
    }

    const ambiguous = findAmbiguousNickname(strippedText);
    if (ambiguous) {
      results.push({
        capperName: currentCapper || "Unknown",
        sportName: "",
        description: strippedText,
        betType: "SPREAD",
        odds: -110,
        hasExplicitOdds: false,
        units: 1,
        isFirstFive: false,
        raw: strippedText,
        ambiguous,
      });
      continue;
    }

    const name = line.replace(/^[^\w]+/, "").trim();
    if (name) {
      const normalized = normalizeName(name);
      const existingMatch = knownCapperNames.find((n) => normalizeName(n) === normalized);
      currentCapper = existingMatch ?? name;
    }
  }

  return results;
}
