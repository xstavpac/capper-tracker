// Per-market prop categories, PR 2 (display only). Proves:
//   1. No chip set shows the legacy TD_PROP tile any more (the --props backfill
//      restamped every row; prod had 0 TD_PROP picks before this shipped).
//   2. Tiles are ordered by decided pick count, most first, stable on ties, on
//      both /live (buildCategoryTiles) and the capper page (orderTilesByPickCount).
//   3. /live collapses to 12 tiles with a toggle only past 12; no minimum-sample
//      fold - every tile with a record stays its own tile.
//   4. The /picks bet-type filter offers, per sport, exactly the prop markets its
//      family has its own key for (lib/prop-category.ts), and nothing keyed on TD_PROP.
//
// Pure (no database). Run with:
//   node --require ./scripts/server-only-stub.cjs --import tsx src/lib/prop-category-display-acceptance-test.ts
import type { PickCategoryKey } from "@/server/data/stats";
import { chipSetForLeague, chipSetsBySport, DEFAULT_CHIP_SET, PICK_CATEGORY_LABELS } from "@/server/data/stats";
import { betTypeOptionsForChipSet, BET_TYPE_FILTER_OPTIONS } from "@/lib/bet-type-filter";
import { buildCategoryTiles } from "@/lib/live-category-picks";
import { CATEGORY_TILES_COLLAPSED, orderTilesByPickCount, visibleCategoryTiles } from "@/lib/category-tile-order";
import { PROP_CATEGORY_BY_FAMILY, propTileKeysForFamily } from "@/lib/prop-category";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

// ---- 1. TD_PROP is gone from every tile set ----
{
  const sets = { ...chipSetsBySport(), DEFAULT: DEFAULT_CHIP_SET };
  check("no chip set lists TD_PROP", Object.entries(sets).filter(([, keys]) => keys.includes("TD_PROP")).map(([s]) => s), []);
  check("NFL still lists every football prop tile, then OTHER_PROP", propTileKeysForFamily("FOOTBALL").filter((k) => !chipSetForLeague("NFL").includes(k)), []);
  check("NHL / MLB / NBA / WNBA list their family's tiles", [
    propTileKeysForFamily("HOCKEY").every((k) => chipSetForLeague("NHL").includes(k)),
    propTileKeysForFamily("BASEBALL").every((k) => chipSetForLeague("MLB").includes(k)),
    propTileKeysForFamily("BASKETBALL").every((k) => chipSetForLeague("NBA").includes(k)),
    propTileKeysForFamily("BASKETBALL").every((k) => chipSetForLeague("WNBA").includes(k)),
  ], [true, true, true, true]);
}

// ---- 2. order: most decided picks first, stable on ties ----
{
  const t = (key: string, wins: number, losses: number, pushes = 0) => ({ key, wins, losses, pushes });
  check(
    "orderTilesByPickCount: by wins + losses + pushes desc; ties keep input order",
    orderTilesByPickCount([t("FAV_ML", 5, 5), t("OVER", 40, 30), t("PTS_PROP", 3, 2, 5), t("REB_PROP", 1, 0), t("UNDER", 60, 10)]).map((x) => x.key),
    ["OVER", "UNDER", "FAV_ML", "PTS_PROP", "REB_PROP"]
  );
  const input = [t("A", 1, 1), t("B", 1, 1)];
  orderTilesByPickCount(input);
  check("orderTilesByPickCount does not reorder its input", input.map((x) => x.key), ["A", "B"]);

  // /live: a chip set in chip-set order, records that disagree with it.
  const chip = chipSetForLeague("NBA").map((key) => ({ key, label: PICK_CATEGORY_LABELS[key] }));
  const breakdown = [
    { key: "FAV_ML" as PickCategoryKey, wins: 10, losses: 8, pushes: 0, winPct: 55.6 },
    { key: "PTS_PROP" as PickCategoryKey, wins: 120, losses: 100, pushes: 2, winPct: 54.5 },
    { key: "OVER" as PickCategoryKey, wins: 50, losses: 40, pushes: 1, winPct: 55.6 },
    { key: "DOUBLE_DOUBLE_PROP" as PickCategoryKey, wins: 1, losses: 0, pushes: 0, winPct: 100 },
    { key: "SPREAD_MINUS" as PickCategoryKey, wins: 9, losses: 9, pushes: 0, winPct: 50 },
  ];
  const tiles = buildCategoryTiles(chip, breakdown, new Map<PickCategoryKey, number>([["REB_PROP", 4]]));
  check(
    "/live tiles: most picks first; a 1-pick market keeps its own tile (no fold); a slate-only tile (0 decided) last",
    tiles.map((x) => [x.key, x.wins + x.losses + x.pushes]),
    [["PTS_PROP", 222], ["OVER", 91], ["FAV_ML", 18], ["SPREAD_MINUS", 18], ["DOUBLE_DOUBLE_PROP", 1], ["REB_PROP", 0]]
  );
}

