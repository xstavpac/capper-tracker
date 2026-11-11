// Every NHL / MLB / NBA PropMarket value categorizes as its own family's per-market key
// (PICK_CATEGORY_VERSION 5, lib/prop-category.ts). The pinned pick-category-matrix table
// now sweeps every market too; this test names each one. Pure (no DB). Run with:
//   npx tsx src/server/data/nhl-prop-category-acceptance-test.ts
//
// The null-propMarket text fallback still uses the NFL parser only, so legacy NHL /
// MLB / NBA text on a row with no propMarket stays uncategorized. Picks imported as
// these props always carry propMarket (bulk-picks stores it).
import { PropMarket } from "@prisma/client";
import { pickCategory, PICK_CATEGORY_VERSION } from "@/server/data/stats";
import { PROP_CATEGORY_BY_FAMILY } from "@/lib/prop-category";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

const NFL_MARKETS = ["PASS_YDS", "RUSH_YDS", "REC_YDS", "RECEPTIONS", "TD", "RUSH_REC_YDS", "PASS_RUSH_YDS", "PASS_TDS", "PASS_ATTEMPTS", "RUSH_ATTEMPTS", "PASS_INTERCEPTIONS", "PASS_COMPLETIONS", "TD_COUNT"];
const NHL_MARKETS = ["ANYTIME_GOAL", "FIRST_GOAL", "SHOTS_ON_GOAL", "POINTS", "ASSISTS", "SAVES"];
// MLB markets (2026-10).
const MLB_MARKETS = ["STRIKEOUTS", "OUTS_RECORDED", "TOTAL_BASES", "HITS", "WALKS", "RUNS", "RBIS", "HOME_RUNS"];
// NBA markets (2026-10) - same treatment. POINTS and ASSISTS are shared with the NHL list above (one
// enum value, the pick's sport says whose); these are the values only the NBA has.
const NBA_MARKETS = ["REBOUNDS", "DEFENSIVE_REBOUNDS", "THREES_MADE", "STEALS", "BLOCKS", "POINTS_REBOUNDS_ASSISTS", "POINTS_REBOUNDS", "POINTS_ASSISTS", "REBOUNDS_ASSISTS", "DOUBLE_DOUBLE"];

const input = (propMarket: PropMarket | null, betDetail: string | null, sportName = "NHL") =>
  ({
    betType: "PLAYER_PROP",
    period: "FULL_GAME",
    betDetail,
    odds: -110,
    line: null,
    sportName,
    pickedSide: null,
    mlFavoredSide: null,
    propMarket,
  }) as Parameters<typeof pickCategory>[0];

// No PropMarket value may fall outside both lists (a new market must be added
// here, and so be tested, before this passes).
check(
  "every PropMarket enum value is in the NFL, NHL, MLB or NBA list",
  Object.values(PropMarket).filter((m) => !NFL_MARKETS.includes(m) && !NHL_MARKETS.includes(m) && !MLB_MARKETS.includes(m) && !NBA_MARKETS.includes(m)),
  []
);
check("every NHL market exists in the enum", NHL_MARKETS.filter((m) => !(m in PropMarket)), []);
check("every MLB market exists in the enum", MLB_MARKETS.filter((m) => !(m in PropMarket)), []);
check("every NBA market exists in the enum", NBA_MARKETS.filter((m) => !(m in PropMarket)), []);

// Hand-written per market (not read from the table) so a remapped market fails here.
const NHL_KEY: Record<string, string> = { ANYTIME_GOAL: "ANYTIME_GOAL_PROP", FIRST_GOAL: "FIRST_GOAL_PROP", SHOTS_ON_GOAL: "SOG_PROP", POINTS: "NHL_POINTS_PROP", ASSISTS: "NHL_ASSISTS_PROP", SAVES: "SAVES_PROP" };
const MLB_KEY: Record<string, string> = { STRIKEOUTS: "K_PROP", OUTS_RECORDED: "OUTS_PROP", TOTAL_BASES: "TB_PROP", HITS: "HITS_PROP", WALKS: "WALKS_PROP", RUNS: "RUNS_PROP", RBIS: "RBI_PROP", HOME_RUNS: "HR_PROP" };
const NBA_KEY: Record<string, string> = {
  POINTS: "PTS_PROP", ASSISTS: "AST_PROP", REBOUNDS: "REB_PROP", DEFENSIVE_REBOUNDS: "DREB_PROP", THREES_MADE: "THREES_PROP", STEALS: "STL_PROP", BLOCKS: "BLK_PROP",
  POINTS_REBOUNDS_ASSISTS: "PRA_PROP", POINTS_REBOUNDS: "PR_PROP", POINTS_ASSISTS: "PA_PROP", REBOUNDS_ASSISTS: "RA_PROP", DOUBLE_DOUBLE: "DOUBLE_DOUBLE_PROP",
};
for (const m of NHL_MARKETS) {
  check(`NHL ${m} (propMarket set) -> ${NHL_KEY[m]}`, pickCategory(input(m as PropMarket, "Sidney Crosby over 3.5 shots on goal")), NHL_KEY[m]);
  check(`NHL ${m} (propMarket set, no betDetail) -> ${NHL_KEY[m]}`, pickCategory(input(m as PropMarket, null)), NHL_KEY[m]);
}

