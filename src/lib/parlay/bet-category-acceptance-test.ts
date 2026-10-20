// Proof for betCategory (bet-category.ts): every BetType is mapped, the map
// agrees with the Relationship Classifier's families, period and sport never
// change a category, and an unknown bet type is UNCLASSIFIED. Pure - no DB.
//
// Rows: betType / period / betDetail copied from real pick rows (a local
// snapshot of production picks, 2026-08-07..09-15) for NFL, NCAAF, MLB, NHL and
// WNBA. That snapshot has no player props and no NBA picks, so those rows are
// the real capper texts the import / grading suites already carry. Run with:
//   npx tsx src/lib/parlay/bet-category-acceptance-test.ts
import { BetType } from "@prisma/client";
import { BET_CATEGORY_BY_BET_TYPE, betCategory, type BetCategoryResult } from "@/lib/parlay/bet-category";
import { describePick } from "@/lib/parlay/relationship-classifier";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

type Row = { sport: string; betType: string; period: string; betDetail: string; line: number | null; home: string; away: string; expected: BetCategoryResult };

const ROWS: Row[] = [
  // NFL
  { sport: "NFL", betType: "MONEYLINE", period: "FULL_GAME", betDetail: "Chiefs Moneyline", line: null, home: "Kansas City Chiefs", away: "Denver Broncos", expected: "MONEYLINE" },
  { sport: "NFL", betType: "MONEYLINE", period: "FIRST_HALF", betDetail: "Broncos First Half Moneyline", line: null, home: "Kansas City Chiefs", away: "Denver Broncos", expected: "MONEYLINE" },
  { sport: "NFL", betType: "MONEYLINE", period: "SECOND_QUARTER", betDetail: "Chiefs Second Quarter Moneyline", line: null, home: "Kansas City Chiefs", away: "Denver Broncos", expected: "MONEYLINE" },
  { sport: "NFL", betType: "SPREAD", period: "FULL_GAME", betDetail: "Broncos +2.5", line: 2.5, home: "Kansas City Chiefs", away: "Denver Broncos", expected: "SPREAD" },
  { sport: "NFL", betType: "SPREAD", period: "FIRST_HALF", betDetail: "Texans 1H +0.5", line: 0.5, home: "Houston Texans", away: "Los Angeles Rams", expected: "SPREAD" },
  { sport: "NFL", betType: "TOTAL", period: "FULL_GAME", betDetail: "Broncos Chiefs under 43.5", line: 43.5, home: "Kansas City Chiefs", away: "Denver Broncos", expected: "TOTALS" },
  { sport: "NFL", betType: "TOTAL", period: "FIRST_HALF", betDetail: "Patriots Browns Over 17.5 First Half Total", line: 17.5, home: "New England Patriots", away: "Cleveland Browns", expected: "TOTALS" },
  { sport: "NFL", betType: "TOTAL", period: "FIRST_QUARTER", betDetail: "Cardinals/Chargers over 9.5 1Q", line: 9.5, home: "Los Angeles Chargers", away: "Arizona Cardinals", expected: "TOTALS" },
  { sport: "NFL", betType: "TEAM_TOTAL", period: "FULL_GAME", betDetail: "Chiefs over 21.5 team total", line: 21.5, home: "Kansas City Chiefs", away: "Denver Broncos", expected: "TOTALS" },
  // "NFL 1H team total over -> Totals" (no 1H team total row in the snapshot; MLB's F5 one below is real).
  { sport: "NFL", betType: "TEAM_TOTAL", period: "FIRST_HALF", betDetail: "Chiefs 1H team total over 10.5", line: 10.5, home: "Kansas City Chiefs", away: "Denver Broncos", expected: "TOTALS" },
  { sport: "NFL", betType: "PLAYER_PROP", period: "FULL_GAME", betDetail: "Bills Josh Allen Over 275.5 Passing Yards", line: 275.5, home: "Buffalo Bills", away: "Miami Dolphins", expected: "PROPS" },
  { sport: "NFL", betType: "PLAYER_PROP", period: "FULL_GAME", betDetail: "Adonai Mitchell Anytime Touchdown", line: null, home: "Indianapolis Colts", away: "Houston Texans", expected: "PROPS" },
  // NCAAF
  { sport: "NCAAF", betType: "MONEYLINE", period: "FULL_GAME", betDetail: "Texas State Moneyline", line: null, home: "Texas State Bobcats", away: "UTSA Roadrunners", expected: "MONEYLINE" },
  { sport: "NCAAF", betType: "MONEYLINE", period: "FIRST_HALF", betDetail: "SMU First Half Moneyline", line: null, home: "SMU Mustangs", away: "Baylor Bears", expected: "MONEYLINE" },
  { sport: "NCAAF", betType: "SPREAD", period: "FULL_GAME", betDetail: "Texas Tech -8.5", line: -8.5, home: "Texas Tech Red Raiders", away: "Kansas State Wildcats", expected: "SPREAD" },
  { sport: "NCAAF", betType: "SPREAD", period: "FIRST_HALF", betDetail: "Oregon Ducks 1st Half -13.5", line: -13.5, home: "Oregon Ducks", away: "Oklahoma State Cowboys", expected: "SPREAD" },
  { sport: "NCAAF", betType: "TOTAL", period: "FULL_GAME", betDetail: "Charlotte vs Mississippi Under 60.5", line: 60.5, home: "Ole Miss Rebels", away: "Charlotte 49ers", expected: "TOTALS" },
  { sport: "NCAAF", betType: "TOTAL", period: "FIRST_HALF", betDetail: "UNC vs TCU First Half under 23.5", line: 23.5, home: "North Carolina Tar Heels", away: "TCU Horned Frogs", expected: "TOTALS" },
  { sport: "NCAAF", betType: "TEAM_TOTAL", period: "FULL_GAME", betDetail: "Penn State Team Total Over 37.5", line: 37.5, home: "Penn State Nittany Lions", away: "Nevada Wolf Pack", expected: "TOTALS" },
  // MLB
  { sport: "MLB", betType: "MONEYLINE", period: "FULL_GAME", betDetail: "Cubs moneyline", line: null, home: "Chicago Cubs", away: "Atlanta Braves", expected: "MONEYLINE" },
  { sport: "MLB", betType: "MONEYLINE", period: "FIRST_HALF", betDetail: "Angels First Five Moneyline", line: null, home: "Los Angeles Angels", away: "Seattle Mariners", expected: "MONEYLINE" },
  { sport: "MLB", betType: "SPREAD", period: "FULL_GAME", betDetail: "Padres -1.5", line: -1.5, home: "San Diego Padres", away: "Milwaukee Brewers", expected: "SPREAD" },
  { sport: "MLB", betType: "SPREAD", period: "FIRST_HALF", betDetail: "Angels First 5 -0.5", line: -0.5, home: "Los Angeles Angels", away: "Seattle Mariners", expected: "SPREAD" },
  { sport: "MLB", betType: "TOTAL", period: "FULL_GAME", betDetail: "Braves Cubs over 9", line: 9, home: "Chicago Cubs", away: "Atlanta Braves", expected: "TOTALS" },
  { sport: "MLB", betType: "TOTAL", period: "FIRST_HALF", betDetail: "Mariners Angels First Five under 4.5", line: 4.5, home: "Los Angeles Angels", away: "Seattle Mariners", expected: "TOTALS" },
  { sport: "MLB", betType: "NRFI", period: "FULL_GAME", betDetail: "Brewers vs Padres No Run First Inning", line: null, home: "San Diego Padres", away: "Milwaukee Brewers", expected: "TOTALS" },
  { sport: "MLB", betType: "NRFI", period: "FULL_GAME", betDetail: "Rangers/Angels YRFI", line: null, home: "Los Angeles Angels", away: "Texas Rangers", expected: "TOTALS" },
  { sport: "MLB", betType: "TEAM_TOTAL", period: "FULL_GAME", betDetail: "Red Sox team total under 3.5", line: 3.5, home: "Boston Red Sox", away: "New York Yankees", expected: "TOTALS" },
  { sport: "MLB", betType: "TEAM_TOTAL", period: "FIRST_HALF", betDetail: "Yankees First Five Team Total Under 2.5", line: 2.5, home: "Boston Red Sox", away: "New York Yankees", expected: "TOTALS" },
  { sport: "MLB", betType: "PLAYER_PROP", period: "FULL_GAME", betDetail: "Adolis Garcia over 0.5 hits", line: 0.5, home: "Texas Rangers", away: "Houston Astros", expected: "PROPS" },
  // NHL
  { sport: "NHL", betType: "MONEYLINE", period: "FULL_GAME", betDetail: "Lightning Locks", line: null, home: "Tampa Bay Lightning", away: "Florida Panthers", expected: "MONEYLINE" },
  { sport: "NHL", betType: "MONEYLINE", period: "REGULATION", betDetail: "Oilers 3-way ML", line: null, home: "Edmonton Oilers", away: "Calgary Flames", expected: "MONEYLINE" },
  { sport: "NHL", betType: "MONEYLINE", period: "REGULATION", betDetail: "Oilers Flames Draw 3-way", line: null, home: "Edmonton Oilers", away: "Calgary Flames", expected: "MONEYLINE" },
  { sport: "NHL", betType: "PLAYER_PROP", period: "FULL_GAME", betDetail: "Andrei Kuzmenko over 1.5 shots on goal", line: 1.5, home: "Los Angeles Kings", away: "Calgary Flames", expected: "PROPS" },
  // NBA / WNBA
  { sport: "NBA", betType: "SPREAD", period: "FULL_GAME", betDetail: "OKC Thunder -7.5", line: -7.5, home: "Oklahoma City Thunder", away: "Denver Nuggets", expected: "SPREAD" },
  { sport: "NBA", betType: "SPREAD", period: "FIRST_HALF", betDetail: "Timberwolves 1H -3", line: -3, home: "Minnesota Timberwolves", away: "Phoenix Suns", expected: "SPREAD" },
  { sport: "NBA", betType: "PLAYER_PROP", period: "FULL_GAME", betDetail: "BRUNSON OVER 24.5 POINTS", line: 24.5, home: "New York Knicks", away: "Boston Celtics", expected: "PROPS" },
  { sport: "WNBA", betType: "SPREAD", period: "FULL_GAME", betDetail: "Dream +2", line: 2, home: "Atlanta Dream", away: "Chicago Sky", expected: "SPREAD" },
  { sport: "WNBA", betType: "MONEYLINE", period: "FULL_GAME", betDetail: "Dallas Wings Moneyline", line: null, home: "Dallas Wings", away: "Seattle Storm", expected: "MONEYLINE" },
  { sport: "WNBA", betType: "TOTAL", period: "FULL_GAME", betDetail: "Washington mystics Phoenix mercury Under 167.5", line: 167.5, home: "Phoenix Mercury", away: "Washington Mystics", expected: "TOTALS" },
  // A prop whose market text is unreadable is still a prop.
  { sport: "NFL", betType: "PLAYER_PROP", period: "FULL_GAME", betDetail: "Puka special", line: null, home: "Los Angeles Rams", away: "Seattle Seahawks", expected: "PROPS" },
  // Synthetic: a bet type the map has never seen.
  { sport: "NFL", betType: "WINNING_MARGIN", period: "FULL_GAME", betDetail: "Chiefs by 7-12", line: null, home: "Kansas City Chiefs", away: "Denver Broncos", expected: "UNCLASSIFIED" },
];