// ---- 3. See more: 12 shown, toggle only past 12, collapsed by default ----
{
  const n = (count: number) => Array.from({ length: count }, (_, i) => i);
  check("collapsed size is two rows of six", CATEGORY_TILES_COLLAPSED, 12);
  check("12 tiles: all shown, no toggle", [visibleCategoryTiles(n(12), false).shown.length, visibleCategoryTiles(n(12), false).toggle], [12, false]);
  check("13 tiles collapsed: first 12, toggle", [visibleCategoryTiles(n(13), false).shown, visibleCategoryTiles(n(13), false).toggle], [n(12), true]);
  check("13 tiles expanded: all 13, toggle (Show less)", [visibleCategoryTiles(n(13), true).shown.length, visibleCategoryTiles(n(13), true).toggle], [13, true]);
  check("3 tiles: no toggle either way", [visibleCategoryTiles(n(3), true).toggle, visibleCategoryTiles(n(3), false).toggle], [false, false]);
}

// ---- 4. /picks filter: each sport's prop options = its family's keyed markets ----
{
  const keyed = (family: keyof typeof PROP_CATEGORY_BY_FAMILY) =>
    Object.entries(PROP_CATEGORY_BY_FAMILY[family]).filter(([, slot]) => slot !== "OTHER").map(([m]) => m).sort();
  const allMarkets = new Set(Object.keys(PROP_CATEGORY_BY_FAMILY.FOOTBALL));
  const propOptions = (league: string) => [...betTypeOptionsForChipSet(chipSetForLeague(league))].filter((k) => allMarkets.has(k)).sort();
  check("NFL: the 13 football markets", propOptions("NFL"), keyed("FOOTBALL"));
  check("NBA: the 12 basketball markets", propOptions("NBA"), keyed("BASKETBALL"));
  check("WNBA: the 12 basketball markets", propOptions("WNBA"), keyed("BASKETBALL"));
  check("NHL: the 6 hockey markets", propOptions("NHL"), keyed("HOCKEY"));
  check("MLB: the 8 baseball markets", propOptions("MLB"), keyed("BASEBALL"));
  check("NCAAF / NCAAB / KBO / ATP: no prop option (no prop tiles)", ["NCAAF", "NCAAB", "KBO", "ATP"].map((l) => propOptions(l).length), [0, 0, 0, 0]);
  check("MLB keeps NRFI / YRFI", ["NRFI", "YRFI"].every((k) => betTypeOptionsForChipSet(chipSetForLeague("MLB")).has(k as never)), true);
  check("every PropMarket value has a filter option (All sports lists them all)", [...allMarkets].filter((m) => !BET_TYPE_FILTER_OPTIONS.some((o) => o.value === m)), []);
  check("filter option values are unique", new Set(BET_TYPE_FILTER_OPTIONS.map((o) => o.value)).size, BET_TYPE_FILTER_OPTIONS.length);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
