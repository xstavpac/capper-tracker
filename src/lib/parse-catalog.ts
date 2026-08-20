import { normalizeName } from "@/lib/fuzzy-match";
import { parseTouchdownProp } from "@/lib/bet-line";

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
  "WNBA", "NCAAF", "NCAAB", "MLB", "NBA", "NHL", "NFL", "CFL", "MLS", "UFC", "MMA",
  "PGA", "ATP", "WTA", "EPL", "LA LIGA", "SERIE A", "BUNDESLIGA", "LIGUE 1",
  "CHAMPIONS LEAGUE", "KBO",
];

// A small, exact-match list of section labels cappers paste as boilerplate
// between their name and their actual picks ("Full Card" seen in a real
// catalog) - never a capper name, never a pick, so a line matching one of
// these (whole line, case-insensitive) is skipped entirely: currentCapper is
// left exactly as it was, nothing is added to results or unresolved. Kept
// small and exact rather than guessed broadly - add to this only from a
// confirmed real example, the same standard as every other list in this file.
const BOILERPLATE_LABELS = new Set(["full card"]);

function isBoilerplateLabel(text: string): boolean {
  return BOILERPLATE_LABELS.has(text.toLowerCase().trim());
}

// "cardinals" is deliberately excluded here - it's ambiguous with NFL (see
// AMBIGUOUS_NICKNAMES) and must fall through to that check instead of always
// resolving to MLB. "St Louis Cardinals" is still reachable via DISAMBIGUATED_TEAMS.
// "tigers" and "twins" are excluded for the same reason - both now collide
// with a KBO team (KIA Tigers, LG Twins); see AMBIGUOUS_NICKNAMES.
const MLB_TEAMS = [
  "diamondbacks", "braves", "orioles", "red sox", "cubs", "white sox", "reds",
  "guardians", "rockies", "astros", "royals", "angels", "dodgers",
  "marlins", "brewers", "mets", "yankees", "athletics", "phillies",
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
// "bears", "lions", and "eagles" are excluded for the same reason - all three
// now collide with a KBO team (Doosan Bears, Samsung Lions, Hanwha Eagles);
// see AMBIGUOUS_NICKNAMES.
const NFL_TEAMS = [
  "falcons", "ravens", "bills", "bengals", "browns",
  "cowboys", "broncos", "packers", "texans", "colts", "jaguars",
  "chiefs", "raiders", "chargers", "rams", "dolphins", "vikings", "patriots",
  "saints", "jets", "steelers", "49ers", "niners", "seahawks",
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

// "lions" deliberately excluded - BC Lions collides with NFL's Detroit Lions,
// same "let it fall through rather than always resolving to one sport"
// reasoning as cardinals/panthers/giants above. Not added to
// AMBIGUOUS_NICKNAMES either since this app has no CFL schedule data to
// actually disambiguate against - a bare "Lions" pick just stays NFL, same
// as before CFL support existed.
const CFL_TEAMS = [
  "redblacks", "blue bombers", "roughriders", "argonauts", "elks",
  "alouettes", "stampeders", "tiger-cats",
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
    { label: "Lotte Giants (KBO)", sport: "KBO", nickname: "lotte giants" },
  ],
  // The following five keys exist solely because of KBO team-name collisions
  // (see KBO_TEAMS/DISAMBIGUATED_TEAMS above) - each bare nickname used to
  // resolve straight to its one US-league team in MLB_TEAMS/NFL_TEAMS; now
  // that a KBO team shares the same bare nickname, it must fall through to
  // here (and from there to the season/schedule/pick-context hierarchy in
  // resolve-ambiguous-catalog.ts, or a manual choice) instead of silently
  // guessing. A capper naming the city too ("Doosan Bears") never reaches
  // this - it resolves directly via DISAMBIGUATED_TEAMS.
  bears: [
    { label: "Chicago Bears (NFL)", sport: "NFL", nickname: "chicago bears" },
    { label: "Doosan Bears (KBO)", sport: "KBO", nickname: "doosan bears" },
  ],
  twins: [
    { label: "Minnesota Twins (MLB)", sport: "MLB", nickname: "minnesota twins" },
    { label: "LG Twins (KBO)", sport: "KBO", nickname: "lg twins" },
  ],
  lions: [
    { label: "Detroit Lions (NFL)", sport: "NFL", nickname: "detroit lions" },
    { label: "Samsung Lions (KBO)", sport: "KBO", nickname: "samsung lions" },
  ],
  eagles: [
    { label: "Philadelphia Eagles (NFL)", sport: "NFL", nickname: "philadelphia eagles" },
    { label: "Hanwha Eagles (KBO)", sport: "KBO", nickname: "hanwha eagles" },
  ],
  tigers: [
    { label: "Detroit Tigers (MLB)", sport: "MLB", nickname: "detroit tigers" },
    { label: "KIA Tigers (KBO)", sport: "KBO", nickname: "kia tigers" },
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
  // KBO collisions (see KBO_TEAMS above) - a capper naming the city alongside
  // the nickname (confirmed the norm for every KBO example seen: "Doosan
  // Bears", "Lotte Giants", "KIA Tigers vs Hanwha Eagles") resolves directly
  // here, same mechanism as every entry above. Each US-league side is also
  // listed explicitly since removing the bare nickname from MLB_TEAMS/
  // NFL_TEAMS below means "Chicago Bears" typed in full needs its own entry
  // too, not just the KBO side.
  ["doosan bears", "KBO"],
  ["chicago bears", "NFL"],
  ["lg twins", "KBO"],
  ["minnesota twins", "MLB"],
  ["lotte giants", "KBO"],
  ["samsung lions", "KBO"],
  ["detroit lions", "NFL"],
  ["hanwha eagles", "KBO"],
  ["philadelphia eagles", "NFL"],
  ["kia tigers", "KBO"],
  ["detroit tigers", "MLB"],
];

// KBO (Korean Baseball Organization). Four of the ten teams' nicknames don't
// collide with any other sport's team list (confirmed against the real
// mis-tagged import: Doosan Bears -> NFL, Lotte Giants -> MLB, KIA Tigers/
// Hanwha Eagles -> MLB/NFL), so they resolve the same simple way every other
// unambiguous nickname above does - bare nickname, no city needed. The six
// that DO collide (Bears/Twins/Giants/Lions/Eagles/Tigers) are deliberately
// left out of this list, same as cardinals/panthers/lions-vs-CFL above - see
// DISAMBIGUATED_TEAMS (city-qualified form) and AMBIGUOUS_NICKNAMES (bare
// form) below for how each of those is actually resolved.
const KBO_TEAMS = ["wiz", "landers", "dinos", "heroes"];

// NCAAF - Power 4 conferences (SEC/Big Ten/Big 12/ACC) + Notre Dame only,
// the week-1 curated launch scope (see the NCAAF ecosystem investigation).
// Each entry is [school-name key, canonical "school mascot" suffix].
//
// Keyed by SCHOOL name, deliberately never by bare mascot - unlike every
// pro-sport list above, a bare college mascot is very often shared by
// multiple schools. Within just this curated 68: Tigers (Auburn/LSU/
// Missouri/Clemson), Wildcats (Kentucky/Northwestern/Arizona/Kansas State),
// Bulldogs (Georgia/Mississippi State), Knights (Rutgers/UCF), Devils
// (Arizona State/Duke), Cougars (Houston/BYU), and Bears (Baylor/California)
// all collide within this list alone - and Ducks, Bruins, Devils, Cowboys,
// Raiders, Hurricanes, and Cavaliers each already resolve to an existing
// NFL/NBA/NHL entry above. A school's own name has none of these problems -
// confirmed unique across all 68 against the live Odds API roster - so
// that's the only thing registered here. A bare mascot-only NCAAF pick
// ("Tigers ML", no school named) is left exactly as it already was before
// NCAAF existed: unresolved for a mascot nobody else uses either (Wildcats,
// Bulldogs, Knights, Cougars), or the pre-existing MLB/KBO ("tigers"),
// NFL/KBO ("bears"), or NHL ("devils") resolution for a mascot that was
// already meaningful - never guessed at as any particular NCAAF school.
//
// The second element of each pair (the canonical suffix) exists because
// resolveGameForNickname/resolveGameForTeams (odds.ts) match a nickname
// against the END of the real live-schedule team name - true by
// construction for every bare mascot above (a real team name is always
// "City/School Mascot"), but a bare school name is a PREFIX of that name,
// not a suffix ("lsu" doesn't end "LSU Tigers"). NCAAF_CANONICAL_SUFFIX
// below exports the translation; its one call site is lookupGame in
// bulk-picks.ts, applied only for NCAAF - every other sport's nicknames
// already satisfy endsWith directly and this table is never consulted for
// them.
const NCAAF_SCHOOLS: [string, string][] = [
  // SEC
  ["alabama", "alabama crimson tide"],
  ["arkansas", "arkansas razorbacks"],
  ["auburn", "auburn tigers"],
  ["florida", "florida gators"],
  ["georgia", "georgia bulldogs"],
  ["kentucky", "kentucky wildcats"],
  ["lsu", "lsu tigers"],
  ["ole miss", "ole miss rebels"],
  ["mississippi state", "mississippi state bulldogs"],
  ["missouri", "missouri tigers"],
  ["oklahoma", "oklahoma sooners"],
  ["south carolina", "south carolina gamecocks"],
  ["tennessee", "tennessee volunteers"],
  ["texas", "texas longhorns"],
  ["texas a&m", "texas a&m aggies"],
  ["vanderbilt", "vanderbilt commodores"],
  // Big Ten
  ["illinois", "illinois fighting illini"],
  ["iowa", "iowa hawkeyes"],
  ["indiana", "indiana hoosiers"],
  ["maryland", "maryland terrapins"],
  ["michigan", "michigan wolverines"],
  ["michigan state", "michigan state spartans"],
  ["minnesota", "minnesota golden gophers"],
  ["nebraska", "nebraska cornhuskers"],
  ["northwestern", "northwestern wildcats"],
  ["ohio state", "ohio state buckeyes"],
  ["oregon", "oregon ducks"],
  ["penn state", "penn state nittany lions"],
  ["purdue", "purdue boilermakers"],
  ["rutgers", "rutgers scarlet knights"],
  ["ucla", "ucla bruins"],
  ["usc", "usc trojans"],
  ["washington", "washington huskies"],
  ["wisconsin", "wisconsin badgers"],
  // Big 12
  ["arizona", "arizona wildcats"],
  ["arizona state", "arizona state sun devils"],
  ["colorado", "colorado buffaloes"],
  ["utah", "utah utes"],
  ["cincinnati", "cincinnati bearcats"],
  ["houston", "houston cougars"],
  ["ucf", "ucf knights"],
  ["byu", "byu cougars"],
  ["baylor", "baylor bears"],
  ["iowa state", "iowa state cyclones"],
  ["kansas", "kansas jayhawks"],
  ["kansas state", "kansas state wildcats"],
  ["oklahoma state", "oklahoma state cowboys"],
  ["tcu", "tcu horned frogs"],
  ["texas tech", "texas tech red raiders"],
  ["west virginia", "west virginia mountaineers"],
  // ACC
  ["clemson", "clemson tigers"],
  ["miami", "miami hurricanes"],
  ["florida state", "florida state seminoles"],
  ["louisville", "louisville cardinals"],
  ["pittsburgh", "pittsburgh panthers"],
  ["smu", "smu mustangs"],
  ["north carolina", "north carolina tar heels"],
  ["duke", "duke blue devils"],
  ["virginia tech", "virginia tech hokies"],
  ["syracuse", "syracuse orange"],
  ["nc state", "nc state wolfpack"],
  ["boston college", "boston college eagles"],
  ["georgia tech", "georgia tech yellow jackets"],
  ["stanford", "stanford cardinal"],
  ["california", "california golden bears"],
  ["virginia", "virginia cavaliers"],
  ["wake forest", "wake forest demon deacons"],
  // Independent
  ["notre dame", "notre dame fighting irish"],
];

const NCAAF_TEAMS = NCAAF_SCHOOLS.map(([key]) => key);

export const NCAAF_CANONICAL_SUFFIX: Record<string, string> = Object.fromEntries(NCAAF_SCHOOLS);

const TEAM_SPORT_ENTRIES: TeamEntry[] = [
  ...DISAMBIGUATED_TEAMS,
  ...MLB_TEAMS.map((t): TeamEntry => [t, "MLB"]),
  ...NBA_TEAMS.map((t): TeamEntry => [t, "NBA"]),
  ...NFL_TEAMS.map((t): TeamEntry => [t, "NFL"]),
  ...NHL_TEAMS.map((t): TeamEntry => [t, "NHL"]),
  ...WNBA_TEAMS.map((t): TeamEntry => [t, "WNBA"]),
  ...CFL_TEAMS.map((t): TeamEntry => [t, "CFL"]),
  ...KBO_TEAMS.map((t): TeamEntry => [t, "KBO"]),
  ...NCAAF_TEAMS.map((t): TeamEntry => [t, "NCAAF"]),
].sort((a, b) => b[0].length - a[0].length);

// Purpose-built for classifyPickTeamGroup/shortTeamName (pick-team-group.ts)
// ONLY - never for import parsing. Those callers are solving a different
// problem than findTeamNickname/TEAM_SPORT_ENTRIES: they already know the
// exact team and sport unambiguously (from the live schedule's own
// homeTeam/awayTeam), so there's no risk of the KBO-collision misresolution
// DISAMBIGUATED_TEAMS/AMBIGUOUS_NICKNAMES exists to prevent (see
// "Disambiguate bare KBO nicknames..." commit) - that risk is specifically
// about *inferring* which sport a bare nickname belongs to from free text
// alone, which never happens here. What they need instead is the short form
// a capper actually types for a team ("Twins", not "Minnesota Twins") to
// match against betDetail text - using findTeamNickname for this (as
// classifyPickTeamGroup used to) returns the disambiguated long form for any
// KBO-collision team, which then never matches betDetail's short form,
// silently misgrouping every Twins/Tigers/Bears/Lions/Eagles moneyline pick
// into "Totals & Other Markets" instead of its own team header.
//
// Built from the same bare-nickname lists TEAM_SPORT_ENTRIES uses, plus the
// bare key of every AMBIGUOUS_NICKNAMES entry (which is exactly the short
// form a capper types for cardinals/rangers/kings/panthers/giants/bears/
// twins/lions/eagles/tigers) for each sport it lists - deliberately omitting
// DISAMBIGUATED_TEAMS (the long, city-qualified forms, wrong shape for
// matching betDetail). The import-parsing path this must not touch
// (parseCatalog/detectSport/findTeamNickname/TEAM_SPORT_ENTRIES) is entirely
// separate from this constant and this function.
const GROUPING_TEAM_NICKNAMES: TeamEntry[] = [
  ...MLB_TEAMS.map((t): TeamEntry => [t, "MLB"]),
  ...NBA_TEAMS.map((t): TeamEntry => [t, "NBA"]),
  ...NFL_TEAMS.map((t): TeamEntry => [t, "NFL"]),
  ...NHL_TEAMS.map((t): TeamEntry => [t, "NHL"]),
  ...WNBA_TEAMS.map((t): TeamEntry => [t, "WNBA"]),
  ...CFL_TEAMS.map((t): TeamEntry => [t, "CFL"]),
  ...KBO_TEAMS.map((t): TeamEntry => [t, "KBO"]),
  ...NCAAF_TEAMS.map((t): TeamEntry => [t, "NCAAF"]),
  ...Object.entries(AMBIGUOUS_NICKNAMES).flatMap(([bare, options]): TeamEntry[] =>
    options.map((o): TeamEntry => [bare, o.sport])
  ),
].sort((a, b) => b[0].length - a[0].length);

// Given a live-schedule team's full name (e.g. "Minnesota Twins") and its
// already-known sport, returns the short nickname a capper actually types
// for it (e.g. "twins") - see GROUPING_TEAM_NICKNAMES above for why this is
// a separate function from findTeamNickname rather than a shared one.
export function findGroupingNickname(text: string, sportName: string): string | undefined {
  const lower = text.toLowerCase();
  for (const [phrase, sport] of GROUPING_TEAM_NICKNAMES) {
    if (sport !== sportName) continue;
    if (teamPhraseRegex(phrase).test(lower)) return phrase;
  }
  return undefined;
}

// Strong "this is definitely a pick, not a capper's name" signals - a units
// annotation, an explicit signed number, or betting shorthand a real name
// essentially never contains. Used to override the "right after a blank
// line, assume it's a header" caution below: some pasted catalogs (Twitter
// copy/paste especially) put a blank line between a capper's name and their
// first pick, not just between different cappers, and without this override
// that first pick was indistinguishable from a header and got silently
// swallowed as one - corrupting every pick after it for the rest of the paste.
function looksLikePick(text: string): boolean {
  return (
    /\(\s*[\d.]+\s*u(nits?)?\b/i.test(text) ||
    /\b\d+(\.\d+)?\s*u(nits?)?\b/i.test(text) ||
    // Same units signal, reversed word order ("Units: 1", "unit 1 each") -
    // a capper's own bet-size shorthand is always digit-first ("1u", "2
    // units"), but a trailing meta note describing the whole batch's unit
    // size ("All 1 unit each", or word-order-reversed "Units: 1 each") isn't
    // a pick at all and needs the same signal to route to `unresolved`
    // instead of falling through to being read as a capper name.
    /\bunits?\b\s*:?\s*\d+(\.\d+)?\b/i.test(text) ||
    /[+-]\d+(\.\d+)?/.test(text) ||
    /\bML\b/i.test(text) ||
    /money\s*line/i.test(text) ||
    /\b(over|under)\b/i.test(text) ||
    // "o3.5" / "u45.5" shorthand for over/under - the letter directly
    // touching the digit (no space) is what makes this a safe signal; a
    // stray "o" or "u" elsewhere in ordinary text never sits flush against a
    // number like this.
    /\bo\d+(\.\d+)?\b/i.test(text) ||
    /\bu\d+(\.\d+)?\b/i.test(text) ||
    /\b[NY]RFI\b/i.test(text) ||
    // A "Team vs Team" / "Team @ Team" matchup shape, even with no bet-type
    // keyword on the same line (e.g. the number is stated on a following
    // line) - two things named as opposing sides is itself a strong "this is
    // describing a game, not a person's name" signal, independent of whether
    // either side is a team this app actually has a nickname list for.
    /\b\w[\w'.-]*\s+(?:vs\.?|@)\s+\w/i.test(text)
  );
}

// Builds the word-boundary regex a multi-word team phrase ("red sox", "blue
// jays") is matched with, tolerating zero or more spaces between its words -
// a capper writing "RedSox" or "BlueJays" with no space at all is common
// enough (confirmed against real pasted text) that requiring at least one
// space (the old `\s+`) silently failed to match a real team name. `\s*`
// still requires the words to be flush against each other or separated by
// whitespace only, so it can't match across unrelated intervening text.
function teamPhraseRegex(phrase: string): RegExp {
  return new RegExp("\\b" + phrase.replace(/ /g, "\\s*") + "\\b", "i");
}

// Gates an inline capper-name prefix match (see the `inlineMatch` search
// below) - a known name is only accepted as the capper for this line if what
// immediately follows it (after the separator) itself starts with something
// pick-shaped, not merely CONTAINS a team/sport signal somewhere further in.
// Without this, a known capper name that's a literal prefix of a longer,
// not-yet-recognized capper name (e.g. saved "Sharp" vs. a freshly renamed
// "Sharp sheet") would silently swallow leftover name text ("sheet: 49ers
// ML" still resolves NFL via "49ers" even though "sheet:" is garbage) and
// misattribute the whole pick to the wrong, unrelated capper - a real
// data-corruption risk, not just a missed match. Deliberately anchored (^),
// unlike detectSport's own nickname fallback, which intentionally scans
// anywhere in text - that's safe there because it's only ever applied to
// text already known to have no leading capper-name ambiguity (a standalone
// pick line under an already-established header, or a remainder already
// confirmed to start immediately after a fully-consumed known name here).
function remainderStartsLikePick(remainder: string): boolean {
  const trimmed = remainder.trimStart();
  for (const code of KNOWN_SPORTS) {
    if (new RegExp("^" + code.replace(/ /g, "\\s+"), "i").test(trimmed)) return true;
  }
  for (const [phrase] of TEAM_SPORT_ENTRIES) {
    if (new RegExp("^" + phrase.replace(/ /g, "\\s*"), "i").test(trimmed)) return true;
  }
  return /^(ML\b|money\s*line|over\b|under\b|o\d|u\d|[+-]\d|[NY]RFI\b|total\b)/i.test(trimmed);
}

// allowNicknameFallback gates the second (fuzzy, team-nickname-only) branch -
// callers pass false right after a blank line, where a bare nickname match
// ("Tigers Kitchen") is far more likely to be a capper's name than a pick
// with no explicit sport code - UNLESS the line also looks unmistakably like
// a pick (see looksLikePick), in which case it's trusted even right after a
// blank. The explicit-code branch always stays on.
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
    if (teamPhraseRegex(phrase).test(lower)) {
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
    // Matches the unit number anywhere in the parenthetical, not just when
    // it's the ONLY thing there - cappers often tack on a same-parens tag
    // like "(10u POTD)" ("pick of the day"), which the old end-anchored
    // /u(nits?)?$/ pattern didn't tolerate (POTD isn't "u"), silently losing
    // the real unit size and defaulting to 1u instead.
    const unitMatch = val.match(/(\d+(?:\.\d+)?)\s*u(nits?)?\b/i);
    if (unitMatch) {
      units = parseFloat(unitMatch[1]);
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
  // FULL_GAME (graded/priced against the wrong, full-game score). Also
  // catches NFL's "1st half"/"first half" phrasing under this same flag -
  // the field is still named for baseball's F5 (its original use), but
  // Period.FIRST_HALF and the GameResult columns it reads (see grading.ts's
  // resolveOutcome) are already sport-generic, so NFL just reuses the same
  // flag rather than needing its own.
  const isFirstFive =
    /\bf5\b/i.test(cleanDescription) ||
    /\b1st\s*5\b/i.test(cleanDescription) ||
    /\bfirst\s*5\b/i.test(cleanDescription) ||
    /\b1st\s+five\b/i.test(cleanDescription) ||
    /\bfirst\s+five\b/i.test(cleanDescription) ||
    /\b1st\s*half\b/i.test(cleanDescription) ||
    /\bfirst\s*half\b/i.test(cleanDescription);

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
  } else if (parseTouchdownProp(cleanDescription)) {
    // Checked before the ML/spread/total keyword branches below - a
    // touchdown-prop pick ("Puka Nacua Anytime TD") has none of their
    // keywords and would otherwise silently fall through to the MONEYLINE
    // default. NFL touchdown props only (rushing/receiving/any) - not a
    // general player-prop parser; anything parseTouchdownProp doesn't
    // recognize as TD text still falls through unchanged (stays MONEYLINE
    // default for a bare player name, same as before - this app doesn't
    // support non-TD player props today).
    betType = "PLAYER_PROP";
  } else if (/\bML\b/i.test(cleanDescription) || /money\s*line/i.test(cleanDescription)) {
    betType = "MONEYLINE";
  } else if (/\bover\b/i.test(cleanDescription) || /\bo\d+(\.\d+)?\b/i.test(cleanDescription)) {
    betType = "TOTAL";
    totalSide = "over";
  } else if (/\bunder\b/i.test(cleanDescription) || /\bu\d+(\.\d+)?\b/i.test(cleanDescription)) {
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
  let matches = candidateSports.filter((sport) => {
    const patterns = SPORT_CONTEXT_SIGNALS[sport] ?? [];
    if (patterns.some((re) => re.test(text))) return true;
    if (sport === "MLB" && candidateSports.includes("NFL") && hasMlbTotalRangeSignal(text)) return true;
    return false;
  });
  // KBO uses the exact same betting vocabulary as MLB (ML, run line, NRFI,
  // F5) and has no terminology of its own in SPORT_CONTEXT_SIGNALS - so an
  // "MLB" match here doesn't actually discriminate against KBO the way it
  // discriminates against, say, NFL. Without this, a bare-nickname KBO pick
  // (e.g. "Tigers ML" meaning KIA Tigers) would silently resolve to MLB's
  // Detroit Tigers just because it used ordinary baseball wording - exactly
  // the wrong-silent-guess failure mode this whole hierarchy exists to avoid.
  if (matches.includes("MLB") && candidateSports.includes("KBO")) {
    matches = matches.filter((s) => s !== "MLB");
  }
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
    if (teamPhraseRegex(phrase).test(lower) && !found.includes(phrase)) found.push(phrase);
  }
  return found;
}

// Player-based (not team-based) picks - e.g. tennis moneylines like "Tallon
// Griekspoor ML". Checked only as a last resort, after every team-nickname
// and explicit-sport-code check above has already failed. This app has no
// live schedule/roster source for any individual-athlete sport (LIVE_SPORTS
// only covers team sports), so there's no table of every ATP/WTA/PGA player
// to match against the way TEAM_SPORT_ENTRIES matches teams - instead this
// extracts whatever capitalized name precedes a recognized bet keyword and
// treats it the same role a team nickname plays elsewhere (teamNicknames),
// keyed on just the LAST word so "Tallon Griekspoor" and a later, terser
// "Griekspoor" from a different capper both resolve to the same key and are
// treated as the same player/match once real schedule data exists to check
// against. Defaults sportName to ATP (tennis) - the only individual sport
// with real examples in this app's catalogs today, and there's no text
// signal here to distinguish it from WTA/PGA/etc when one isn't stated
// explicitly (e.g. a "WTA" or "PGA" code earlier in the same line).
// A short (<=3 letters), fully-uppercase word - "KT", "LG", "NC", "KIA",
// "SSG" - is how a team abbreviation is written, never how a real person's
// given name is written in these catalogs (always Title Case: "Tallon",
// "Al"). Confirmed against a real mistag: "KT Wiz ML" - no KBO team list
// existed yet for "KT Wiz" specifically, so it fell all the way through to
// findPlayerPick/findMatchupPlayerPick and was silently guessed as an ATP
// tennis player instead of surfacing in `unresolved` for manual review, the
// way every other not-yet-recognized team correctly does. This is a general
// gap, not specific to KBO or to "KT Wiz" - any not-yet-listed team from any
// sport whose name happens to fit "capitalized word(s) + ML/spread/total"
// hits the same false default, so the guard is name-shape-based rather than
// KBO-specific.
function looksLikeTeamAbbreviation(name: string): boolean {
  return name.split(/\s+/).some((w) => w.length <= 3 && w === w.toUpperCase());
}

function findPlayerPick(text: string): { playerName: string; playerKey: string } | null {
  const withoutParens = text.replace(/\([^)]*\)/g, "").trim();
  const mlMatch = withoutParens.match(/^(.+?)\s+(?:ML|money\s*line)\b/i);
  const spreadMatch = withoutParens.match(/^(.+?)\s+[+-]\d+(?:\.\d+)?\b/);
  const totalMatch = withoutParens.match(/^(.+?)\s+(?:over|under)\s+\d+(?:\.\d+)?\b/i);
  // Same "o3.5"/"u45.5" shorthand looksLikePick and parsePickText's betType
  // detection recognize - checked only as a fallback so the spelled-out form
  // above still wins when both are somehow present.
  const totalShorthandMatch = withoutParens.match(/^(.+?)\s+[ou]\d+(?:\.\d+)?\b/i);
  const nameMatch = mlMatch ?? spreadMatch ?? totalMatch ?? totalShorthandMatch;
  if (!nameMatch) return null;

  const candidate = nameMatch[1].trim();
  // Must actually look like a personal name - 1-4 capitalized words, no
  // digits - guards against matching arbitrary unresolved text that just
  // happens to be followed by "ML" or a number (e.g. a typo'd team name).
  if (!/^[A-Z][A-Za-z'.-]*(?:\s+[A-Z][A-Za-z'.-]*){0,3}$/.test(candidate)) return null;
  if (looksLikeTeamAbbreviation(candidate)) return null;

  const words = candidate.split(/\s+/);
  return { playerName: candidate, playerKey: words[words.length - 1].toLowerCase() };
}

// Two-name matchup version of findPlayerPick, for individual-vs-individual
// sports (MMA/boxing) where the pick states both sides directly ("Islam
// Makhachev vs. Ian Machado Garry Over 2 Rounds") rather than one
// competitor's name the way this app's tennis picks normally do
// ("Griekspoor ML") - findPlayerPick's single-name regex never matches text
// with a second name (and "vs.") in the middle, so a line like this
// otherwise falls through every branch. Checked before findPlayerPick
// wherever both are used. Defaults sportName to MMA (not ATP) - "vs" between
// two full names is this app's real signal for combat sports specifically;
// no tennis catalog seen here states both players this way.
function findMatchupPlayerPick(text: string): { players: [string, string]; playerKeys: [string, string] } | null {
  const withoutParens = text.replace(/\([^)]*\)/g, "").trim();
  const mlMatch = withoutParens.match(/^(.+?)\s+vs\.?\s+(.+?)\s+(?:ML|money\s*line)\b/i);
  const totalMatch = withoutParens.match(/^(.+?)\s+vs\.?\s+(.+?)\s+(?:over|under)\s+\d+(?:\.\d+)?\b/i);
  const spreadMatch = withoutParens.match(/^(.+?)\s+vs\.?\s+(.+?)\s+[+-]\d+(?:\.\d+)?\b/);
  const nameMatch = mlMatch ?? totalMatch ?? spreadMatch;
  if (!nameMatch) return null;

  // Requires at least TWO capitalized words per side (unlike findPlayerPick's
  // single-name version) - a bare single word like "Ottawa" or "Winnipeg"
  // trivially satisfies a 1-word name pattern too, which was misreading a
  // city-vs-city matchup ("Ottawa vs Winnipeg Over 56.5") as a fighter
  // matchup instead of leaving it unresolved. A real "vs" fight card always
  // names both people with at least a first+last name in these catalogs.
  const isPersonName = (s: string) =>
    /^[A-Z][A-Za-z'.-]*(?:\s+[A-Z][A-Za-z'.-]*){1,3}$/.test(s.trim()) && !looksLikeTeamAbbreviation(s.trim());
  const a = nameMatch[1].trim();
  const b = nameMatch[2].trim();
  if (!isPersonName(a) || !isPersonName(b)) return null;

  const lastWord = (s: string) => s.split(/\s+/).pop()!.toLowerCase();
  return { players: [a, b], playerKeys: [lastWord(a), lastWord(b)] };
}

