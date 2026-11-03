// Men's Division I basketball schools for catalog import, built from the
// generated ESPN list (scripts/generate-college-teams.mjs). Pure and static: no
// network, no DB, nothing read at parse time.
//
// A school falls in one of two groups, by ESPN team id:
//   - football: null - basketball-only ("Gonzaga -5"). The line is NCAAB.
//   - football: "FBS" | "FCS" - shared with NCAAF ("Duke -4.5", "Grambling ML").
//     Which league it means is the disambiguation hierarchy's question, see
//     promoteSharedCollegePick in parse-catalog.ts.
// FCS schools count as shared even though NCAAF_SCHOOLS doesn't list them:
// they play on the NCAAF feed (feed-teams.ts), so a September "Grambling +14" is
// football and must keep resolving that way.
//
// Same rule as NCAAF_SCHOOLS: keyed by SCHOOL, never by bare mascot. Twenty
// schools are the Wildcats, and "Bulls" / "Kings" / "Hawks" already read as pro
// teams.
import { NCAAB_D1_TEAMS, type GeneratedCollegeTeam } from "@/lib/generated/college-teams.generated";
import type { FeedTeam } from "@/lib/feed-teams";

// Shorthand a capper types for one school, keyed by ESPN `location`. Only spellings
// keyRegex doesn't already cover: "State" also reads "St" / "St.", a trailing
// period and an apostrophe are optional, and ESPN's own short form is always a key.
// Anything naming more than one school belongs in NCAAB_ALIAS_CONFLICTS instead.
const NCAAB_ALIASES: Record<string, string[]> = {
  // Basketball-only
  "American University": ["american u"],
  "Boston University": ["boston univ"],
  "Cal State Bakersfield": ["csub"],
  "Cal State Fullerton": ["csuf", "cs fullerton"],
  "Cal State Northridge": ["csun", "northridge", "cs northridge"],
  "California Baptist": ["cal baptist", "cbu"],
  Charleston: ["college of charleston", "cofc"],
  "Detroit Mercy": ["udm"],
  "George Mason": ["gmu"],
  "George Washington": ["gw", "gwu", "g. washington"],
  Gonzaga: ["zags"],
  "Grand Canyon": ["gcu"],
  "Green Bay": ["uw green bay", "uwgb"],
  "IU Indianapolis": ["iupui", "iu indianapolis"],
  "Kansas City": ["umkc"],
  "La Salle": ["lasalle"],
  "Le Moyne": ["lemoyne"],
  "Little Rock": ["ualr", "arkansas little rock"],
  "Long Beach State": ["lbsu", "long beach"],
  "Long Island University": ["liu"],
  "Loyola Chicago": ["loyola il", "loyola (il)", "loyola-chicago"],
  "Loyola Maryland": ["loyola (md)"],
  "Loyola Marymount": ["loyola-marymount"],
  "LSU New Orleans": ["new orleans", "uno"],
  "Maryland Eastern Shore": ["umes"],
  Milwaukee: ["uw milwaukee", "uwm"],
  "Mount St. Mary's": ["mt st mary's", "mt. st. mary's", "mount saint mary's"],
  "North Florida": ["unf"],
  "Northern Kentucky": ["nku"],
  Omaha: ["nebraska omaha"],
  "Oral Roberts": ["oru"],
  "Purdue Fort Wayne": ["pfw", "ipfw"],
  "Saint Joseph's": ["st. joseph's", "st joe's", "saint joe's", "st. joes"],
  "Saint Louis": ["st. louis", "st louis", "slu"],
  "Saint Mary's": ["st. mary's", "st mary's", "smc"],
  "Saint Peter's": ["st. peter's", "st peter's"],
  "Seattle U": ["seattle university"],
  "South Carolina Upstate": ["usc upstate"],
  "Southern Indiana": ["usi"],
  "St. Bonaventure": ["saint bonaventure", "bonnies"],
  "St. John's": ["saint john's"],
  "Texas A&M-Corpus Christi": ["corpus christi", "a&m corpus christi", "tamucc"],
  "UC Irvine": ["uci"],
  "UC Riverside": ["ucr"],
  "UC San Diego": ["ucsd"],
  "UC Santa Barbara": ["ucsb"],
  UIC: ["illinois chicago"],
  "UMass Lowell": ["umass-lowell"],
  "UNC Asheville": ["unca"],
  "UNC Greensboro": ["uncg"],
  "UNC Wilmington": ["uncw"],
  // Not "uta": that is the Utah Jazz everywhere else in this app.
  "UT Arlington": [],
  "Utah Valley": ["uvu"],
  VCU: ["virginia commonwealth"],
  Vermont: ["uvm"],
  "Wichita State": ["wichita"],

  // FCS football, so shared with NCAAF
  "Arkansas-Pine Bluff": ["uapb", "arkansas pine bluff"],
  "Austin Peay": ["apsu"],
  "Central Arkansas": ["uca"],
  "Central Connecticut": ["ccsu"],
  "Eastern Illinois": ["eiu"],
  "Eastern Kentucky": ["eku"],
  "Eastern Washington": ["ewu"],
  "Florida A&M": ["famu"],
  Georgetown: ["gtown", "g'town"],
  Grambling: ["grambling state"],
  "Incarnate Word": ["uiw"],
  McNeese: ["mcneese state"],
  "Mississippi Valley State": ["mvsu", "mississippi valley"],
  Nicholls: ["nicholls state"],
  "North Carolina A&T": ["ncat"],
  "North Carolina Central": ["nccu"],
  "Northern Arizona": ["nau"],
  "Northern Colorado": ["unco"],
  "Northern Iowa": ["uni"],
  "Prairie View A&M": ["pvamu"],
  "Rhode Island": ["uri"],
  "Robert Morris": ["rmu"],
  "SE Louisiana": ["southeastern louisiana", "sela"],
  "Southeast Missouri State": ["semo"],
  "Southern Illinois": ["siu"],
  "Southern Utah": ["suu"],
  "Stephen F. Austin": ["sfa"],
  "Tarleton State": ["tarleton"],
  "The Citadel": ["citadel"],
  UAlbany: ["albany"],
  "UT Martin": ["tennessee martin"],
  "UT Rio Grande Valley": ["utrgv", "rio grande valley"],
  Valparaiso: ["valpo"],
  Villanova: ["nova"],
  "William & Mary": ["william and mary", "w&m"],

  // FBS, spellings NCAAF_SCHOOLS doesn't carry
  "North Carolina": ["n. carolina", "n carolina"],
  // South Dakota State is the other SDSU. It writes out its name or "S Dakota St".
  "San Diego State": ["sdsu"],
  "South Carolina": ["s. carolina", "s carolina"],
};

