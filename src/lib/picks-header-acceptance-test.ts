// Proof for the /picks header helpers - run with:
//   npx tsx src/lib/picks-header-acceptance-test.ts
import {
  cumulativeUnitsSeries,
  dateStepHref,
  shiftDateKey,
  sportChipLayout,
  topAndColdest,
  winRatePct,
  type HeaderPick,
} from "./picks-header";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

let n = 0;
function pick(o: Partial<HeaderPick>): HeaderPick {
  n++;
  return {
    capperId: "c1",
    capperName: "Alpha",
    sportId: "s1",
    sportName: "NBA",
    status: "WIN",
    units: 1,
    odds: 100,
    gameTime: new Date(Date.UTC(2026, 8, 29, 12, n)),
    gradedAt: null,
    ...o,
  };
}
const two = (id: string, name: string, a: string, b: string) => [
  pick({ capperId: id, capperName: name, status: a }),
  pick({ capperId: id, capperName: name, status: b }),
];

// Win rate: pushes excluded.
check("win rate 13-8 (pushes never in denominator)", winRatePct(13, 8), 62);
check("win rate 5-3", winRatePct(5, 3), 63);
check("win rate 0-0 -> null", winRatePct(0, 0), null);
check("win rate 0-2", winRatePct(0, 2), 0);

// Sparkline.
check("no settled -> null", cumulativeUnitsSeries([pick({ status: "PENDING" })]), null);
check("1 settled -> null", cumulativeUnitsSeries([pick({}), pick({ status: "PENDING" })]), null);
check(
  "cumulative, push adds 0",
  cumulativeUnitsSeries([pick({ status: "WIN" }), pick({ status: "LOSS" }), pick({ status: "PUSH" })]),
  [1, 0, 0]
);
check(
  "ordered by game time, then settle time",
  cumulativeUnitsSeries([
    pick({ status: "LOSS", gameTime: new Date("2026-09-29T20:00:00Z"), gradedAt: new Date("2026-09-29T23:00:00Z") }),
    pick({ status: "WIN", gameTime: new Date("2026-09-29T20:00:00Z"), gradedAt: new Date("2026-09-29T22:00:00Z") }),
    pick({ status: "WIN", gameTime: new Date("2026-09-29T18:00:00Z") }),
  ]),
  [1, 2, 1]
);

