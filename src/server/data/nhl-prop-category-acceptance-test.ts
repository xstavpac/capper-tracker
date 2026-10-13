// Every NHL PropMarket value categorizes as the player-prop category. The pinned
// pick-category-matrix table sweeps only the NFL PropMarket values (see
// PROP_MARKETS in pick-category-matrix.ts); this test is what covers the NHL
// ones so no market is left untested. Pure (no DB). Run with:
//   npx tsx src/server/data/nhl-prop-category-acceptance-test.ts
//
// pickCategory's behavior for every EXISTING input is unchanged by NHL props
// (its null-propMarket text fallback still uses the NFL parser only), so they
// needed no PICK_CATEGORY_VERSION bump. Picks imported as NHL props
// always carry propMarket (bulk-picks stores it), so they take the
// propMarket-set branch.
import { PropMarket } from "@prisma/client";
import { pickCategory, PICK_CATEGORY_VERSION } from "@/server/data/stats";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

const NFL_MARKETS = ["PASS_YDS", "RUSH_YDS", "REC_YDS", "RECEPTIONS", "TD", "RUSH_REC_YDS", "PASS_RUSH_YDS", "PASS_TDS"];
const NHL_MARKETS = ["ANYTIME_GOAL", "FIRST_GOAL", "SHOTS_ON_GOAL", "POINTS", "ASSISTS", "SAVES"];
// MLB markets (2026-10) - same treatment: propMarket set -> TD_PROP, no new pickCategory branch.
const MLB_MARKETS = ["STRIKEOUTS", "OUTS_RECORDED", "TOTAL_BASES", "HITS", "WALKS", "RUNS", "RBIS", "HOME_RUNS"];
// NBA markets (2026-10) - same treatment. POINTS and ASSISTS are shared with the NHL list above (one
// enum value, the pick's sport says whose); these are the values only the NBA has.
const NBA_MARKETS = ["REBOUNDS", "THREES_MADE", "STEALS", "BLOCKS", "POINTS_REBOUNDS_ASSISTS", "POINTS_REBOUNDS", "POINTS_ASSISTS", "REBOUNDS_ASSISTS", "DOUBLE_DOUBLE"];

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

for (const m of NHL_MARKETS) {
  check(`NHL ${m} (propMarket set) -> TD_PROP`, pickCategory(input(m as PropMarket, "Sidney Crosby over 3.5 shots on goal")), "TD_PROP");
  check(`NHL ${m} (propMarket set, no betDetail) -> TD_PROP`, pickCategory(input(m as PropMarket, null)), "TD_PROP");
}

for (const m of MLB_MARKETS) {
  check(`MLB ${m} (propMarket set) -> TD_PROP`, pickCategory(input(m as PropMarket, "Chris Sale over 5.5 Ks", "MLB")), "TD_PROP");
  check(`MLB ${m} (propMarket set, no betDetail) -> TD_PROP`, pickCategory(input(m as PropMarket, null, "MLB")), "TD_PROP");
}
for (const m of [...NBA_MARKETS, "POINTS", "ASSISTS"]) {
  check(`NBA ${m} (propMarket set) -> TD_PROP`, pickCategory(input(m as PropMarket, "Nikola Jokic over 12.5 rebounds", "NBA")), "TD_PROP");
  check(`NBA ${m} (propMarket set, no betDetail) -> TD_PROP`, pickCategory(input(m as PropMarket, null, "NBA")), "TD_PROP");
}
check("legacy null-propMarket NBA text stays uncategorized", pickCategory(input(null, "Nikola Jokic over 12.5 rebounds", "NBA")), null);
check("legacy null-propMarket MLB text stays uncategorized (unchanged)", pickCategory(input(null, "Chris Sale over 5.5 Ks", "MLB")), null);

// Unchanged legacy behavior: a PLAYER_PROP row with NO propMarket still relies on the
// NFL text parser, so NHL text on such a row stays uncategorized - exactly as before
// NHL props existed (no stored category changes, hence no version bump).
check("legacy null-propMarket NHL text stays uncategorized (unchanged)", pickCategory(input(null, "Sidney Crosby over 3.5 shots on goal")), null);
// The NFL yardage / receptions markets have their own category (version 2); the rest are TD_PROP.
const NFL_STAT_PROP: Record<string, string> = { PASS_YDS: "PASS_YDS_PROP", RUSH_YDS: "RUSH_YDS_PROP", REC_YDS: "REC_YDS_PROP", RECEPTIONS: "RECEPTIONS_PROP" };
check("legacy null-propMarket NFL text takes the market's own category", pickCategory(input(null, "Josh Allen Over 275.5 Passing Yards", "NFL")), "PASS_YDS_PROP");
check("NFL markets: yardage / receptions their own category, the rest TD_PROP", NFL_MARKETS.map((m) => pickCategory(input(m as PropMarket, null, "NFL"))), NFL_MARKETS.map((m) => NFL_STAT_PROP[m] ?? "TD_PROP"));
check("PICK_CATEGORY_VERSION", PICK_CATEGORY_VERSION, 2);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
