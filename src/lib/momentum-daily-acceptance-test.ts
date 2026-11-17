// 7D / 30D Momentum (momentum-daily.ts): one point per Eastern day, running net = range total, today's
// partial day is the last point, 30 days is the cap, trend from the recent slope. Pure - no DB. Run with:
//   npx tsx src/lib/momentum-daily-acceptance-test.ts
import { buildDailyMomentum, MOMENTUM_RANGES, MOMENTUM_RANGE_DAYS, rangeDayKeys } from "@/lib/momentum-daily";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const END = "2026-11-17";
check("ranges are exactly 7D and 30D", [...MOMENTUM_RANGES], ["7D", "30D"]);
check("30 days is the cap", Math.max(...Object.values(MOMENTUM_RANGE_DAYS)), 30);
check("7D keys end today, oldest first", rangeDayKeys("7D", END), ["2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17"]);
check("30D spans 30 days across a month edge", [rangeDayKeys("30D", END).length, rangeDayKeys("30D", END)[0]], [30, "2026-10-19"]);

// one point per day (not per pick), empty days are real 0u days, last point = total
const m = buildDailyMomentum([{ day: "2026-11-12", net: 3.5 }, { day: "2026-11-14", net: -1.25 }, { day: "2026-11-17", net: 0.5 }], "7D", END);
check("one point per day", m.points.length, 7);
check("running net", m.points.map((p) => p.v), [0, 3.5, 3.5, 2.25, 2.25, 2.25, 2.75]);
check("per-day change", m.points.map((p) => p.change), [0, 3.5, 0, -1.25, 0, 0, 0.5]);
check("last point is the range total (the big number)", m.net, 2.75);
check("today's partial day is the last bucket", m.points[6].change, 0.5);
check("not empty", m.empty, false);

// rows outside the window are ignored
const o = buildDailyMomentum([{ day: "2026-11-10", net: 99 }, { day: "2026-11-17", net: 1 }], "7D", END);
check("row before the window ignored", o.net, 1);

// no minimum-sample threshold: a single tiny pick shows as-is
const tiny = buildDailyMomentum([{ day: "2026-11-17", net: 0.09 }], "7D", END);
check("tiny day shown as real number", tiny.net, 0.09);

// empty
check("no rows -> empty, 0u", [buildDailyMomentum([], "30D", END).empty, buildDailyMomentum([], "30D", END).net], [true, 0]);

// trend: 7D looks at the last 2 days, 30D at the last 7; flat under 1.5u
check("7D up: +3u over the last 2 days", buildDailyMomentum([{ day: "2026-11-16", net: 1.5 }, { day: "2026-11-17", net: 1.5 }], "7D", END).trend, "up");
check("7D down", buildDailyMomentum([{ day: "2026-11-17", net: -2 }], "7D", END).trend, "down");
check("7D flat under 1.5u", buildDailyMomentum([{ day: "2026-11-17", net: 1.4 }], "7D", END).trend, "flat");
check("old gains don't make 7D 'up' now", buildDailyMomentum([{ day: "2026-11-12", net: 10 }], "7D", END).trend, "flat");
check("30D uses its last 7 days", buildDailyMomentum([{ day: "2026-11-01", net: 20 }, { day: "2026-11-13", net: -4 }], "30D", END).trend, "down");
check("tooltip labels carry the day", [m.points[1].label, m.points[1].prevLabel], ["Thu Nov 12", "Nov 11"]);
check("30D ticks every 5th day anchored on today", buildDailyMomentum([], "30D", END).xTicks.map((t) => t.label), ["Oct 23", "Oct 28", "Nov 2", "Nov 7", "Nov 12", "Nov 17"]);

if (failures) {
  console.log(failures + " FAILED");
  process.exit(1);
}
console.log("all passed");
