// propMarketKey (prop-market-key.ts): every PropMarket value against every live
// sport. One stat, one key: NBA POINTS and NHL POINTS never share one; the
// leagues of one family (NBA + WNBA, NFL + NCAAF) always do. A pick that isn't a
// player prop, has no propMarket, is in a sport with no family, or names a
// market its family doesn't have gets no key. Pure - no DB. Run with:
//   npx tsx src/lib/prop-market-key-acceptance-test.ts
import { PropMarket } from "@prisma/client";
import { PROP_MARKET_KEYS, PROP_MARKET_LABELS, propMarketKey, propMarketOf, propSportFamily } from "@/lib/prop-market-key";
import { PICK_CATEGORY_MARKET_NOUN } from "@/server/data/stats";
import { LIVE_SPORTS } from "@/server/data/odds";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const prop = (sportName: string, propMarket: string | null) => propMarketKey({ betType: "PLAYER_PROP", sportName, propMarket });

// ---- Families
check("families of the live sports", LIVE_SPORTS.map((s) => [s.label, propSportFamily(s.label)]), [
  ["NFL", "FOOTBALL"],
  ["NBA", "BASKETBALL"],
  ["MLB", "BASEBALL"],
  ["NHL", "HOCKEY"],
  ["WNBA", "BASKETBALL"],
  ["NCAAF", "FOOTBALL"],
]);
check("sport name is case-insensitive", propSportFamily("nba"), "BASKETBALL");
check("a sport with no family", propSportFamily("NCAAB"), null);

// ---- Every enum value lands in exactly the families whose parser produces it
const ALL = Object.values(PropMarket);
const covered = new Set(PROP_MARKET_KEYS.map(propMarketOf));
check("every PropMarket value has a key in some family", ALL.filter((m) => !covered.has(m)), []);
check("no key names a value outside the enum", PROP_MARKET_KEYS.map(propMarketOf).filter((m) => !ALL.includes(m)), []);
check("every key has a label", PROP_MARKET_KEYS.filter((k) => !PROP_MARKET_LABELS[k]), []);

const keysOf = (sport: string) => ALL.map((m) => prop(sport, m)).filter((k): k is NonNullable<typeof k> => k !== null);
check("NFL keys", keysOf("NFL"), [
  "FOOTBALL:PASS_YDS", "FOOTBALL:RUSH_YDS", "FOOTBALL:REC_YDS", "FOOTBALL:RECEPTIONS", "FOOTBALL:TD", "FOOTBALL:RUSH_REC_YDS",
  "FOOTBALL:PASS_RUSH_YDS", "FOOTBALL:PASS_TDS", "FOOTBALL:PASS_ATTEMPTS", "FOOTBALL:RUSH_ATTEMPTS", "FOOTBALL:PASS_INTERCEPTIONS", "FOOTBALL:PASS_COMPLETIONS",
]);
check("NCAAF keys are NFL's", keysOf("NCAAF"), keysOf("NFL"));
check("NHL keys", keysOf("NHL"), [
  "HOCKEY:ANYTIME_GOAL", "HOCKEY:FIRST_GOAL", "HOCKEY:SHOTS_ON_GOAL", "HOCKEY:POINTS", "HOCKEY:ASSISTS", "HOCKEY:SAVES",
]);
check("MLB keys", keysOf("MLB"), [
  "BASEBALL:STRIKEOUTS", "BASEBALL:OUTS_RECORDED", "BASEBALL:TOTAL_BASES", "BASEBALL:HITS", "BASEBALL:WALKS", "BASEBALL:RUNS", "BASEBALL:RBIS", "BASEBALL:HOME_RUNS",
]);
check("NBA keys", keysOf("NBA"), [
  "BASKETBALL:POINTS", "BASKETBALL:ASSISTS", "BASKETBALL:REBOUNDS", "BASKETBALL:THREES_MADE", "BASKETBALL:STEALS", "BASKETBALL:BLOCKS",
  "BASKETBALL:POINTS_REBOUNDS_ASSISTS", "BASKETBALL:POINTS_REBOUNDS", "BASKETBALL:POINTS_ASSISTS", "BASKETBALL:REBOUNDS_ASSISTS", "BASKETBALL:DOUBLE_DOUBLE",
]);
check("WNBA keys are NBA's", keysOf("WNBA"), keysOf("NBA"));

// ---- One stat, one key
check("NBA points != NHL points", [prop("NBA", "POINTS"), prop("NHL", "POINTS")], ["BASKETBALL:POINTS", "HOCKEY:POINTS"]);
check("NBA assists != NHL assists", [prop("NBA", "ASSISTS"), prop("NHL", "ASSISTS")], ["BASKETBALL:ASSISTS", "HOCKEY:ASSISTS"]);
check("NBA and WNBA points share one key", prop("WNBA", "POINTS"), prop("NBA", "POINTS"));
check("combined markets are their own keys", [prop("NBA", "POINTS_REBOUNDS_ASSISTS"), prop("NBA", "POINTS_REBOUNDS")], ["BASKETBALL:POINTS_REBOUNDS_ASSISTS", "BASKETBALL:POINTS_REBOUNDS"]);

// ---- No key
check("no propMarket", [prop("NBA", null), propMarketKey({ betType: "PLAYER_PROP", sportName: "NBA" })], [null, null]);
check("not a player prop", propMarketKey({ betType: "TOTAL", sportName: "NBA", propMarket: "POINTS" }), null);
check("a market outside its family (MLB POINTS, NHL HITS)", [prop("MLB", "POINTS"), prop("NHL", "HITS"), prop("NFL", "REBOUNDS")], [null, null, null]);
check("a sport with no family", prop("NCAAB", "POINTS"), null);

// ---- Labels
check("labels", ["BASKETBALL:POINTS", "HOCKEY:SHOTS_ON_GOAL", "BASEBALL:STRIKEOUTS", "FOOTBALL:TD"].map((k) => PROP_MARKET_LABELS[k as keyof typeof PROP_MARKET_LABELS]), [
  "points", "shots on goal", "pitcher strikeouts", "touchdowns",
]);
check(
  "an NFL stat market's label is its category's noun",
  ([["PASS_YDS", "PASS_YDS_PROP"], ["RUSH_YDS", "RUSH_YDS_PROP"], ["REC_YDS", "REC_YDS_PROP"], ["RECEPTIONS", "RECEPTIONS_PROP"], ["RUSH_REC_YDS", "RUSH_REC_YDS_PROP"], ["PASS_RUSH_YDS", "PASS_RUSH_YDS_PROP"], ["PASS_ATTEMPTS", "PASS_ATTEMPTS_PROP"], ["PASS_COMPLETIONS", "PASS_COMPLETIONS_PROP"], ["PASS_INTERCEPTIONS", "PASS_INTERCEPTIONS_PROP"], ["RUSH_ATTEMPTS", "RUSH_ATTEMPTS_PROP"]] as const).filter(
    ([m, c]) => PROP_MARKET_LABELS[`FOOTBALL:${m}`] !== PICK_CATEGORY_MARKET_NOUN[c]
  ),
  []
);

console.log(failures > 0 ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures > 0 ? 1 : 0);
