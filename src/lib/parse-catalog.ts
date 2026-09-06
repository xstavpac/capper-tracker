import { normalizeName } from "@/lib/fuzzy-match";
import { parseTouchdownProp, pickPeriodFromText, type SegmentPeriod } from "@/lib/bet-line";

export type ParsedPick = {
  capperName: string;
  sportName: string;
  description: string;
  betType: "SPREAD" | "MONEYLINE" | "TOTAL" | "TEAM_TOTAL" | "PLAYER_PROP" | "NRFI";
  odds: number;
  hasExplicitOdds: boolean;
  totalSide?: "over" | "under";
  units: number;
  // Which slice of the game this pick is scoped to, derived from the text via
  // bet-line.ts's betScope - stored on Pick.period at import (see bulk-picks).
  // "FIRST_HALF" still doubles as MLB's F5. Was a bare isFirstFive boolean
  // before quarter/period grading existed.
  period: SegmentPeriod;
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

// Same idea as BOILERPLATE_LABELS above, but for the "Play of the Day" family
// of pick-highlight labels cappers paste directly under their name, before
// the actual pick line - confirmed real example: "Play of the Month" sitting
// between "Out of Line Bets" and its real pick "Lorenzo Musetti ML (6u)".
// Without this, "Play of the Month" fell through every other check (it
// doesn't look like a pick, so detectSport's nickname fallback and the
// pick-detection branches below are both gated off) all the way to the
// generic "unrecognized line -> new capper name" fallback at the bottom of
// the loop, silently overwriting currentCapper and misattributing every pick
// under it. Matched as a whole line (case-insensitive), same as
// isBoilerplateLabel, so it can't eat a real pick or name that merely
// contains one of these words.
const LABEL_LINE_PATTERN = /^(?:play|pick|lock)\s+of\s+the\s+(?:day|week|month|year)$|^best\s+bets?$/i;

function isBoilerplateLabel(text: string): boolean {
  const trimmed = text.toLowerCase().trim();
  return BOILERPLATE_LABELS.has(trimmed) || LABEL_LINE_PATTERN.test(trimmed);
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
// see AMBIGUOUS_NICKNAMES. "jets" is excluded too - it collides with NHL's
// Winnipeg Jets (confirmed a real, currently-tracked team, not hypothetical
// - see the "sport not tracked" grading-bug investigation), same treatment.
const NFL_TEAMS = [
  "falcons", "ravens", "bills", "bengals", "browns",
  "cowboys", "broncos", "packers", "texans", "colts", "jaguars",
  "chiefs", "raiders", "chargers", "rams", "dolphins", "vikings", "patriots",
  "saints", "steelers", "49ers", "niners", "seahawks",
  "buccaneers", "titans", "commanders",
];

// "jets" is deliberately excluded here - it's ambiguous with NFL's New York
// Jets (see AMBIGUOUS_NICKNAMES) and must fall through to that check instead
// of always resolving to whichever league's array happened to list it first.
// "Winnipeg Jets" is still reachable via DISAMBIGUATED_TEAMS. "coyotes" is
// kept even though the Arizona Coyotes relocated and rebranded to Utah
// Mammoth - a capper referencing old game history/props by the former name
// should still resolve, and "coyotes" doesn't collide with anything else.
const NHL_TEAMS = [
  "ducks", "coyotes", "bruins", "sabres", "flames", "hurricanes", "blackhawks",
  "avalanche", "blue jackets", "stars", "red wings", "oilers", "wild",
  "canadiens", "predators", "devils", "islanders", "senators", "flyers",
  "penguins", "sharks", "kraken", "blues", "lightning", "maple leafs",
  "canucks", "golden knights", "capitals", "mammoth",
];

// "liberty" deliberately excluded - it collides with NCAAF's Liberty Flames,
// and during the ~5 months WNBA and NCAAF seasons overlap a bare "Liberty"
// pick is far more often the Flames than the NY Liberty. Bare "Liberty"
// resolves via AMBIGUOUS_NICKNAMES (schedule-first hierarchy - see
// ambiguous-hierarchy.ts); "New York Liberty" typed in full resolves via
// DISAMBIGUATED_TEAMS below, and "Liberty Flames" via NCAAF pass 0.
const WNBA_TEAMS = [
  "dream", "sky", "sun", "fever", "aces", "mercury", "lynx",
  "valkyries", "wings", "mystics", "storm", "sparks", "fire", "tempo",
];

// "lions" deliberately excluded - BC Lions collides with NFL's Detroit Lions,
// same "let it fall through rather than always resolving to one sport"
// reasoning as cardinals/panthers/giants above. Bare "Lions" stays NFL/KBO-
// ambiguous; the city-qualified "BC Lions" resolves via DISAMBIGUATED_TEAMS
// below. Adding BC Lions as a third bare AMBIGUOUS_NICKNAMES option waits for
// CFL to gain real schedule data (LIVE_SPORTS + SPORT_SEASON_CONFIG at
// enable time) - until then there'd be no way to disambiguate it.
//
// "red blacks" (two words) is listed alongside "redblacks": The Odds API's
// spelling of the Ottawa team is unconfirmed (no Ottawa game in the slate
// during the CFL grading build) and could be either, and without the
// two-word form a pick written "Ottawa Red Blacks" mis-parses as a tennis
// player ("Blacks") - a real latent bug. Both forms resolve to CFL.
const CFL_TEAMS = [
  "redblacks", "red blacks", "blue bombers", "roughriders", "argonauts", "elks",
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
  // here (and from there to the schedule/season/pick-context hierarchy in
  // ambiguous-hierarchy.ts, or a manual choice) instead of silently
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
  // Confirmed a real, currently-tracked collision (not hypothetical) during
  // the "sport not tracked" grading-bug investigation - both are real teams
  // with real games in this app's own live odds data, and bare "jets" was
  // silently always resolving NFL regardless (NFL_TEAMS happened to be
  // spread into TEAM_SPORT_ENTRIES before NHL_TEAMS, and same-length entries
  // keep their original order in the length-sort).
  jets: [
    { label: "New York Jets (NFL)", sport: "NFL", nickname: "new york jets" },
    { label: "Winnipeg Jets (NHL)", sport: "NHL", nickname: "winnipeg jets" },
  ],
  // A city-only reference to a Boston team - three sports, told apart by the
  // schedule -> season -> pick-context hierarchy in ambiguous-hierarchy.ts,
  // same as every entry above. The only bare CITY name in this table (the rest
  // are shared nicknames): added because "Shark - Boston Over 7.5" (a Red Sox
  // total) was mistagging as a phantom ATP tennis pick - "boston" is in no
  // nickname list, so it fell all the way through to findPlayerPick. Boston is
  // the one metro where this resolves cleanly: one team per sport, and not an
  // NCAAF school name (unlike Miami/Washington/etc, which detectSport already
  // claims as NCAAF). Every OTHER bare city routes to `unresolved` instead -
  // see SPORTS_PLACE_NAMES near findPlayerPick.
  boston: [
    { label: "Boston Red Sox (MLB)", sport: "MLB", nickname: "red sox" },
    { label: "Boston Celtics (NBA)", sport: "NBA", nickname: "celtics" },
    { label: "Boston Bruins (NHL)", sport: "NHL", nickname: "bruins" },
  ],
  // "Trojans" is shared by two real, tracked FBS schools (USC, Troy) - a
  // bare "Trojans -22.5" was falling all the way through to the phantom-ATP
  // fallback (same failure mode SPORTS_PLACE_NAMES/findPlayerPick guard
  // against below), since NCAAF_SCHOOLS is deliberately keyed by school
  // name, never bare mascot (see its own header comment), so this nickname
  // was registered nowhere at all - unlike Tigers/Bears/Wildcats/etc, whose
  // NCAAF collisions were at least considered (see PART D(b) in the test
  // file). No text-based heuristic can pick USC vs Troy from the bare word
  // alone, so - same as every entry above - this surfaces for a manual
  // choice instead of guessing. "USC Trojans"/"Troy Trojans" (school name
  // stated) never reach here at all: detectSport's NCAAF pass already
  // resolves those confidently, and this table is only consulted after
  // detectSport fails to find a sport.
  //
  // `nickname` is the real, full team name (canonical ESPN suffix for the
  // NCAAF sides) - the disambiguation hierarchy's schedule check and
  // bulk-picks.ts's lookupGame both `endsWith`-match it against the live
  // schedule directly, no NCAAF_CANONICAL_SUFFIX round-trip needed. Same
  // shape as every other entry in this table (all use the full team name).
  trojans: [
    { label: "USC Trojans (NCAAF)", sport: "NCAAF", nickname: "usc trojans" },
    { label: "Troy Trojans (NCAAF)", sport: "NCAAF", nickname: "troy trojans" },
  ],
  // "Liberty" collides across two real, tracked, currently-in-season teams:
  // WNBA's New York Liberty and NCAAF's Liberty Flames. It used to resolve
  // silently to WNBA (WNBA_TEAMS was spread into TEAM_SPORT_ENTRIES first) -
  // a wrong-import risk for the ~5 months the seasons overlap, since a bare
  // "Liberty" pick in that window is far more often the Flames. Now it goes
  // through the schedule-first hierarchy (ambiguous-hierarchy.ts): whichever
  // one actually has a game resolves it, calendar season only as a
  // fallback, prompt only if both are genuinely playing. "Liberty Flames" /
  // "New York Liberty" typed in full still resolve directly (pass 0 /
  // DISAMBIGUATED_TEAMS).
  liberty: [
    { label: "New York Liberty (WNBA)", sport: "WNBA", nickname: "new york liberty" },
    { label: "Liberty Flames (NCAAF)", sport: "NCAAF", nickname: "liberty flames" },
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
  ["new york jets", "NFL"],
  ["ny jets", "NFL"],
  ["winnipeg jets", "NHL"],
  // "lions" is excluded from CFL_TEAMS (collides with Detroit Lions / Samsung
  // Lions), so the BC Lions need an explicit city-qualified entry to resolve
  // to CFL at all - same pattern as chicago bears / detroit lions above.
  ["bc lions", "CFL"],
  // "liberty" is removed from WNBA_TEAMS (collides with NCAAF's Liberty
  // Flames) - the full/city-qualified WNBA form needs its own entry, same
  // pattern as chicago bears / bc lions above. "Liberty Flames" resolves via
  // NCAAF pass 0 (its canonical), so only the WNBA side is listed here.
  ["new york liberty", "WNBA"],
  ["ny liberty", "WNBA"],
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

// NCAAF - all 138 FBS schools (every team in ESPN's group-80 roster for the
// current season, the exact same live feed getEspnScores/resolveGameForNickname
// resolve picks against). Originally a Power-4-plus-Notre-Dame curated 68 for
// the week-1 launch; widened to full FBS after a real capper's slate ("Porter
// PICKS") mixed Group-of-5 games in with Power-4 ones and the missing schools
// ("Hawaii +5.5", "UNLV -5.5", "Louisiana Tech -3") fell straight through to
// findPlayerPick's ATP tennis-phantom fallback - see the comment above
// looksLikeTeamAbbreviation and docs/resolver-team-gap-followups.md.
//
// Each entry is [school-name key, canonical ESPN displayName]. A school may
// have SEVERAL entries - one per spelling a capper realistically types
// (abbreviations like "fau"/"wku"/"umass", alternate forms like "appalachian
// state" alongside "app state", "louisiana monroe"/"ulm" alongside "ul
// monroe") - all pointing at the same canonical.
//
// Keyed by SCHOOL name, deliberately never by bare mascot - unlike every
// pro-sport list above, a bare college mascot is very often shared by many
// schools (Tigers: Auburn/LSU/Missouri/Clemson/Memphis; Bulldogs: Georgia/
// Miss State/Fresno State/Louisiana Tech; Aggies: Texas A&M/New Mexico State/
// Utah State; and so on) - and Ducks, Bruins, Cowboys, Raiders, Hurricanes,
// Cavaliers, Rebels, Cardinals, Panthers etc. each already resolve to an
// existing pro entry above. A school's own name has none of these problems.
// A bare mascot-only NCAAF pick ("Tigers ML", no school named) is left
// exactly as it was before NCAAF existed - the pre-existing pro/ambiguous
// resolution, or unresolved - never guessed at as any particular school.
//
// The canonical (second element) exists because resolveGameForNickname/
// resolveGameForTeams (odds.ts) match a nickname against the END of the real
// live-schedule team name via endsWith - a bare school name is a PREFIX of
// that name, not a suffix ("lsu" doesn't end "LSU Tigers"). It is the exact
// ESPN displayName, lowercased, so the endsWith is against the same string
// the score feed returns (keeping the "'" in "hawai'i rainbow warriors" and
// the "(oh)" in "miami (oh) redhawks"). NCAAF_CANONICAL_SUFFIX below exports
// the translation; its one call site is lookupGame in bulk-picks.ts, applied
// only for NCAAF.
//
// "liberty" collides with WNBA's New York Liberty. It's removed from
// WNBA_TEAMS and lives in AMBIGUOUS_NICKNAMES now: a bare "Liberty" pick
// runs the schedule-first hierarchy (whichever team actually has a game
// resolves it) instead of silently taking WNBA. It stays a KEY here (not
// removed the way cardinals/bears were from their lists) because it's still
// needed for two-team lines ("Liberty vs Sam Houston"), an explicit "NCAAF"
// code, and its own canonical ("Liberty Flames") in pass 0 - detectSport's
// pass 1/2 skip any phrase that is also an AMBIGUOUS_NICKNAMES key, so
// keeping it here doesn't let a bare "Liberty" resolve NCAAF directly.
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

  // ---- Group of 5 + the remaining independents (full-FBS widening) ----
  // American (AAC)
  ["army", "army black knights"],
  ["charlotte", "charlotte 49ers"],
  ["east carolina", "east carolina pirates"], ["ecu", "east carolina pirates"],
  ["florida atlantic", "florida atlantic owls"], ["fau", "florida atlantic owls"],
  ["memphis", "memphis tigers"],
  ["navy", "navy midshipmen"],
  ["north texas", "north texas mean green"],
  ["rice", "rice owls"],
  ["south florida", "south florida bulls"], ["usf", "south florida bulls"],
  ["temple", "temple owls"],
  ["tulane", "tulane green wave"],
  ["tulsa", "tulsa golden hurricane"],
  ["uab", "uab blazers"],
  ["utsa", "utsa roadrunners"],
  // Conference USA
  ["delaware", "delaware blue hens"],
  ["florida international", "florida international panthers"], ["fiu", "florida international panthers"],
  ["jacksonville state", "jacksonville state gamecocks"],
  ["kennesaw state", "kennesaw state owls"],
  ["liberty", "liberty flames"],
  ["middle tennessee", "middle tennessee blue raiders"], ["mtsu", "middle tennessee blue raiders"], ["middle tennessee state", "middle tennessee blue raiders"],
  ["missouri state", "missouri state bears"],
  ["new mexico state", "new mexico state aggies"],
  ["sam houston", "sam houston bearkats"], ["sam houston state", "sam houston bearkats"],
  ["western kentucky", "western kentucky hilltoppers"], ["wku", "western kentucky hilltoppers"],
  // MAC
  ["akron", "akron zips"],
  ["ball state", "ball state cardinals"],
  ["bowling green", "bowling green falcons"],
  ["buffalo", "buffalo bulls"],
  ["central michigan", "central michigan chippewas"], ["cmu", "central michigan chippewas"],
  ["eastern michigan", "eastern michigan eagles"], ["emu", "eastern michigan eagles"],
  ["kent state", "kent state golden flashes"],
  ["massachusetts", "massachusetts minutemen"], ["umass", "massachusetts minutemen"],
  ["miami (oh)", "miami (oh) redhawks"], ["miami oh", "miami (oh) redhawks"], ["miami ohio", "miami (oh) redhawks"], ["miami, oh", "miami (oh) redhawks"], ["miami, ohio", "miami (oh) redhawks"],
  ["ohio", "ohio bobcats"],
  ["sacramento state", "sacramento state hornets"],
  ["toledo", "toledo rockets"],
  ["western michigan", "western michigan broncos"], ["wmu", "western michigan broncos"],
  // Mountain West
  ["air force", "air force falcons"],
  ["hawaii", "hawai'i rainbow warriors"],
  ["nevada", "nevada wolf pack"],
  ["new mexico", "new mexico lobos"],
  ["north dakota state", "north dakota state bison"],
  ["northern illinois", "northern illinois huskies"],
  ["san jose state", "san josé state spartans"], ["san jose st", "san josé state spartans"],
  ["unlv", "unlv rebels"],
  ["utep", "utep miners"],
  ["wyoming", "wyoming cowboys"],
  // Pac-12
  ["boise state", "boise state broncos"],
  ["colorado state", "colorado state rams"],
  ["fresno state", "fresno state bulldogs"],
  ["oregon state", "oregon state beavers"],
  ["san diego state", "san diego state aztecs"],
  ["texas state", "texas state bobcats"],
  ["utah state", "utah state aggies"],
  ["washington state", "washington state cougars"],
  // Sun Belt
  ["app state", "app state mountaineers"], ["appalachian state", "app state mountaineers"],
  ["arkansas state", "arkansas state red wolves"],
  ["coastal carolina", "coastal carolina chanticleers"],
  ["georgia southern", "georgia southern eagles"],
  ["georgia state", "georgia state panthers"],
  ["james madison", "james madison dukes"], ["jmu", "james madison dukes"],
  ["louisiana", "louisiana ragin' cajuns"], ["louisiana lafayette", "louisiana ragin' cajuns"], ["ul lafayette", "louisiana ragin' cajuns"], ["ragin cajuns", "louisiana ragin' cajuns"],
  ["louisiana tech", "louisiana tech bulldogs"], ["la tech", "louisiana tech bulldogs"],
  ["marshall", "marshall thundering herd"],
  ["old dominion", "old dominion monarchs"],
  ["south alabama", "south alabama jaguars"],
  ["southern miss", "southern miss golden eagles"], ["southern mississippi", "southern miss golden eagles"],
  ["troy", "troy trojans"],
  ["ul monroe", "ul monroe warhawks"], ["louisiana monroe", "ul monroe warhawks"], ["ulm", "ul monroe warhawks"], ["la monroe", "ul monroe warhawks"],
  // Independent (non-Notre Dame)
  ["uconn", "uconn huskies"], ["connecticut", "uconn huskies"],

  // ---- FCS schools that appear on ESPN's FBS scoreboard by virtue of
  // playing an FBS opponent (a "money game"). docs/resolver-team-gap-
  // followups.md #3 is about all-FCS games, which are in NEITHER feed - an
  // FCS-vs-FBS game IS on ESPN's college-football scoreboard (it's the FBS
  // team's game), so the FCS side just needs to be a resolvable name.
  // Currently only the one confirmed in a real rejected import; the ~30
  // other FCS money-game opponents on a given Saturday have the same gap
  // and can be added the same way. NOTE: the canonical (2nd element) must
  // exactly match ESPN's team.displayName for the live endsWith match to
  // work - "Tennessee State Tigers" is the expected form but was not
  // verifiable from the dev environment (ESPN API is IP-blocked here);
  // worth a real-import spot check.
  ["tennessee state", "tennessee state tigers"],
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

// Folds diacritics and drops apostrophes/periods for the pick-grouping match
// ONLY (pick-team-group.ts) - the same NFD + combining-mark strip that
// team-name-match.ts's normalizeTeamName uses for cross-source team matching,
// plus apostrophes, so an accented / punctuated live-schedule name lines up
// with its plain-ascii nickname keys: "Hawai'i Rainbow Warriors" -> "hawaii
// rainbow warriors" matches the key "hawaii", "San José State Spartans" ->
// "san jose state spartans" matches "san jose state". Without this,
// findGroupingNickname returned undefined for those teams and every one of
// their picks fell through to "Totals & other markets". NOT used by the
// import parser (detectSport/findTeamNickname/parseCatalog).
export function normalizeForGrouping(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/['’.]/g, "")
    .toLowerCase();
}

// Given a live-schedule team's full name (e.g. "Minnesota Twins") and its
// already-known sport, returns the short nickname a capper actually types
// for it (e.g. "twins") - see GROUPING_TEAM_NICKNAMES above for why this is
// a separate function from findTeamNickname rather than a shared one.
export function findGroupingNickname(text: string, sportName: string): string | undefined {
  const lower = normalizeForGrouping(text);
  for (const [phrase, sport] of GROUPING_TEAM_NICKNAMES) {
    if (sport !== sportName) continue;
    if (teamPhraseRegex(phrase).test(lower)) return phrase;
  }
  return undefined;
}

// Every short alias a capper might realistically type for a live-schedule
// team, for pick-team-group.ts's betDetail matching. For NCAAF - where one
// school has several NCAAF_SCHOOLS keys ("fiu"/"florida international",
// "emu"/"eastern michigan", "connecticut"/"uconn") all pointing at one
// canonical ESPN name - this returns the WHOLE set, so a pick written with
// any of them groups under the right team header instead of the single
// nickname findGroupingNickname happens to derive from the schedule name.
// Every other sport keeps that single bare nickname: MLB/NFL/NBA/NHL/WNBA
// nicknames are bare mascots that don't have this many-aliases-per-team
// problem (the Twins/Tigers/Bears collisions are cross-SPORT, one nickname
// each - see GROUPING_TEAM_NICKNAMES).
export function teamGroupAliases(teamDisplayName: string, sportName: string): string[] {
  const primary = findGroupingNickname(teamDisplayName, sportName);
  if (!primary) return [];
  if (sportName !== "NCAAF") return [primary];
  const canonical = NCAAF_CANONICAL_SUFFIX[primary];
  if (!canonical) return [primary];
  return NCAAF_SCHOOLS.filter(([, c]) => c === canonical).map(([key]) => key);
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
//
// Regex metacharacters in the phrase are escaped first, so "Miami (OH)"
// matches a literal "(OH)" (not a capture group) and "St." matches a literal
// dot (not any char - a latent bug the old `\b...\b` form had for the one
// "st. louis cardinals" entry). Anchors are `(?<!\w) / (?!\w)` rather than
// `\b` so a phrase that ends in a non-word char - "miami (oh)" ends in ")" -
// still anchors correctly; for phrases that begin and end with letters
// (every other entry) these are exactly equivalent to `\b`.
export function teamPhraseRegex(phrase: string): RegExp {
  const body = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s*");
  return new RegExp("(?<!\\w)" + body + "(?!\\w)", "i");
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

  // Pass 0 (canonical NCAAF full name): a school's OWN real mascot appearing
  // right after its name ("Oregon Ducks", "Duke Blue Devils", "Arizona
  // State Sun Devils") is stronger, more specific evidence than either word
  // matched alone - checked first so it can't be shadowed by (or itself
  // shadow) some unrelated single-word entry on either side. Several of
  // these mascots are, by this file's own design, already claimed bare by
  // an NFL/NBA/NHL entry (see the NCAAF_SCHOOLS comment) - e.g. "bruins"
  // is longer than "ucla" and would otherwise win the length-sorted pass 1
  // below outright before "ucla" is ever even reached. NCAAF_CANONICAL_SUFFIX
  // (already used elsewhere for this exact prefix-vs-suffix mismatch) is
  // checked uniformly for all 68 schools; nothing team-specific is hardcoded.
  for (const [school, canonical] of NCAAF_SCHOOLS) {
    const match = teamPhraseRegex(canonical).exec(lower);
    if (!match) continue;

    // Guard against a DIFFERENT, shorter school name that's actually just
    // the trailing word of a longer one also in this list ("West Virginia"
    // contains "Virginia" as a whole word) - without this, "West Virginia
    // Cavaliers" would match Virginia's own canonical "Virginia Cavaliers"
    // embedded inside it, even though West Virginia (Mountaineers) has
    // nothing to do with Virginia (Cavaliers). Checked uniformly against
    // all 68 schools, not just this one pair - only the school that's
    // genuinely the LONGEST match starting at this exact word boundary is
    // allowed to claim it.
    const schoolEnd = match.index + school.length;
    const shadowedByLongerSchool = NCAAF_SCHOOLS.some(([otherSchool]) => {
      if (otherSchool.length <= school.length || !otherSchool.endsWith(school)) return false;
      const body = otherSchool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s*");
      return new RegExp("(?<!\\w)" + body + "$").test(lower.slice(0, schoolEnd));
    });
    if (shadowedByLongerSchool) continue;

    return { sportName: "NCAAF", rest: text };
  }

  // Pass 1 (exact): a match only counts here if nothing immediately after
  // it is ALSO a recognized team entry - i.e. it isn't sitting in front of
  // a different, more specific team match. This is what lets a real mascot
  // ("Washington Mystics" -> WNBA's "mystics") win over an NCAAF school
  // name that happens to precede it ("washington" -> Washington Huskies)
  // when pass 0 didn't already resolve it via the school's OWN mascot:
  // NCAAF_SCHOOLS is deliberately keyed by school name, which is always a
  // PREFIX of the live team name (see its comment above), never a suffix -
  // so a school-name match is structurally the only kind that can
  // legitimately have another sport's real match trailing it. Nothing here
  // names any specific team; it falls out of adjacency between two
  // independently-matching TEAM_SPORT_ENTRIES.
  //
  // A phrase that is also a bare AMBIGUOUS_NICKNAMES key ("liberty" - a real
  // NCAAF school key AND the WNBA nickname) is skipped in both passes below:
  // resolving it here to whichever sport happens to be listed first is
  // exactly the silent-wrong-guess the ambiguous hierarchy exists to
  // prevent. Falling through leaves detectSport with no sport, which routes
  // it to findAmbiguousNickname. (Every other AMBIGUOUS_NICKNAMES key -
  // cardinals, bears, boston, ... - is already absent from the team lists,
  // so this guard is a no-op for them; it only matters for keys that must
  // stay in a team list for a DIFFERENT reason, like "liberty" staying in
  // NCAAF_TEAMS so two-team lines and the canonical still resolve.)
  for (const entry of TEAM_SPORT_ENTRIES) {
    const phrase = entry[0];
    const sport = entry[1];
    if (AMBIGUOUS_NICKNAMES[phrase]) continue;
    const match = teamPhraseRegex(phrase).exec(lower);
    if (!match) continue;
    const after = lower.slice(match.index + match[0].length);
    const followedByAnotherTeam = TEAM_SPORT_ENTRIES.some(
      ([otherPhrase]) => otherPhrase !== phrase && teamPhraseRegex(otherPhrase).test(after)
    );
    if (!followedByAnotherTeam) {
      return { sportName: sport, rest: text };
    }
  }

  // Pass 2 (fallback): the original longest-first substring/word search.
  // Provably unreachable when pass 1 finds any match at all - the
  // rightmost-starting match in the text can never have another match
  // trailing it, so pass 1 always resolves whenever pass 2 would - but kept
  // explicit as a safety net rather than relying on that proof staying true
  // through future edits.
  for (const entry of TEAM_SPORT_ENTRIES) {
    const phrase = entry[0];
    const sport = entry[1];
    if (AMBIGUOUS_NICKNAMES[phrase]) continue;
    if (teamPhraseRegex(phrase).test(lower)) {
      return { sportName: sport, rest: text };
    }
  }

  return { sportName: "", rest: text };
}

// Explicit, safe-only signals that a total is about ONE team's own score
// (TEAM_TOTAL), not the combined game total - the literal "team total"
// phrase, or the standalone "TT" shorthand real cappers use ("Twins TT
// o5.5 -125"). Deliberately does NOT infer team-total from a team name
// merely being present in the text - a real game total's text often names a
// team too, just to identify the game ("Dodgers/Padres Over 8.5"), not as
// the bet's actual subject - confirmed unreliable during the Team Total
// investigation. "TT" is matched as its own word only (never a substring of
// another word like "MATT"/"ATTACK"), same word-boundary care as the
// o3.5/u45.5 shorthand below. Only ever called from within a branch that has
// already matched an over/under/total keyword (see parsePickText), so a
// bare "TT" with no total signal at all (e.g. a capper's own initials) can
// never misclassify an otherwise-MONEYLINE pick.
function isTeamTotalText(text: string): boolean {
  return /\bteam\s*total\b/i.test(text) || /\bTT\b/i.test(text);
}

function parsePickText(description: string): {
  betType: ParsedPick["betType"];
  odds: number | null;
  units: number;
  period: SegmentPeriod;
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
  // Which slice of the game this pick is scoped to: F5 / first half (both map
  // to FIRST_HALF), second half, an individual quarter (NFL/NBA/WNBA/NCAAF),
  // or an individual period (NHL). One shared classifier (bet-line.ts) so the
  // importer and grading.ts can never disagree on what "Q1" / "1st half" /
  // "P2" means. A segment the grader has no score source for at all (a lone
  // inning outside MLB's F5 path) collapses to FULL_GAME here and is declined
  // later in grading, not graded against the full-game score.
  const period = pickPeriodFromText(cleanDescription);

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
    betType = isTeamTotalText(cleanDescription) ? "TEAM_TOTAL" : "TOTAL";
    totalSide = "over";
  } else if (/\bunder\b/i.test(cleanDescription) || /\bu\d+(\.\d+)?\b/i.test(cleanDescription)) {
    betType = isTeamTotalText(cleanDescription) ? "TEAM_TOTAL" : "TOTAL";
    totalSide = "under";
  } else if (/\btotal\b/i.test(cleanDescription)) {
    betType = isTeamTotalText(cleanDescription) ? "TEAM_TOTAL" : "TOTAL";
  } else if (hasExplicitSpreadNumber || hasSpreadKeyword) {
    betType = "SPREAD";
  }

  return { betType, odds, units: units ?? 1, period, cleanDescription, totalSide };
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
    period: parsed.period,
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
// auto-resolution pipeline (ambiguous-hierarchy.ts) can enumerate
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

// The pick-context step of the disambiguation hierarchy (see
// ambiguous-hierarchy.ts), reached only after the schedule and calendar
// steps both come back inconclusive - supporting evidence only. Returns a
// single sport only when exactly one
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

// Words that can legitimately sit right after a team name in a pick - bet
// types, sides, periods, matchup joiners. Used by the NCAAF prefix-match
// guard in findTeamNicknames: a capitalized word after a school name that is
// NOT one of these (and not part of the school's own name) means the capper
// typed a longer school name we only prefix-matched.
const NCAAF_TRAILING_TOKEN_OK =
  /^(ml|moneyline|money|line|pk|pick|tt|f5|ats|vs|v|at|over|under|o|u|spread|spreads|total|totals|runline|puckline|first|second|1h|2h|1q|2q|3q|4q|half|reg|alt|team)$/i;

// Generic words that formalize a school's name without changing which
// school it is - "West Virginia University", "Miami College". The NCAAF
// prefix-match guard in findTeamNicknames strips these rather than reading
// them as evidence of a DIFFERENT, longer school ("North Carolina A&T").
const INSTITUTIONAL_SUFFIX = /^(university|college|univ)$/i;

// Returns every distinct team nickname found in the text, longest-match-first
// (matches the order TEAM_SPORT_ENTRIES is sorted in). Lets a caller pin an
// exact matchup when a pick names both teams, e.g. "Dodgers Cubs under 8.5".
//
// A phrase whose match sits entirely inside a longer phrase's match at the
// same spot ("tennessee" inside "middle tennessee", "virginia" inside "west
// virginia", "new mexico" inside "new mexico state", "florida" inside
// "florida state") is dropped - it's the same one team named once, not a
// second opponent, and lookupGame (bulk-picks.ts) would otherwise read the
// two as a matchup and fail to resolve either. A genuine two-team pick names
// the sides in non-overlapping spans, so both survive.
export function findTeamNicknames(text: string, sportName: string): string[] {
  const lower = text.toLowerCase();
  const hits: { phrase: string; start: number; end: number }[] = [];
  for (const [phrase, sport] of TEAM_SPORT_ENTRIES) {
    if (sport !== sportName) continue;
    const m = teamPhraseRegex(phrase).exec(lower);
    if (m && !hits.some((h) => h.phrase === phrase)) {
      hits.push({ phrase, start: m.index, end: m.index + m[0].length });
    }
  }
  const kept = hits.filter(
    (h) =>
      !hits.some(
        (o) => o !== h && o.start <= h.start && o.end >= h.end && o.end - o.start > h.end - h.start
      )
  );

  // NCAAF school keys are a PREFIX of the real team name (see NCAAF_SCHOOLS),
  // so a bare "north carolina" match is just as likely the front of a school
  // we DON'T list - "North Carolina A&T", "North Carolina Central" (both
  // FCS). When exactly one school matched and the next word in the text is
  // capitalized, is not part of that school's own name, and is not a bet
  // keyword, the capper named a different school we only prefix-matched -
  // drop it so the pick surfaces as "couldn't match, add manually" instead
  // of being silently attached to the listed school's game. Only the
  // one-match case is guarded: a genuine two-team line ("North Carolina vs
  // Clemson") is left alone.
  if (sportName === "NCAAF" && kept.length === 1) {
    const only = kept[0];
    const after = text.slice(only.end).replace(/^[\s.:-]+/, "");
    const nextWord = after.match(/^([A-Za-z][A-Za-z&.'-]*)/)?.[1];
    if (nextWord && !NCAAF_TRAILING_TOKEN_OK.test(nextWord)) {
      const nextLower = nextWord.toLowerCase();
      // (a) The prefix-match is actually the front of a longer school we DO
      // list ("Tennessee" -> "Tennessee State", "Ohio" -> "Ohio State") -
      // resolve to that fuller school rather than dropping. Checked against
      // the real canonical list, so it only fires for schools genuinely in
      // it.
      const combined = only.phrase + " " + nextLower;
      if (NCAAF_CANONICAL_SUFFIX[combined]) return [combined];
      // (b) A generic institutional suffix ("West Virginia University") is
      // just the same school written formally - keep the match.
      if (INSTITUTIONAL_SUFFIX.test(nextWord)) return kept.map((h) => h.phrase);
      // Otherwise: a longer school we DON'T list ("North Carolina A&T",
      // "Tennessee Tech") - drop it so the pick surfaces for manual review
      // rather than being silently attached to the listed school's game.
      const canonical = NCAAF_CANONICAL_SUFFIX[only.phrase] ?? only.phrase;
      if (!canonical.includes(nextLower)) return [];
    }
  }

  return kept.map((h) => h.phrase);
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
//
// TODO(follow-up, not urgent): the abbreviation guard above narrows this gap
// but doesn't close it - a real, currently-tracked team whose bare name is
// plain Title Case (not a short all-caps abbreviation) still falls all the
// way through to this ATP default with no warning. Confirmed again during
// the "sport not tracked" grading-bug investigation: "Fire over 165.5"
// (Portland Fire, a real WNBA team) mistagged ATP the same way "KT Wiz" once
// did, purely because "fire" wasn't yet in WNBA_TEAMS - same for "Sparks"/
// "Tempo" (WNBA) and "Mammoth" (NHL) at the same time. All four are fixed
// now (see WNBA_TEAMS/NHL_TEAMS above), but the underlying failure mode -
// any future missing team silently mistagging as a confident ATP pick
// instead of surfacing as `unresolved` - is still there by design.
//
// Proposed fix (real architectural work, not a quick patch, hence not done
// here): before accepting an ATP match, check the candidate word against the
// real, currently-tracked team names this app already caches (OddsSnapshot/
// GameResult) - the same real-data cross-check used to find the four gaps
// above. If the candidate is a substring of any real, currently-known team
// name across any tracked sport, refuse the ATP fallback and report the
// line as unresolved with a pointed reason ("looks like a team name we
// don't recognize yet") instead of guessing. This must NOT just require 2+
// capitalized words instead - real ATP picks are commonly typed as a bare
// surname ("Djokovic ML"), so tightening the name-shape check alone would
// fix this gap by breaking legitimate tennis picks instead.
// The real cost: parse-catalog.ts is a pure, synchronous, DB-free module
// today - this guard needs a "known real team names" set threaded in from
// whichever caller already has DB access (the bulk-import server action),
// which is a real signature/architecture change to this file, not a small
// patch alongside it.
function looksLikeTeamAbbreviation(name: string): boolean {
  return name.split(/\s+/).some((w) => w.length <= 3 && w === w.toUpperCase());
}

// Place names that are the locality of a tracked pro franchise (MLB / NBA /
// NFL / NHL / WNBA / CFL). A bare one of these reaching findPlayerPick means a
// capper wrote a city/state/region with no nickname and nothing above could
// resolve it - route it to `unresolved` ("add manually") rather than silently
// inventing a tennis player named after the place. This is the general guard
// against the phantom-ATP fallback (see the long TODO above and
// docs/resolver-team-gap-followups.md #1); "Sharp Sheet - Ottawa +7.5" (a CFL
// pick) and "Shark - Boston Over 7.5" were both hitting it.
//
// Short all-caps abbreviations ("LA", "NY", "SF", "KC", "GB") are already
// rejected by looksLikeTeamAbbreviation, so this only needs spelled-out forms
// (plus "nola", 4 letters, which slips past that check). Many entries here
// (arizona, miami, washington, ...) are also NCAAF school keys that detectSport
// claims first - listing them is redundant-but-safe defense if that list ever
// changes. "boston" is deliberately ABSENT: it has an AMBIGUOUS_NICKNAMES
// entry checked earlier, so it never reaches here.
const SPORTS_PLACE_NAMES = new Set<string>([
  "anaheim", "arizona", "atlanta", "baltimore", "brooklyn", "buffalo",
  "calgary", "carolina", "charlotte", "chicago", "cincinnati", "cleveland",
  "colorado", "columbus", "dallas", "denver", "detroit", "edmonton",
  "golden state", "green bay", "hamilton", "houston", "indiana", "indianapolis",
  "jacksonville", "kansas city", "las vegas", "los angeles", "memphis", "miami",
  "milwaukee", "minnesota", "montreal", "nashville", "new england",
  "new orleans", "new york", "oklahoma city", "orlando", "ottawa",
  "philadelphia", "phoenix", "pittsburgh", "portland", "sacramento",
  "san antonio", "san diego", "san francisco", "san jose", "saskatchewan",
  "seattle", "st louis", "st. louis", "tampa", "tampa bay", "tennessee",
  "toronto", "utah", "vancouver", "vegas", "washington", "winnipeg", "nola",
]);

// Real FCS college football schools, confirmed hitting the exact same
// phantom-ATP fallback as SPORTS_PLACE_NAMES guards against above (a bare
// Title Case school name before a spread/ML/total reads as a tennis
// player's surname). Unlike SPORTS_PLACE_NAMES this isn't a pro-franchise
// locality - it's a real team name with nowhere to go: both of this app's
// NCAAF sources (ESPN's scoreboard, The Odds API) are FBS-only upstream
// (docs/resolver-team-gap-followups.md #3), so adding these to
// NCAAF_SCHOOLS would not make them resolvable to a real game - there is
// no live schedule/odds data for an FCS game to match against. Routing to
// `unresolved` ("add manually") instead of a false ATP tag is the fix here,
// not adding these to a team list that can't actually grade them.
//
// This list is NOT a general "every FCS school" registry - it's the
// specific instances confirmed in a real capper's rejected batch (2026-09).
// A future FCS name hitting this same fallback is the same still-open,
// deprioritized gap this file's long TODO above describes; add it here as
// found, the same way SPORTS_PLACE_NAMES/AMBIGUOUS_NICKNAMES grew.
const KNOWN_OUT_OF_SCOPE_SCHOOLS = new Set<string>([
  "merrimack", "albany", "samford", "lindenwood",
]);

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
  if (SPORTS_PLACE_NAMES.has(candidate.toLowerCase())) return null;
  if (KNOWN_OUT_OF_SCOPE_SCHOOLS.has(candidate.toLowerCase())) return null;

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
// Strips a leading emoji/symbol prefix the same way the generic "unrecognized
// line -> new capper name" fallback at the bottom of parseCatalog's loop
// already does (line.replace(/^[^\w]+/, "")) - cappers commonly prefix their
// section header with an emoji ("⚾ Bambino Bets"), and without stripping it
// here first, NAME_SHAPE (anchored on a leading [A-Z]) would reject the name
// outright.
function stripLeadingSymbols(text: string): string {
  return text.replace(/^[^\w]+/, "").trim();
}

function extractCapperNameFromTagline(text: string): string | null {
  const match = text.match(RECORD_PATTERN);
  if (!match || match.index === undefined) return null;

  const lead = stripLeadingSymbols(text.slice(0, match.index));
  if (lead && NAME_SHAPE.test(lead)) return lead;

  // The record can also sit inside a trailing parenthetical AFTER the name,
  // rather than directly after it with no parens ("Bambino Bets (24-6 NRFI
  // Run)" vs "Bambino 19-0 NRFI Run") - confirmed real example. When the
  // record match falls inside a "(...)" that runs to the end of the line,
  // the name is everything before that parenthetical, not everything before
  // the record itself (which would wrongly include the open paren).
  const trailingParen = text.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (trailingParen && RECORD_PATTERN.test(trailingParen[2])) {
    const parenLead = stripLeadingSymbols(trailingParen[1]);
    if (parenLead && NAME_SHAPE.test(parenLead)) return parenLead;
  }

  return null;
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
            period: parsed.period,
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
            period: "FULL_GAME",
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
            period: parsed.period,
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
            period: parsed.period,
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
        period: parsed.period,
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
        period: parsed.period,
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
          period: parsed.period,
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
          period: "FULL_GAME",
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
          period: parsed.period,
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
          period: parsed.period,
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
