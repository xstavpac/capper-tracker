import { normalizeName } from "@/lib/fuzzy-match";

export type ParsedPick = {
  capperName: string;
  sportName: string;
  description: string;
  betType: "SPREAD" | "MONEYLINE" | "TOTAL" | "PLAYER_PROP" | "NRFI";
  odds: number;
  hasExplicitOdds: boolean;
  totalSide?: "over" | "under";
  units: number;
  isFirstFive: boolean;
  raw: string;
  ambiguous?: AmbiguousOption[];
  // The AMBIGUOUS_NICKNAMES key (e.g. "cardinals") that produced `ambiguous`,
  // set alongside it - lets a caller group every pick sharing the same
  // ambiguous team across one catalog paste, so resolving one resolves all
  // of them instead of asking about the same name repeatedly.
  ambiguousKey?: string;
  // Team nicknames found in the raw text, e.g. from "Over 9.5 (Angels/Orioles)"
  // or "Cardinals vs Panthers". Captured before parens/odds get stripped out of
  // `description`, so game resolution still has both teams even for bets (like
  // Totals) whose team info lives only inside that annotation.
  teamNicknames: string[];
};

type TeamEntry = [string, string];

// One resolvable possibility for an ambiguous nickname - `nickname` is the
// canonical disambiguated phrase (matches a DISAMBIGUATED_TEAMS entry) so
// resolving a pick can plug it straight into teamNicknames without having to
// re-derive it from `label` by parsing text back out of a display string.
export type AmbiguousOption = { label: string; sport: string; nickname: string };

const KNOWN_SPORTS = [
  "WNBA", "NCAAF", "NCAAB", "MLB", "NBA", "NHL", "NFL", "MLS", "UFC", "MMA",
  "PGA", "ATP", "WTA", "EPL", "LA LIGA", "SERIE A", "BUNDESLIGA", "LIGUE 1",
  "CHAMPIONS LEAGUE",
];

// "cardinals" is deliberately excluded here - it's ambiguous with NFL (see
// AMBIGUOUS_NICKNAMES) and must fall through to that check instead of always
// resolving to MLB. "St Louis Cardinals" is still reachable via DISAMBIGUATED_TEAMS.
const MLB_TEAMS = [
  "diamondbacks", "braves", "orioles", "red sox", "cubs", "white sox", "reds",
  "guardians", "rockies", "tigers", "astros", "royals", "angels", "dodgers",
  "marlins", "brewers", "twins", "mets", "yankees", "athletics", "phillies",
  "pirates", "padres", "mariners", "rays", "blue jays", "nationals",
];

const NBA_TEAMS = [
  "hawks", "celtics", "nets", "hornets", "bulls", "cavaliers", "mavericks",
  "nuggets", "pistons", "warriors", "rockets", "pacers", "clippers", "lakers",
  "grizzlies", "heat", "bucks", "timberwolves", "pelicans", "knicks", "thunder",
  "magic", "76ers", "sixers", "suns", "trail blazers", "blazers", "spurs",
  "raptors", "jazz", "wizards",
];

