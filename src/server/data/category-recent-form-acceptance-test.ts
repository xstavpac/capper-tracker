// Proof for the "recent form" extension to computeCategoryBreakdown - the
// secondary "63-51 (55%) all-time | 14-6 (70%) last 20" indicator on the
// /live game-card expander (game-picks-expander.tsx).
//
// The all-time half is unchanged; `recent` is an OPT-IN third arg
// (recentForm) that attaches item.recent for categories with enough volume
// for all-time to plausibly be stale. Reuses the same pickCategory grouping -
// no parallel classification.
//
// Pure: computeCategoryBreakdown takes plain arrays. Run with:
//   npx tsx src/server/data/category-recent-form-acceptance-test.ts
import {
  computeCategoryBreakdown,
  ALL_CATEGORY_KEYS,
  CATEGORY_RECENT_FORM_MIN_SAMPLE,
  CATEGORY_RECENT_FORM_WINDOW,
} from "@/server/data/stats";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

type Row = Parameters<typeof computeCategoryBreakdown>[0][number];
type Status = "WIN" | "LOSS" | "PUSH" | "PENDING";

const BASE_MS = Date.parse("2026-01-01T00:00:00Z");
let idc = 0;

// odds -150 => FAVORITE => FAV_ML ; odds +130 => UNDERDOG => DOG_ML
function mlPick(status: Status, dayIndex: number, side: "fav" | "dog" = "fav"): Row {
  return {
    id: "p" + idc++,
    status,
    gameTime: new Date(BASE_MS + dayIndex * 86_400_000),
    betType: "MONEYLINE",
    period: "FULL_GAME",
    betDetail: side === "fav" ? "Team ML" : "Dog ML",
    odds: side === "fav" ? -150 : 130,
    line: null,
    units: 1,
    sport: { name: "MLB" },
  } as unknown as Row;
}

// Build `total` FAV_ML picks where the `window` NEWEST (highest gameTime) have
// exactly `w`/`l`/`p` and everything older is a filler WIN.
function favSeries(total: number, window: number, w: number, l: number, p: number): Row[] {
  const older = total - window;
  const rows: Row[] = [];
  for (let i = 0; i < older; i++) rows.push(mlPick("WIN", i));
  const recentStatuses: Status[] = [
    ...Array<Status>(w).fill("WIN"),
    ...Array<Status>(l).fill("LOSS"),
    ...Array<Status>(p).fill("PUSH"),
  ];
  recentStatuses.forEach((s, i) => rows.push(mlPick(s, older + i)));
  return rows; // ascending gameTime; the last `window` are the recent window
}

const RECENT = { window: CATEGORY_RECENT_FORM_WINDOW, minSample: CATEGORY_RECENT_FORM_MIN_SAMPLE };
const favItem = (rows: Row[], recentForm?: { window: number; minSample: number }) =>
  computeCategoryBreakdown(rows, ALL_CATEGORY_KEYS, recentForm).find((i) => i.key === "FAV_ML");

function main() {
  // ---- 1. Below the gate (99 decided) -> recent is null ----
  {
    const item = favItem(favSeries(99, 20, 14, 6, 0), RECENT);
    check("1: 99 decided FAV_ML -> count 99", item?.count, 99);
    check("1: recent is null below MIN_SAMPLE", item?.recent, null);
  }

  // ---- 2. Exactly at the gate (100 decided) -> recent = last 20 by gameTime desc ----
  {
    const item = favItem(favSeries(100, 20, 14, 6, 0), RECENT);
    check("2: 100 decided -> all-time count 100", item?.count, 100);
    check(
      "2: recent = the 20 newest picks (14-6, 70%)",
      item?.recent,
      { wins: 14, losses: 6, pushes: 0, winPct: 70, count: 20 }
    );
    // all-time is unchanged: 80 filler wins + 14 recent wins = 94-6
    check("2: all-time record unaffected by the recent slice", { w: item?.wins, l: item?.losses }, { w: 94, l: 6 });
  }

  // ---- 3. Per-category isolation - FAV_ML and DOG_ML each get their OWN last 20 ----
  {
    const favRows = favSeries(100, 20, 15, 5, 0);
    const dogRows: Row[] = [];
    for (let i = 0; i < 80; i++) dogRows.push(mlPick("WIN", 1000 + i, "dog"));
    const dogRecent: Status[] = [...Array<Status>(8).fill("WIN"), ...Array<Status>(12).fill("LOSS")];
    dogRecent.forEach((s, i) => dogRows.push(mlPick(s, 1080 + i, "dog")));

    const items = computeCategoryBreakdown([...favRows, ...dogRows], ALL_CATEGORY_KEYS, RECENT);
    const fav = items.find((i) => i.key === "FAV_ML");
    const dog = items.find((i) => i.key === "DOG_ML");
    check("3: FAV_ML recent is its own last 20 (15-5)", { w: fav?.recent?.wins, l: fav?.recent?.losses }, { w: 15, l: 5 });
    check("3: DOG_ML recent is its own last 20 (8-12), not blended", { w: dog?.recent?.wins, l: dog?.recent?.losses }, { w: 8, l: 12 });
  }

  // ---- 4. Pushes: count toward the gate + the record string, excluded from winPct ----
  {
    // 88 filler W + last-20 of 12W/4L/4P = 108 decided total; recent window
    // has 4 pushes -> winPct = 12/(12+4) = 75, count 20.
    const item = favItem(favSeries(108, 20, 12, 4, 4), RECENT);
    check("4: recent counts pushes toward count, not winPct", item?.recent, { wins: 12, losses: 4, pushes: 4, winPct: 75, count: 20 });

    // Gate is on DECIDED count (W+L+P): 96 W/L + 4 P = 100 -> recent present.
    const rows: Row[] = [];
    for (let i = 0; i < 96; i++) rows.push(mlPick(i % 2 === 0 ? "WIN" : "LOSS", i));
    for (let i = 0; i < 4; i++) rows.push(mlPick("PUSH", 96 + i));
    const gated = favItem(rows, RECENT);
    check("4: pushes count toward the 100-pick gate", { count: gated?.count, hasRecent: gated?.recent !== null }, { count: 100, hasRecent: true });
  }

  // ---- 5. No recentForm arg -> no `recent` key at all (back-compat) ----
  {
    const item = favItem(favSeries(150, 20, 14, 6, 0)); // no third arg
    check("5: recent key absent when recentForm not passed", item !== undefined && "recent" in item, false);
    check("5: all-time still computed", item?.count, 150);
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