export function findTeamNickname(text: string, sportName: string): string | undefined {
  const lower = text.toLowerCase();
  for (const [phrase, sport] of TEAM_SPORT_ENTRIES) {
    if (sport !== sportName) continue;
    if (teamPhraseRegex(phrase).test(lower)) return phrase;
  }
  return undefined;
}

// A won-loss record shape specifically ("19-0", "12-2", "8-1") - digits
// flush against both sides of the dash, no sign. Deliberately distinct from
// the generic signed-number signal in looksLikePick, which also matches a
// real spread/moneyline number ("-3.5", "+150") - those are always a bare
// sign directly before the digits, never digit-DASH-digit the way a record
// is. That narrower shape is what makes it safe to key a capper-tagline
// extraction off of - see extractCapperNameFromTagline below.
const RECORD_PATTERN = /\b\d+-\d+\b/;

// Same "looks like a real name" shape findPlayerPick uses for a bet's player
// name - 1 to 4 capitalized words, no digits.
const NAME_SHAPE = /^[A-Z][A-Za-z'.-]*(?:\s+[A-Z][A-Za-z'.-]*){0,3}$/;

// A capper announcing their own category-specific record ("Bambino 19-0
// NRFI Run", "Sharp Sam 12-2 ML Run", "Vegas John 8-1 ATS heater") trips
// looksLikePick via the very keyword it's meant to signal a REAL pick with
// (NRFI/ML/ATS/...) - a tagline and a real pick can legitimately use the
// exact same vocabulary, so the keyword alone can't tell them apart. A
// won-loss record can: a real pick's own numbers are always a spread/total
// line or an explicit moneyline price, never a bare "digit-dash-digit"
// won-loss shape, and a capper citing their own record is close to the only
// realistic source of that shape in catalog text. So this only fires when a
// record is actually present, and only extracts the name-shaped text before
// it - a genuinely unresolvable pick that merely happens to have a
// name-shaped lead-in before its keyword but no record at all (e.g. "Tokyo
// Giants NRFI" for a team this app doesn't track) has nothing here to key
// off of and correctly falls through to `unresolved` unchanged.
function extractCapperNameFromTagline(text: string): string | null {
  const match = text.match(RECORD_PATTERN);
  if (!match || match.index === undefined) return null;

  const lead = text.slice(0, match.index).trim();
  if (!lead || !NAME_SHAPE.test(lead)) return null;

  return lead;
}