// "panthers" is deliberately excluded here - it's ambiguous with NHL (see
// AMBIGUOUS_NICKNAMES) and must fall through to that check instead of always
// resolving to NFL. "Carolina Panthers" is still reachable via DISAMBIGUATED_TEAMS.
const NFL_TEAMS = [
  "falcons", "ravens", "bills", "bears", "bengals", "browns",
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

const AMBIGUOUS_NICKNAMES: Record<string, AmbiguousOption[]> = {
  cardinals: [
    // The period matters here: this nickname feeds straight into
    // resolveGameForNickname's `g.homeTeam.toLowerCase().endsWith(nickname)`
    // check against the live schedule, where the real team name is always
    // "St. Louis Cardinals" (with the period) - a period-less nickname
    // silently never matches, unlike every other AMBIGUOUS_NICKNAMES entry
    // (none of which have punctuation in their real team name).
    { label: "St. Louis Cardinals (MLB)", sport: "MLB", nickname: "st. louis cardinals" },
    { label: "Arizona Cardinals (NFL)", sport: "NFL", nickname: "arizona cardinals" },
  ],
  rangers: [
    { label: "Texas Rangers (MLB)", sport: "MLB", nickname: "texas rangers" },
    { label: "New York Rangers (NHL)", sport: "NHL", nickname: "new york rangers" },
  ],
  kings: [
    { label: "Sacramento Kings (NBA)", sport: "NBA", nickname: "sacramento kings" },
    { label: "Los Angeles Kings (NHL)", sport: "NHL", nickname: "los angeles kings" },
  ],
  panthers: [
    { label: "Carolina Panthers (NFL)", sport: "NFL", nickname: "carolina panthers" },
    { label: "Florida Panthers (NHL)", sport: "NHL", nickname: "florida panthers" },
  ],
  giants: [
    { label: "San Francisco Giants (MLB)", sport: "MLB", nickname: "san francisco giants" },
    { label: "New York Giants (NFL)", sport: "NFL", nickname: "new york giants" },
  ],
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

// allowNicknameFallback gates the second (fuzzy, team-nickname-only) branch -
// callers pass false right after a blank line, where a bare nickname match
// ("Tigers Kitchen") is far more likely to be a capper's name than a pick
// with no explicit sport code. The explicit-code branch always stays on.
function detectSport(text: string, allowNicknameFallback = true): { sportName: string; rest: string } {
  for (const code of KNOWN_SPORTS) {
    const re = new RegExp("\\b" + code.replace(/ /g, "\\s+") + "\\b", "i");
    const match = text.match(re);
    if (match && match.index !== undefined) {
      const rest = text.slice(match.index + match[0].length).replace(/^[:\s]+/, "");
      return { sportName: code, rest };
    }
  }

  if (!allowNicknameFallback) return { sportName: "", rest: text };

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
    if (/u(nits?)?$/i.test(val)) {
      units = parseFloat(val);
    } else if (/^[+-]?\d+$/.test(val)) {
      odds = parseInt(val, 10);
    }
  }

  // Units aren't always wrapped in parens, and can be spelled out ("2 units",
  // "1 unit") rather than the "2u" shorthand - e.g. "Cubs moneyline 2 units"
  // with no parenthetical wrapper at all. Only checked when the paren scan
  // above found nothing, so an explicit "(1u)" still wins if present.
  let bareUnitPhrase: string | null = null;
  if (units === null) {
    const spelledOut = description.match(/\b(\d+(?:\.\d+)?)\s*units?\b/i);
    const shorthand = description.match(/\b(\d+(?:\.\d+)?)\s*u\b/i);
    const unitMatch = spelledOut ?? shorthand;
    if (unitMatch) {
      units = parseFloat(unitMatch[1]);
      bareUnitPhrase = unitMatch[0];
    }
  }

  let cleanDescription = description.replace(/\([^)]*\)/g, "");
  if (bareUnitPhrase) cleanDescription = cleanDescription.replace(bareUnitPhrase, "");
  cleanDescription = cleanDescription.replace(/\s{2,}/g, " ").trim();
  // Catches both abbreviated ("F5", "1st 5"/"1st5") and fully spelled-out
  // ("first 5", "first five", "1st five") phrasing - the abbreviated-only
  // version silently left every spelled-out F5 pick stored as period=
  // FULL_GAME (graded/priced against the wrong, full-game score).
  const isFirstFive =
    /\bf5\b/i.test(cleanDescription) ||
    /\b1st\s*5\b/i.test(cleanDescription) ||
    /\bfirst\s*5\b/i.test(cleanDescription) ||
    /\b1st\s+five\b/i.test(cleanDescription) ||
    /\bfirst\s+five\b/i.test(cleanDescription);

  // Bare team name with no qualifier (e.g. "Tampa Bay Rays") defaults to
  // MONEYLINE, not SPREAD - a straight team-name pick is the standard
  // shorthand for "to win", and SPREAD requires an actual line number to
  // mean anything at all. Previously defaulted to SPREAD unconditionally,
  // which - combined with the automatic real-odds lookup at import time -
  // silently attached a real spreads-market price to what was really a
  // moneyline pick, with no `line` value stored to make the SPREAD read
  // coherent (see the "-220 doesn't match the market" investigation).
  let betType: ParsedPick["betType"] = "MONEYLINE";
  let totalSide: "over" | "under" | undefined;
  const hasExplicitSpreadNumber = /[+-]\d+(\.\d+)?/.test(cleanDescription);
  const hasSpreadKeyword = /\b(spread|run\s*line|puck\s*line|point\s*spread)\b/i.test(cleanDescription);
  // "inning" is optional - "no run 1st" / "yes run first" are common
  // shorthand that the old inning-required pattern missed entirely, falling
  // through to the MONEYLINE default instead.
  if (
    /\b[NY]RFI\b/i.test(cleanDescription) ||
    /\b(no|yes)\s+run\s+(?:first|1st)(?:\s+inning)?\b/i.test(cleanDescription)
  ) {
    betType = "NRFI";
  } else if (/\bML\b/i.test(cleanDescription) || /money\s*line/i.test(cleanDescription)) {
    betType = "MONEYLINE";
  } else if (/\bover\b/i.test(cleanDescription)) {
    betType = "TOTAL";
    totalSide = "over";
  } else if (/\bunder\b/i.test(cleanDescription)) {
    betType = "TOTAL";
    totalSide = "under";
  } else if (/\btotal\b/i.test(cleanDescription)) {
    betType = "TOTAL";
  } else if (hasExplicitSpreadNumber || hasSpreadKeyword) {
    betType = "SPREAD";
  }

  return { betType, odds, units: units ?? 1, isFirstFive, cleanDescription, totalSide };
}