// Shorthand that honestly names more than one school, by ESPN `location`. Never
// guessed: the line becomes a question between these schools.
//
// An alias NCAAF_SCHOOLS already claims keeps that meaning for football
// (promoteSharedCollegePick): "USF" stays South Florida, and only a
// basketball-only school is added as a further candidate, which falls away on its
// own outside basketball season. Listing an FCS school there would prompt on
// September lines that resolve cleanly today, so those are not added.
//
// Deliberately absent, because the bare word keeps its existing meaning:
//   - "miami" is Hurricanes and the Miami pro teams. Miami (OH) needs its "(OH)".
//   - "usc" is Southern California, whose own key it is. "sdsu" is San Diego State.
//   - "carolina" reads as the pro teams, "north carolina" / "south carolina" as
//     those schools. "N. Carolina A&T" matches whole.
//   - "st. mary's" is Saint Mary's. "Mount St. Mary's" matches whole.
export const NCAAB_ALIAS_CONFLICTS: Record<string, string[]> = {
  loyola: ["Loyola Chicago", "Loyola Maryland", "Loyola Marymount"],
  usf: ["South Florida", "San Francisco"],
  csu: ["Colorado State", "Cleveland State", "Chicago State", "Charleston Southern"],
  msu: ["Michigan State", "Mississippi State", "Morgan State", "Murray State", "Morehead State", "Montana State", "Missouri State"],
  asu: ["Arizona State", "Arkansas State", "App State", "Alabama State", "Alcorn State"],
  osu: ["Ohio State", "Oklahoma State", "Oregon State"],
  fsu: ["Florida State", "Fresno State"],
  wsu: ["Washington State", "Wichita State", "Weber State", "Wright State"],
  ksu: ["Kansas State", "Kennesaw State", "Kent State"],
  ttu: ["Texas Tech", "Tennessee Tech"],
  bu: ["Boston University", "Butler", "Baylor", "Bucknell"],
};