export function parseCatalog(
  text: string,
  knownCapperNames: string[] = []
): { picks: ParsedPick[]; unresolved: string[] } {
  const sortedNames = [...knownCapperNames].sort((a, b) => b.length - a.length);
  const rawLines = text.split("\n").map((l) => l.trim());

  const results: ParsedPick[] = [];
  // Lines that look pick-shaped (looksLikePick) but couldn't be resolved to
  // any sport/team/player - these must NOT fall through to being read as a
  // capper name (see the final fallback below), since a misread name then
  // silently hijacks every real pick that follows it for the rest of the
  // paste. Surfaced separately so the caller can show them for manual
  // review instead of either losing them or corrupting attribution.
  const unresolved: string[] = [];
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
    // A raw prefix candidate (name + separator, no adjacency check yet) -
    // used below only to detect a rejected near-miss, never to attribute a
    // pick directly. Kept as a separate pass from the hardened search so the
    // near-miss signal survives even when the hardened search finds nothing.
    const rawPrefixCandidate = sortedNames.find((name) => {
      const nameLower = name.toLowerCase();
      return (
        lower === nameLower ||
        (lower.startsWith(nameLower) && /[\s:.-]/.test(line[name.length] ?? " "))
      );
    });
    const inlineMatch = sortedNames.find((name) => {
      const nameLower = name.toLowerCase();
      if (lower === nameLower) return true;
      if (!(lower.startsWith(nameLower) && /[\s:.-]/.test(line[name.length] ?? " "))) return false;
      const remainder = line.slice(name.length).replace(/^[\s:.-]+/, "").trim();
      return remainder === "" || remainderStartsLikePick(remainder);
    });
    // The raw scan found a name-prefix match that the hardened scan rejected -
    // the text right after the matched name doesn't itself look like a pick,
    // meaning this is very likely a longer, not-yet-recognized capper name
    // (e.g. a fresh rename) that happens to start with a shorter saved
    // capper's name, not that shorter capper's own pick. Don't let this fall
    // through to the generic capper-name/pick detection below - that would
    // either misattribute it to whatever `currentCapper` currently is, or
    // (if it looks pick-shaped) risk swallowing the leading name text into
    // the pick description. Surface it for manual review instead, same
    // treatment as any other line that looks like a pick but can't be
    // resolved with confidence.
    if (!inlineMatch && rawPrefixCandidate && looksLikePick(line)) {
      unresolved.push(line.replace(/^-\s*/, "").trim());
      continue;
    }

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
          continue;
        }

        const matchupPick = findMatchupPlayerPick(remainder);
        if (matchupPick) {
          const parsed = parsePickText(remainder);
          results.push({
            capperName: inlineMatch,
            sportName: "MMA",
            description: parsed.cleanDescription,
            betType: parsed.betType,
            odds: parsed.odds ?? -110,
            hasExplicitOdds: parsed.odds !== null,
            totalSide: parsed.totalSide,
            units: parsed.units,
            isFirstFive: parsed.isFirstFive,
            raw: line,
            teamNicknames: matchupPick.playerKeys,
          });
          continue;
        }

        const playerPick = findPlayerPick(remainder);
        if (playerPick) {
          const parsed = parsePickText(remainder);
          results.push({
            capperName: inlineMatch,
            sportName: "ATP",
            description: parsed.cleanDescription,
            betType: parsed.betType,
            odds: parsed.odds ?? -110,
            hasExplicitOdds: parsed.odds !== null,
            totalSide: parsed.totalSide,
            units: parsed.units,
            isFirstFive: parsed.isFirstFive,
            raw: line,
            teamNicknames: [playerPick.playerKey],
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

    // A boilerplate section label ("Full Card") - not a capper name, not a
    // pick. Skip entirely: currentCapper is left exactly as it was.
    if (isBoilerplateLabel(strippedText)) {
      continue;
    }

    const detected = detectSport(strippedText, !afterBlank || looksLikePick(strippedText));

    // A bare sport/league code with nothing else on the line ("KBO" as its
    // own sub-header under a capper's name) - detectSport found a code but
    // there's no team/bet-type info left in `rest` to build a real pick
    // from. Same treatment as a boilerplate label: skip entirely rather than
    // push a placeholder pick or (if the code fails to resolve here at all)
    // fall through and get misread as a fake capper name - confirmed against
    // a real "Porter Picks" / "KBO" / "Doosan Bears ML" catalog, where the
    // bare "KBO" sub-header wrongly overwrote "Porter Picks" as the active
    // capper before this check existed.
    if (detected.sportName && !detected.rest.trim()) {
      continue;
    }

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
    // entirely rather than risk misreading it as a pick, unless the line
    // unmistakably looks like a pick anyway (looksLikePick).
    if (!afterBlank || looksLikePick(strippedText)) {
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

      const matchupPick = findMatchupPlayerPick(strippedText);
      if (matchupPick) {
        const parsed = parsePickText(strippedText);
        results.push({
          capperName: currentCapper || "Unknown",
          sportName: "MMA",
          description: parsed.cleanDescription,
          betType: parsed.betType,
          odds: parsed.odds ?? -110,
          hasExplicitOdds: parsed.odds !== null,
          totalSide: parsed.totalSide,
          units: parsed.units,
          isFirstFive: parsed.isFirstFive,
          raw: strippedText,
          teamNicknames: matchupPick.playerKeys,
        });
        continue;
      }

      const playerPick = findPlayerPick(strippedText);
      if (playerPick) {
        const parsed = parsePickText(strippedText);
        results.push({
          capperName: currentCapper || "Unknown",
          sportName: "ATP",
          description: parsed.cleanDescription,
          betType: parsed.betType,
          odds: parsed.odds ?? -110,
          hasExplicitOdds: parsed.odds !== null,
          totalSide: parsed.totalSide,
          units: parsed.units,
          isFirstFive: parsed.isFirstFive,
          raw: strippedText,
          teamNicknames: [playerPick.playerKey],
        });
        continue;
      }

      // Looks unmistakably like a pick (bet keyword, matchup shape, etc.) but
      // nothing above could resolve its sport/team/player - do NOT fall
      // through to being read as a capper name (see the comment on
      // `unresolved` above for why that's actively harmful, not just a missed
      // pick), UNLESS this is actually a capper announcing their own
      // category-specific record (e.g. "Bambino 19-0 NRFI Run") - see
      // extractCapperNameFromTagline. Anything else that merely looks
      // pick-shaped is surfaced for manual review instead.
      if (looksLikePick(strippedText)) {
        const taglineName = extractCapperNameFromTagline(strippedText);
        if (taglineName) {
          const normalized = normalizeName(taglineName);
          const existingMatch = knownCapperNames.find((n) => normalizeName(n) === normalized);
          currentCapper = existingMatch ?? taglineName;
          continue;
        }

        unresolved.push(strippedText);
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

  return { picks: results, unresolved };
}