// Re-parses an ambiguous pick's original text now that the user has picked a
// specific team off the button row - reruns the same bet-type/odds/units
// extraction the unambiguous path already does (the ambiguous branch skips
// that work entirely, since sport-less text can't be resolved against a
// schedule yet), then plugs the chosen team in directly as teamNicknames
// rather than re-deriving it via regex, since the user just told us exactly
// which team they meant.
export function resolveAmbiguousPick(pick: ParsedPick, choice: AmbiguousOption): ParsedPick {
  const parsed = parsePickText(pick.description);
  return {
    ...pick,
    sportName: choice.sport,
    description: parsed.cleanDescription,
    betType: parsed.betType,
    odds: parsed.odds ?? -110,
    hasExplicitOdds: parsed.odds !== null,
    totalSide: parsed.totalSide,
    units: parsed.units,
    isFirstFive: parsed.isFirstFive,
    teamNicknames: [choice.nickname],
    ambiguous: undefined,
    ambiguousKey: undefined,
  };
}

function findAmbiguousNickname(text: string): { key: string; options: AmbiguousOption[] } | undefined {
  const lower = text.toLowerCase();
  for (const [nickname, options] of Object.entries(AMBIGUOUS_NICKNAMES)) {
    const re = new RegExp("\\b" + nickname + "\\b", "i");
    if (re.test(lower)) return { key: nickname, options };
  }
  return undefined;
}

// Every candidate sport for a given AMBIGUOUS_NICKNAMES key - exported so the
// auto-resolution pipeline (resolve-ambiguous-catalog.ts) can enumerate
// candidates without duplicating this table.
export function ambiguousOptionsFor(key: string): AmbiguousOption[] {
  return AMBIGUOUS_NICKNAMES[key] ?? [];
}

