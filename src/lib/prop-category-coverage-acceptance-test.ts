// Proof that no player-prop market a parser produces silently lands in the
// "Other props" fallback (lib/prop-category.ts) - run with:
//   npx tsx src/lib/prop-category-coverage-acceptance-test.ts
//
// Two guards, one per way a new market can be added:
//   - a new PropMarket enum value: PROP_CATEGORY_BY_FAMILY is a full
//     Record<PropMarket, ...> per family, so the typecheck fails until each family
//     names it (its own key or "OTHER"). Checked again here at runtime against the
//     generated client's enum.
//   - a new market in a sport's parser: the Record<...Market, true> lists below
//     fail the typecheck until the market is listed, and the checks then fail
//     until the family maps it to a key of its own (not "OTHER").
// Pure (no database).
import { PropMarket } from "@prisma/client";
import type { PlayerPropMarket } from "@/lib/bet-line";
import type { NbaPropMarket } from "@/lib/nba-prop";
import type { NhlPropMarket } from "@/lib/nhl-prop";
import type { MlbPropMarket } from "@/lib/mlb-prop";
import { PROP_CATEGORY_BY_FAMILY, PROP_CATEGORY_KEYS, propCategoryFor, propTileKeysForFamily } from "@/lib/prop-category";
import { PROP_MARKET_KEYS, sportsOfPropFamily, type PropSportFamily } from "@/lib/prop-market-key";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

// Every market each family's parser can return (bet-line.ts parsePlayerProp for
// football, nba-prop.ts, nhl-prop.ts, mlb-prop.ts). Typed as full records so a
// market added to a parser's union fails the typecheck here.
const FOOTBALL_PARSED: Record<PlayerPropMarket, true> = {
  PASS_YDS: true,
  RUSH_YDS: true,
  REC_YDS: true,
  RECEPTIONS: true,
  TD: true,
  TD_COUNT: true,
  RUSH_REC_YDS: true,
  PASS_RUSH_YDS: true,
  PASS_TDS: true,
  PASS_ATTEMPTS: true,
  RUSH_ATTEMPTS: true,
  PASS_INTERCEPTIONS: true,
  PASS_COMPLETIONS: true,
};
const BASKETBALL_PARSED: Record<NbaPropMarket, true> = {
  POINTS: true,
  ASSISTS: true,
  REBOUNDS: true,
  DEFENSIVE_REBOUNDS: true,
  THREES_MADE: true,
  STEALS: true,
  BLOCKS: true,
  POINTS_REBOUNDS_ASSISTS: true,
  POINTS_REBOUNDS: true,
  POINTS_ASSISTS: true,
  REBOUNDS_ASSISTS: true,
  DOUBLE_DOUBLE: true,
};
const HOCKEY_PARSED: Record<NhlPropMarket, true> = {
  ANYTIME_GOAL: true,
  FIRST_GOAL: true,
  SHOTS_ON_GOAL: true,
  POINTS: true,
  ASSISTS: true,
  SAVES: true,
};
const BASEBALL_PARSED: Record<MlbPropMarket, true> = {
  STRIKEOUTS: true,
  OUTS_RECORDED: true,
  TOTAL_BASES: true,
  HITS: true,
  WALKS: true,
  RUNS: true,
  RBIS: true,
  HOME_RUNS: true,
};
const PARSED: Record<PropSportFamily, string[]> = {
  FOOTBALL: Object.keys(FOOTBALL_PARSED),
  BASKETBALL: Object.keys(BASKETBALL_PARSED),
  HOCKEY: Object.keys(HOCKEY_PARSED),
  BASEBALL: Object.keys(BASEBALL_PARSED),
};
const FAMILIES = Object.keys(PARSED) as PropSportFamily[];

function main() {
  const enumValues = Object.values(PropMarket).sort();
  for (const family of FAMILIES) {
    const table = PROP_CATEGORY_BY_FAMILY[family] as Record<string, string>;
    check(`${family}: the table lists every PropMarket enum value, nothing else`, Object.keys(table).sort(), enumValues);
    check(`${family}: every parsed market has a key of its own (not OTHER)`, PARSED[family].filter((m) => table[m] === "OTHER"), []);
    check(`${family}: no market outside the parser has a key of its own`, Object.keys(table).filter((m) => table[m] !== "OTHER" && !PARSED[family].includes(m)), []);
    // The family's per-market record keys (prop-market-key.ts, the Generator's prop
    // records and platform_category_rates) cover the same markets.
    const recordMarkets = PROP_MARKET_KEYS.filter((k) => k.startsWith(family + ":")).map((k) => k.slice(family.length + 1)).sort();
    check(`${family}: same markets as its PropMarketKeys`, recordMarkets, [...PARSED[family]].sort());
    // Each of the family's leagues reads the same table.
    for (const sport of sportsOfPropFamily(family)) {
      check(`${sport}: every parsed market maps through the family`, PARSED[family].every((m) => propCategoryFor(sport, m as PropMarket) === table[m]), true);
    }
  }

  // Keys never repeat across families (categoryRecordKey has no league in it).
  const owner = new Map<string, string[]>();
  for (const family of FAMILIES) {
    for (const k of propTileKeysForFamily(family)) if (k !== "OTHER_PROP") owner.set(k, [...(owner.get(k) ?? []), family]);
  }
  check("no category key is shared by two families", Array.from(owner.entries()).filter(([, fs]) => fs.length > 1), []);
  // Every key in the text table is reachable, and every reachable key has text.
  const reachable = new Set<string>([...owner.keys(), "OTHER_PROP"]);
  check("every key with a label is some family's key (or OTHER_PROP)", PROP_CATEGORY_KEYS.filter((k) => !reachable.has(k)), []);
  check("every family key has a label", Array.from(reachable).filter((k) => !(PROP_CATEGORY_KEYS as string[]).includes(k)), []);
  // A sport with no family falls back, it never throws.
  check("a sport with no family -> OTHER_PROP", propCategoryFor("ATP", "POINTS"), "OTHER_PROP");

  console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
