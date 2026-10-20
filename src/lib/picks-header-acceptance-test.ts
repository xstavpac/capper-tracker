// Proof for the /picks header helpers - run with:
//   npx tsx src/lib/picks-header-acceptance-test.ts
import {
  cumulativeUnitsSeries,
  dateStepHref,
  MAX_PICKS_RANGE_DAYS,
  resolveDateFilter,
  shiftDateKey,
  sportChipLayout,
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
// resolveDateFilter: the page's date params -> one Eastern-day range, a range over 31 days clamped.
const T = "2026-10-20";
check("max range is 31 days", MAX_PICKS_RANGE_DAYS, 31);
check("no params: today", resolveDateFilter({}, T), { startDateKey: T, endDateKey: T, isRange: false, clamped: false });
check("single date", resolveDateFilter({ date: "2026-10-01" }, T), { startDateKey: "2026-10-01", endDateKey: "2026-10-01", isRange: false, clamped: false });
check("one-sided range: start only", resolveDateFilter({ startDate: "2026-10-01" }, T), { startDateKey: "2026-10-01", endDateKey: "2026-10-01", isRange: true, clamped: false });
check("one-sided range: end only", resolveDateFilter({ endDate: "2026-10-05" }, T), { startDateKey: "2026-10-05", endDateKey: "2026-10-05", isRange: true, clamped: false });
check("reversed range is swapped", resolveDateFilter({ startDate: "2026-10-10", endDate: "2026-10-01" }, T), { startDateKey: "2026-10-01", endDateKey: "2026-10-10", isRange: true, clamped: false });
check("exactly 31 days: unchanged", resolveDateFilter({ startDate: "2026-09-20", endDate: "2026-10-20" }, T), { startDateKey: "2026-09-20", endDateKey: "2026-10-20", isRange: true, clamped: false });
check("32 days: clamped to the last 31 (end kept)", resolveDateFilter({ startDate: "2026-09-19", endDate: "2026-10-20" }, T), { startDateKey: "2026-09-20", endDateKey: "2026-10-20", isRange: true, clamped: true });
check("a season: clamped, end kept", resolveDateFilter({ startDate: "2026-03-01", endDate: "2026-10-20" }, T), { startDateKey: "2026-09-20", endDateKey: "2026-10-20", isRange: true, clamped: true });
check("reversed and too long: swapped, then clamped", resolveDateFilter({ startDate: "2026-10-20", endDate: "2025-01-01" }, T), { startDateKey: "2026-09-20", endDateKey: "2026-10-20", isRange: true, clamped: true });
check("clamp across a year boundary", resolveDateFilter({ startDate: "2025-06-01", endDate: "2026-01-15" }, T), { startDateKey: "2025-12-16", endDateKey: "2026-01-15", isRange: true, clamped: true });
check("clamp across DST end (Nov 1)", resolveDateFilter({ startDate: "2026-09-01", endDate: "2026-11-15" }, T), { startDateKey: "2026-10-16", endDateKey: "2026-11-15", isRange: true, clamped: true });
{
  const r = resolveDateFilter({ startDate: "2026-01-01", endDate: "2026-12-31" }, T);
  const days = (Date.parse(r.endDateKey) - Date.parse(r.startDateKey)) / 86400000 + 1;
  check("a clamped range spans exactly 31 days, both ends included", days, 31);
}

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nAll passed");