// Sport-specific betting terminology, used as one signal (not the sole
// determining factor - see inferSportFromPickContext) when a team name is
// ambiguous between two sports that are both in season with both teams
// scheduled. Deliberately narrow, high-signal phrases only - generic words
// that could plausibly appear in any sport's pick text are left out.
const SPORT_CONTEXT_SIGNALS: Record<string, RegExp[]> = {
  MLB: [
    /\bmoney\s*line\b/i,
    /\bML\b/,
    /\brun\s*line\b/i,
    /\b[NY]RFI\b/i,
    /\b(no|yes)\s+run\s+(?:first|1st)\b/i,
    /\bf5\b/i,
    /\bfirst\s*five\b/i,
    /\b1st\s*5\b/i,
  ],
  NFL: [
    /\bspread\b/i,
    /\btouchdown\b/i,
    /\bTDs?\b/,
    /\bpassing\s+yards?\b/i,
    /\brushing\s+yards?\b/i,
    /\breceiving\s+yards?\b/i,
    /\bfirst[\s-]half\s+spread\b/i,
  ],
  NHL: [/\bpuck\s*line\b/i, /\bpower\s*play\b/i, /\bperiod\b/i, /\bgoalie\b/i, /\bshots?\s+on\s+goal\b/i],
  NBA: [/\brebounds?\b/i, /\bassists?\b/i, /\bquarter\b/i, /\b3-?pointers?\b/i],
};

// A baseball total ("over/under 6.5-11.5") is a real signal specifically
// against NFL (whose totals run much higher, ~38-55) - only applied when
// NFL is one of the candidates, so it doesn't get invoked for e.g. an
// NHL-vs-NBA conflict where it wouldn't mean anything.
function hasMlbTotalRangeSignal(text: string): boolean {
  return /\b(over|under)\s*(6|7|8|9|10|11)\.5\b/i.test(text);
}

// STEP 3 of the disambiguation hierarchy (see resolve-ambiguous-catalog.ts) -
// supporting evidence only. Returns a single sport only when exactly one
// candidate's terminology matches and none of the others also match -
// conflicting or absent signals return null so the caller falls through to
// asking the user instead of guessing.
export function inferSportFromPickContext(text: string, candidateSports: string[]): string | null {
  const matches = candidateSports.filter((sport) => {
    const patterns = SPORT_CONTEXT_SIGNALS[sport] ?? [];
    if (patterns.some((re) => re.test(text))) return true;
    if (sport === "MLB" && candidateSports.includes("NFL") && hasMlbTotalRangeSignal(text)) return true;
    return false;
  });
  return matches.length === 1 ? matches[0] : null;
}

function findAllAmbiguousNicknames(text: string): string[] {
  const lower = text.toLowerCase();
  const found: string[] = [];
  for (const nickname of Object.keys(AMBIGUOUS_NICKNAMES)) {
    const re = new RegExp("\\b" + nickname + "\\b", "i");
    if (re.test(lower)) found.push(nickname);
  }
  return found;
}

function ambiguousSports(nickname: string): string[] {
  const options = AMBIGUOUS_NICKNAMES[nickname] ?? [];
  return options.map((o) => o.sport);
}

// When a pick names two ambiguous-nickname teams (e.g. "Cardinals vs Panthers"),
// their possible sports usually intersect at exactly one - "Panthers" isn't an
// MLB team, so it narrows "Cardinals" down to NFL. Resolves cleanly instead of
// blocking on ambiguity whenever that intersection is unambiguous.
function resolveAmbiguousPair(text: string): { sportName: string; teamNicknames: string[] } | undefined {
  const nicknames = findAllAmbiguousNicknames(text);
  if (nicknames.length !== 2) return undefined;

  const [a, b] = nicknames;
  const sportsA = new Set(ambiguousSports(a));
  const common = ambiguousSports(b).filter((s) => sportsA.has(s));
  if (common.length !== 1) return undefined;

  return { sportName: common[0], teamNicknames: nicknames };
}