for (const m of MLB_MARKETS) {
  check(`MLB ${m} (propMarket set) -> ${MLB_KEY[m]}`, pickCategory(input(m as PropMarket, "Chris Sale over 5.5 Ks", "MLB")), MLB_KEY[m]);
  check(`MLB ${m} (propMarket set, no betDetail) -> ${MLB_KEY[m]}`, pickCategory(input(m as PropMarket, null, "MLB")), MLB_KEY[m]);
}
for (const m of [...NBA_MARKETS, "POINTS", "ASSISTS"]) {
  check(`NBA ${m} (propMarket set) -> ${NBA_KEY[m]}`, pickCategory(input(m as PropMarket, "Nikola Jokic over 12.5 rebounds", "NBA")), NBA_KEY[m]);
  check(`NBA ${m} (propMarket set, no betDetail) -> ${NBA_KEY[m]}`, pickCategory(input(m as PropMarket, null, "NBA")), NBA_KEY[m]);
}
const TABLES = PROP_CATEGORY_BY_FAMILY as Record<string, Record<string, string>>;
check(
  "the hand-written keys match the table",
  ([["HOCKEY", NHL_KEY], ["BASEBALL", MLB_KEY], ["BASKETBALL", NBA_KEY]] as const).every(([family, keys]) => Object.entries(keys).every(([m, k]) => TABLES[family][m] === k)),
  true
);
check("legacy null-propMarket NBA text stays uncategorized", pickCategory(input(null, "Nikola Jokic over 12.5 rebounds", "NBA")), null);
check("legacy null-propMarket MLB text stays uncategorized (unchanged)", pickCategory(input(null, "Chris Sale over 5.5 Ks", "MLB")), null);

// Unchanged legacy behavior: a PLAYER_PROP row with NO propMarket still relies on the
// NFL text parser, so NHL text on such a row stays uncategorized - exactly as before
// NHL props existed (no stored category changes, hence no version bump).
check("legacy null-propMarket NHL text stays uncategorized (unchanged)", pickCategory(input(null, "Sidney Crosby over 3.5 shots on goal")), null);
// Every NFL market has its own category: yardage / receptions (version 2), combined yards
// (version 3), attempts / completions / interceptions (new markets), and anytime TD, TD
// count and passing TDs (version 5).
const NFL_STAT_PROP: Record<string, string> = {
  PASS_YDS: "PASS_YDS_PROP", RUSH_YDS: "RUSH_YDS_PROP", REC_YDS: "REC_YDS_PROP", RECEPTIONS: "RECEPTIONS_PROP", RUSH_REC_YDS: "RUSH_REC_YDS_PROP", PASS_RUSH_YDS: "PASS_RUSH_YDS_PROP",
  PASS_ATTEMPTS: "PASS_ATTEMPTS_PROP", PASS_COMPLETIONS: "PASS_COMPLETIONS_PROP", PASS_INTERCEPTIONS: "PASS_INTERCEPTIONS_PROP", RUSH_ATTEMPTS: "RUSH_ATTEMPTS_PROP",
  TD: "ANYTIME_TD_PROP", TD_COUNT: "TD_COUNT_PROP", PASS_TDS: "PASS_TDS_PROP",
};
check("legacy null-propMarket NFL text takes the market's own category", pickCategory(input(null, "Josh Allen Over 275.5 Passing Yards", "NFL")), "PASS_YDS_PROP");
check("NFL markets: every one its own category", NFL_MARKETS.map((m) => pickCategory(input(m as PropMarket, null, "NFL"))), NFL_MARKETS.map((m) => NFL_STAT_PROP[m]));
check("PICK_CATEGORY_VERSION (5: per-market player-prop categories)", PICK_CATEGORY_VERSION, 5);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