const canonicalOf = (t: GeneratedCollegeTeam): string => t.name.toLowerCase();

const TEAM_BY_CANONICAL = new Map(NCAAB_D1_TEAMS.map((t) => [canonicalOf(t), t]));
const TEAM_BY_LOCATION = new Map(NCAAB_D1_TEAMS.map((t) => [t.location, t]));

// The ESPN display name for a lowercased canonical ("Duke Blue Devils").
export function ncaabDisplayName(canonical: string): string | undefined {
  return TEAM_BY_CANONICAL.get(canonical)?.name;
}

// "FBS" / "FCS" for a school that also plays football, null for a basketball-only
// school, undefined for a name that isn't a Division I basketball school at all.
export function ncaabFootballLevel(canonical: string): GeneratedCollegeTeam["football"] | undefined {
  const team = TEAM_BY_CANONICAL.get(canonical);
  return team ? team.football : undefined;
}

// Every [key, canonical] a capper might type for an NCAAB school, structured like
// NCAAF_SCHOOLS: several keys per school, the canonical being the name the score
// feed returns, lowercased.
export const NCAAB_SCHOOLS: [string, string][] = NCAAB_D1_TEAMS.flatMap((t) => {
  const keys = new Set(
    [t.location, t.short, ...(NCAAB_ALIASES[t.location] ?? [])].map((k) => k.toLowerCase())
  );
  return [...keys].map((key): [string, string] => [key, canonicalOf(t)]);
});

// The list as FeedTeams, so it runs through the same matcher a live feed does
// (longest match wins, a school must stand alone next to bet words). Never asked
// to match a bare mascot: see `listed` in feed-teams.ts.
export const NCAAB_LISTED_TEAMS: FeedTeam[] = NCAAB_D1_TEAMS.map((t) => ({
  sport: "NCAAB",
  name: t.name,
  location: t.location,
  ...(t.short !== t.location ? { shortName: t.short } : {}),
  ...(NCAAB_ALIASES[t.location]?.length ? { aliases: NCAAB_ALIASES[t.location] } : {}),
  listed: true,
}));

export type CollegeAliasOption = { canonical: string; football: GeneratedCollegeTeam["football"] };

// The schools a conflicting alias could mean, or undefined for any other word.
export function collegeAliasSchools(alias: string): CollegeAliasOption[] | undefined {
  const locations = NCAAB_ALIAS_CONFLICTS[alias];
  if (!locations) return undefined;
  return locations.flatMap((location) => {
    const team = TEAM_BY_LOCATION.get(location);
    return team ? [{ canonical: canonicalOf(team), football: team.football }] : [];
  });
}

// Which conflicting alias, if any, a line is about. Whole-word only.
export function findCollegeAliasConflict(text: string): string | undefined {
  const lower = text.toLowerCase();
  return Object.keys(NCAAB_ALIAS_CONFLICTS).find((alias) => new RegExp("(?<![\\w&])" + alias + "(?![\\w&])").test(lower));
}

// Curated keys naming a location the generated list doesn't carry. Empty unless
// a rerun of the generator dropped a school: the acceptance test asserts it.
export const NCAAB_ALIASES_WITHOUT_A_SCHOOL: string[] = [
  ...Object.keys(NCAAB_ALIASES).filter((location) => !TEAM_BY_LOCATION.has(location) && NCAAB_ALIASES[location].length > 0),
  ...Object.values(NCAAB_ALIAS_CONFLICTS)
    .flat()
    .filter((location) => !TEAM_BY_LOCATION.has(location)),
];