// Returns every distinct team nickname found in the text, longest-match-first
// (matches the order TEAM_SPORT_ENTRIES is sorted in). Lets a caller pin an
// exact matchup when a pick names both teams, e.g. "Dodgers Cubs under 8.5".
export function findTeamNicknames(text: string, sportName: string): string[] {
  const lower = text.toLowerCase();
  const found: string[] = [];
  for (const [phrase, sport] of TEAM_SPORT_ENTRIES) {
    if (sport !== sportName) continue;
    const re = new RegExp("\\b" + phrase.replace(/ /g, "\\s+") + "\\b", "i");
    if (re.test(lower) && !found.includes(phrase)) found.push(phrase);
  }
  return found;
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
  const rawLines = text.split("\n").map((l) => l.trim());

  const results: ParsedPick[] = [];
  let currentCapper = "";
  // Treated like "start of catalog" - a blank line before a name is the
  // strongest signal that what follows is a new capper's header, not a pick.
  // Gates the fuzzy nickname-only branches below (see detectSport's
  // allowNicknameFallback) so a header like "Tigers Kitchen" can't be
  // misread as a Tigers pick just because it contains a team nickname.
  let precededByBlank = true;

  for (const line of rawLines) {
    if (!line) {
      precededByBlank = true;
      continue;
    }
    const afterBlank = precededByBlank;
    precededByBlank = false;

    // "*Name" always forces this line to be read as a capper name, no matter
    // what words it contains - the explicit escape hatch for names that
    // happen to contain a real team nickname (e.g. "*Tigers Kitchen").
    if (line.startsWith("*")) {
      const forcedName = line.slice(1).replace(/^[\s:.-]+/, "").trim();
      if (forcedName) {
        const normalized = normalizeName(forcedName);
        const existingMatch = knownCapperNames.find((n) => normalizeName(n) === normalized);
        currentCapper = existingMatch ?? forcedName;
      }
      continue;
    }

    // A standalone line that matches a SAVED capper's name (case/punctuation-
    // insensitive, same normalizeName leniency used everywhere else a known
    // name is matched) is always read as that capper's header, checked before
    // any team/sport detection - once a capper is saved, the app already
    // knows their name and doesn't need to guess from words in the text. The
    // "*" prefix above is only needed for a brand-new, not-yet-saved capper
    // whose name happens to collide with a team nickname the first time.
    const normalizedLine = normalizeName(line);
    const savedNameMatch = knownCapperNames.find((n) => normalizeName(n) === normalizedLine);
    if (savedNameMatch) {
      currentCapper = savedNameMatch;
      continue;
    }

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
        const pairResolved = resolveAmbiguousPair(remainder);
        if (pairResolved) {
          const parsed = parsePickText(remainder);
          results.push({
            capperName: inlineMatch,
            sportName: pairResolved.sportName,
            description: parsed.cleanDescription,
            betType: parsed.betType,
            odds: parsed.odds ?? -110,
            hasExplicitOdds: parsed.odds !== null,
            totalSide: parsed.totalSide,
            units: parsed.units,
            isFirstFive: parsed.isFirstFive,
            raw: line,
            teamNicknames: pairResolved.teamNicknames,
          });
          continue;
        }

        const found = findAmbiguousNickname(remainder);
        if (found) {
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
            ambiguous: found.options,
            ambiguousKey: found.key,
            teamNicknames: [],
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
        teamNicknames: findTeamNicknames(detected.rest, detected.sportName),
      });
      continue;
    }

    const strippedText = line.replace(/^-\s*/, "").trim();
    const detected = detectSport(strippedText, !afterBlank);

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
        teamNicknames: findTeamNicknames(detected.rest, detected.sportName),
      });
      continue;
    }

    // Same reasoning as detectSport's gate above - these are both
    // nickname-driven too, so a header right after a blank line skips them
    // entirely rather than risk misreading it as a pick.
    if (!afterBlank) {
      const pairResolved = resolveAmbiguousPair(strippedText);
      if (pairResolved) {
        const parsed = parsePickText(strippedText);
        results.push({
          capperName: currentCapper || "Unknown",
          sportName: pairResolved.sportName,
          description: parsed.cleanDescription,
          betType: parsed.betType,
          odds: parsed.odds ?? -110,
          hasExplicitOdds: parsed.odds !== null,
          totalSide: parsed.totalSide,
          units: parsed.units,
          isFirstFive: parsed.isFirstFive,
          raw: strippedText,
          teamNicknames: pairResolved.teamNicknames,
        });
        continue;
      }

      const found = findAmbiguousNickname(strippedText);
      if (found) {
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
          ambiguous: found.options,
          ambiguousKey: found.key,
          teamNicknames: [],
        });
        continue;
      }
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