check("every BetType is mapped (a new one fails the build in bet-category.ts)", Object.keys(BET_CATEGORY_BY_BET_TYPE).sort(), Object.values(BetType).sort());

for (const r of ROWS) check(`${r.sport} ${r.betType} ${r.period} "${r.betDetail}"`, betCategory(r), r.expected);

// The required examples.
const by = (sport: string, betType: string, period: string) => betCategory(ROWS.find((r) => r.sport === sport && r.betType === betType && r.period === period)!);
check("NFL 1H team total over -> Totals", by("NFL", "TEAM_TOTAL", "FIRST_HALF"), "TOTALS");
check("NBA 1H spread -> Spread", by("NBA", "SPREAD", "FIRST_HALF"), "SPREAD");
check("MLB NRFI / YRFI -> Totals", ROWS.filter((r) => r.betType === "NRFI").map(betCategory), ["TOTALS", "TOTALS"]);
check("MLB team total -> Totals", by("MLB", "TEAM_TOTAL", "FULL_GAME"), "TOTALS");
check("NFL passing yards over -> Props", betCategory({ betType: "PLAYER_PROP" }), "PROPS");
check("NHL moneyline -> Moneyline", by("NHL", "MONEYLINE", "FULL_GAME"), "MONEYLINE");

// Period never changes a category: every category has a non-full-game row here.
for (const c of ["MONEYLINE", "SPREAD", "TOTALS"] as const) {
  check(`${c}: has a non-FULL_GAME real row`, ROWS.some((r) => r.expected === c && r.period !== "FULL_GAME"), true);
}
check("PROPS: a 1H prop row is still Props (period ignored)", betCategory({ betType: "PLAYER_PROP", ...{ period: "FIRST_HALF" } }), "PROPS");
for (const r of ROWS) {
  for (const period of ["FULL_GAME", "FIRST_HALF", "THIRD_QUARTER", "SECOND_PERIOD"]) {
    if (betCategory({ ...r, period } as Row) !== r.expected) check(`${r.betDetail} at ${period} keeps its category`, false, true);
  }
}

// Built on the classifier: SIDE family = Moneyline + Spread, TOTAL family =
// Totals, the props it leaves INACTIVE = Props, unknown = UNDERIVABLE.
for (const r of ROWS) {
  const d = describePick({ betType: r.betType, period: r.period, betDetail: r.betDetail, line: r.line }, { homeTeam: r.home, awayTeam: r.away, gameTime: new Date("2026-09-14T17:00:00Z"), sportName: r.sport });
  const fromFamily = d.family === "SIDE" ? ["MONEYLINE", "SPREAD"] : d.family === "TOTAL" ? ["TOTALS"] : d.status === "INACTIVE" ? ["PROPS"] : ["UNCLASSIFIED"];
  check(`agrees with the classifier: ${r.betType} "${r.betDetail}" (${d.family ?? d.status})`, fromFamily.includes(betCategory(r)), true);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