// Top / coldest.
const mixed = [...two("a", "Alpha", "WIN", "WIN"), ...two("b", "Bravo", "LOSS", "LOSS"), ...two("c", "Charlie", "WIN", "LOSS")];
const r1 = topAndColdest(mixed, false);
check("top / coldest names", [r1?.top?.name, r1?.coldest?.name], ["Alpha", "Bravo"]);
check("top W-L and units", [r1?.top?.wins, r1?.top?.losses, r1?.top?.units], [2, 0, 2]);
check("single capper filtered -> hidden", topAndColdest(mixed, true), null);
check("nobody with 2 settled -> hidden", topAndColdest([pick({ capperId: "a" }), pick({ capperId: "b" })], false), null);
check("pending picks don't qualify a capper", topAndColdest([pick({}), pick({ status: "PENDING" })], false), null);
const r2 = topAndColdest([...two("a", "Alpha", "WIN", "WIN"), ...two("c", "Charlie", "WIN", "PUSH")], false);
check("no negative capper -> coldest hidden", [r2?.top?.name, r2?.coldest], ["Alpha", null]);
// A lone -2u qualifier is Coldest only, never Top.
const r3 = topAndColdest(two("a", "Alpha", "LOSS", "LOSS"), false);
check("single -2u capper: never Top, shown as Coldest", [r3?.top, r3?.coldest?.name, r3?.coldest?.units], [null, "Alpha", -2]);
// All-negative day: only Coldest.
const r4 = topAndColdest([...two("a", "Alpha", "LOSS", "LOSS"), ...two("b", "Bravo", "LOSS", "WIN")], false);
check("all-negative day -> only Coldest", [r4?.top, r4?.coldest?.name], [null, "Alpha"]);
// All-positive day: only Top.
const r5 = topAndColdest([...two("a", "Alpha", "WIN", "WIN"), ...two("b", "Bravo", "WIN", "PUSH")], false);
check("all-positive day -> only Top", [r5?.top?.name, r5?.coldest], ["Alpha", null]);
// Break-even qualifiers (0u) are neither Top nor Coldest -> strip hidden.
check("everyone at 0u -> hidden", topAndColdest(two("a", "Alpha", "WIN", "LOSS"), false), null);
// Units tie at 0: Alpha 1-1; Bravo 2-1 with a 2u loss (+1 +1 -2 = 0). Better record wins the top slot.
const tied = [
  ...two("a", "Alpha", "WIN", "LOSS"),
  pick({ capperId: "b", capperName: "Bravo", status: "WIN" }),
  pick({ capperId: "b", capperName: "Bravo", status: "WIN" }),
  pick({ capperId: "b", capperName: "Bravo", status: "LOSS", units: 2 }),
];
check("tied pair at 0u alone -> hidden", topAndColdest(tied, false), null);
// Tie at +2u: Alpha 2-0 vs Bravo 3-1 (three +1 wins, one -1 loss). Better win rate is top.
const topTied = [
  ...two("a", "Alpha", "WIN", "WIN"),
  ...two("b", "Bravo", "WIN", "WIN"),
  pick({ capperId: "b", capperName: "Bravo", status: "WIN" }),
  pick({ capperId: "b", capperName: "Bravo", status: "LOSS" }),
];
check("units tie at +2: better record is top", topAndColdest(topTied, false)?.top?.name, "Alpha");
// Coldest tie-break mirrors: at equal negative units the worse record is coldest.
const coldTied = [
  ...two("a", "Alpha", "LOSS", "PUSH"), // -1, 0-1-1
  pick({ capperId: "b", capperName: "Bravo", status: "WIN" }),
  pick({ capperId: "b", capperName: "Bravo", status: "LOSS", units: 2 }), // -1, 1-1
  ...two("z", "Zed", "WIN", "WIN"),
];
check("cold tie: worse record is coldest", topAndColdest(coldTied, false)?.coldest?.name, "Alpha");

// Sport chips.
const sp = (id: string, k: number) => Array.from({ length: k }, () => ({ sportId: id, sportName: id.toUpperCase() }));
const all = [...sp("f", 1), ...sp("a", 9), ...sp("b", 7), ...sp("e", 2), ...sp("c", 5), ...sp("d", 3)];
const L = sportChipLayout(all, null);
check("sorted by count desc, top 4", L.visible.map((s) => s.id + s.count), ["a9", "b7", "c5", "d3"]);
check("overflow goes to More", L.more.map((s) => s.id), ["e", "f"]);
check("total (All sports count)", L.total, 27);
const L2 = sportChipLayout(all, "f");
check("selected sport inside More becomes visible", L2.visible.map((s) => s.id), ["a", "b", "c", "f"]);
check("displaced chip moves to More", L2.more.map((s) => s.id), ["d", "e"]);
check("4 or fewer sports -> no More", sportChipLayout(sp("a", 2), null).more, []);
check("selected visible sport leaves layout alone", sportChipLayout(all, "b").visible.map((s) => s.id), ["a", "b", "c", "d"]);

// Date arrows.
check("shift back", shiftDateKey("2026-09-29", -1), "2026-09-28");
check("shift over month", shiftDateKey("2026-09-30", 1), "2026-10-01");
check("shift over year", shiftDateKey("2026-01-01", -1), "2025-12-31");
check("shift across DST end", shiftDateKey("2026-11-01", 1), "2026-11-02");
check("href sets date, keeps other params", dateStepHref("/picks", "capperId=x&date=2026-09-29", "2026-09-29", -1), "/picks?capperId=x&date=2026-09-28");
check("href from default (no param)", dateStepHref("/picks", "", "2026-09-29", 1), "/picks?date=2026-09-30");
check("href drops range params", dateStepHref("/picks", "startDate=a&endDate=b", "2026-09-29", 1), "/picks?date=2026-09-30");

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nAll passed");
