// Today's Momentum (momentum.ts): the time-zone conversion of gradedAt, the one-point-per-minute running
// series, the axes, the trend pill and the agreement with the Net Units tile. Pure - no DB. Run with:
//   npx tsx src/lib/momentum-acceptance-test.ts
import {
  buildMomentum,
  clockLabel,
  floorToHour,
  greenShare,
  localParts,
  momentumEvents,
  momentumMatchesTile,
  xTicksFor,
  yAxisFor,
} from "@/lib/momentum";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const CT = "America/Chicago";
const at = (iso: string) => new Date(iso + "Z").getTime();

// ---- time zone: gradedAt is a timestamp WITHOUT time zone, read as UTC wall-clock ----
// A row stored as 2026-11-08 03:15 (UTC) is 9:15 PM on Nov 7 for a viewer in Central.
const stored = new Date("2026-11-08T03:15:00.000Z"); // what Prisma hands the page for 2026-11-08 03:15
check("03:15 UTC plots at 9:15 PM CT", clockLabel(stored.getTime(), CT), "9:15 PM");
check("...on Nov 7 (Saturday)", [localParts(stored.getTime(), CT).dayKey, localParts(stored.getTime(), CT).weekday], ["2026-11-7", "Sat"]);
check("same instant in Eastern is 10:15 PM", clockLabel(stored.getTime(), "America/New_York"), "10:15 PM");
check("hour floor is in the viewer's zone", new Date(floorToHour(at("2026-11-07T21:47:30"), CT)).toISOString(), "2026-11-07T21:00:00.000Z");
check("midnight is hour 12 AM, not 24", clockLabel(at("2026-11-08T06:05:00"), CT), "12:05 AM");

// ---- events ----
const pick = (status: string, gradedAt: string | null, units = 1, odds = -110) => ({ status, units, odds, gradedAt: gradedAt ? new Date(gradedAt + "Z") : null });
const ev = momentumEvents([
  pick("WIN", "2026-11-07T20:15:03", 1, 100),
  pick("LOSS", "2026-11-07T20:15:40", 2),
  pick("PUSH", "2026-11-07T20:20:00"),
  pick("PENDING", null),
  pick("CANCELLED", "2026-11-07T21:00:00"),
  pick("LOSS", null, 1.5),
]);
check("events: settled with a time, pushes/pending/cancelled dropped, unstamped summed", [ev.events.map((e) => e.d), ev.unstamped], [[1, -2], -1.5]);

// ---- series: one point per grading minute, starts at 0 on the hour, ends on the tile's net ----
const NOW = at("2026-11-08T05:30:00"); // 11:30 PM CT Nov 7
const m = buildMomentum(
  [
    { t: at("2026-11-07T20:15:03"), d: 1 }, // 2:15 PM CT
    { t: at("2026-11-07T20:15:40"), d: -2 }, // same minute: merged
    { t: at("2026-11-07T22:40:00"), d: -3.5 },
    { t: at("2026-11-08T01:10:00"), d: 5 },
  ],
  0,
  { now: NOW, isToday: true, tz: CT }
);
check("starts at the hour before the first grade, at 0", [new Date(m.points[0].t).toISOString(), m.points[0].v], ["2026-11-07T20:00:00.000Z", 0]);
check("same-minute grades are one point", m.points.map((p) => [p.v, p.change]), [[0, 0], [-1, -1], [-4.5, -3.5], [0.5, 5]]);
check("first real point's change is since the start point", [m.points[1].prevT === m.points[0].t, m.points[0].prevT], [true, null]);
check("last point is the net", m.net, 0.5);
check("today: x runs to now", [m.xStart, m.xEnd], [at("2026-11-07T20:00:00"), NOW]);
check("9.5 h span: 4 h steps on clock multiples, in CT", m.xTicks.map((t) => t.label), ["4PM", "8PM"]);

// ---- a past day that grades past midnight: the first tick after midnight carries the day ----
const past = buildMomentum(
  [
    { t: at("2026-11-07T20:15:00"), d: 2 },
    { t: at("2026-11-08T08:30:00"), d: -1 }, // 2:30 AM CT Sun
  ],
  0,
  { now: at("2026-11-09T15:00:00"), isToday: false, tz: CT }
);
check("past day ends at the last grade", past.xEnd, at("2026-11-08T08:30:00"));
check("midnight tick labelled with the day, stronger gridline", past.xTicks.map((t) => [t.label, t.dayStart]), [
  ["4PM", false], ["8PM", false], ["12AM Sun", true],
]);

// ---- tick density: step from the span, on local clock multiples, <= 6 labels, no duplicates ----
const ticksFor = (s: string, e: string) => xTicksFor(at(s), at(e), CT);
const shortT = ticksFor("2026-11-07T20:00:00", "2026-11-07T23:00:00"); // 2 PM -> 5 PM CT, 3 h
check("short span (3 h): 2 h steps", shortT.map((t) => t.label), ["2PM", "4PM"]);
const medT = ticksFor("2026-11-07T20:00:00", "2026-11-08T06:00:00"); // 2 PM -> 12 AM CT, 10 h
check("medium span (10 h): 4 h steps", medT.map((t) => t.label), ["4PM", "8PM", "12AM Sun"]);
const longT = ticksFor("2026-11-08T04:00:00", "2026-11-08T23:30:00"); // 10 PM Sat -> 5:30 PM Sun CT, 19.5 h
check("long span (~20 h) crossing midnight early: 6 h steps, weekday on midnight", longT.map((t) => [t.label, t.dayStart]), [
  ["12AM Sun", true], ["6AM", false], ["12PM", false],
]);
for (const [name, ts] of [["short", shortT], ["medium", medT], ["long", longT]] as const) {
  const labels = ts.map((t) => t.label);
  check(name + " span: <= 6 ticks, no duplicate labels", [labels.length <= 6, new Set(labels).size === labels.length], [true, true]);
}
check("first tick is on a clock multiple after xStart", medT[0].t > at("2026-11-07T20:00:00"), true);

// ---- y axis: every 20u, 0 always present ----
check("y ticks for -42.15..20.6", yAxisFor(-42.15, 20.6).ticks, [-60, -40, -20, 0, 20, 40]);
check("y ticks, positive only", yAxisFor(3, 31).ticks, [0, 20, 40]);
check("y ticks, negative only", yAxisFor(-30, -2).ticks, [-40, -20, 0]);
check("y ticks, nothing graded", yAxisFor(0, 0).ticks, [-20, 0, 20]);
check("y ticks widen the step rather than draw 30 labels", yAxisFor(-400, 380).ticks.length <= 9, true);
check("green share: split at zero", [greenShare(-20, 60), greenShare(5, 30), greenShare(-30, -1), greenShare(0, 0)], [0.75, 1, 0, 1]);

// ---- trend over the last 2 hours (to now on today): |change| < 1.5u is flat ----
const trendOf = (events: { t: number; d: number }[], now = at("2026-11-08T02:00:00")) => buildMomentum(events, 0, { now, isToday: true, tz: CT }).trend;
const T0 = at("2026-11-07T20:00:00");
check("trend up: +6u in the last 2 h", trendOf([{ t: T0, d: -2 }, { t: at("2026-11-08T01:00:00"), d: 6 }]), "up");
check("trend down: -3u in the last 2 h", trendOf([{ t: T0, d: 5 }, { t: at("2026-11-08T01:30:00"), d: -3 }]), "down");
check("flat: only +1.4u in the last 2 h", trendOf([{ t: T0, d: 5 }, { t: at("2026-11-08T01:30:00"), d: 1.4 }]), "flat");
check("flat: nothing graded in the last 2 h", trendOf([{ t: T0, d: 9 }]), "flat");
check("exactly 1.5u is a trend (flat is < 1.5)", trendOf([{ t: T0, d: 5 }, { t: at("2026-11-08T01:30:00"), d: 1.5 }]), "up");

// ---- empty state, unstamped picks, agreement with the tile ----
const e = buildMomentum([], 0, { now: NOW, isToday: true, tz: CT });
check("nothing graded: empty, flat at 0, three y ticks", [e.empty, e.net, e.points.map((p) => p.v), e.trend, e.yTicks], [true, 0, [0], "flat", [-20, 0, 20]]);
const u = buildMomentum([{ t: at("2026-11-07T20:15:00"), d: 2 }], -1.5, { now: NOW, isToday: true, tz: CT });
check("a settled pick with no gradedAt still reaches the last point", u.net, 0.5);
const tile = 2 - 1.5;
check("last point equals the tile", [momentumMatchesTile(u.net, tile), momentumMatchesTile(u.net, tile + 0.02)], [true, false]);
const full = momentumEvents([pick("WIN", "2026-11-07T20:15:03", 1, 150), pick("LOSS", "2026-11-07T22:00:00", 2), pick("WIN", "2026-11-07T23:00:00", 1, -120), pick("LOSS", null, 1)]);
check("events -> series ends on the same net as summing the picks", buildMomentum(full.events, full.unstamped, { now: NOW, isToday: true, tz: CT }).net, Math.round((1.5 - 2 + 100 / 120 - 1) * 100) / 100);

// ---- past day: late grades fold into the last in-day point; the axis stays inside the day ----
// Eastern Nov 4 2026 ends at 2026-11-05T05:00Z (EST). Viewer in Central.
const DAY_END = at("2026-11-05T05:00:00");
const past0 = (events: { t: number; d: number }[], unstamped = 0, dayEnd: number | undefined = DAY_END) =>
  buildMomentum(events, unstamped, { now: at("2026-11-09T12:00:00"), isToday: false, tz: CT, dayEnd });
const inDay = [
  { t: at("2026-11-04T20:00:00"), d: 1 },
  { t: at("2026-11-05T02:00:00"), d: -2 },
];
const noLate = past0(inDay);
check("no late grades: xEnd = last grade (unchanged)", noLate.xEnd, at("2026-11-05T02:00:00"));
check("no late grades: same as before the clamp existed", JSON.stringify(noLate), JSON.stringify(past0(inDay, 0, undefined)));
check("no late grades: net", noLate.net, -1);

const oneLate = past0([...inDay, { t: at("2026-11-08T03:15:00"), d: 3 }]);
check("one late grade: xEnd stays at day end", oneLate.xEnd, DAY_END);
check("one late grade: no extra point", oneLate.points.length, 3);
check("one late grade: folded into the last point, which sits at day end", [oneLate.points[2].t, oneLate.points[2].v, oneLate.points[2].change], [DAY_END, 2, 1]);
check("one late grade: net equals the full total", oneLate.net, 2);
check("one late grade: no tick beyond day end", oneLate.xTicks.every((k) => k.t <= DAY_END), true);

const manyLate = past0([...inDay, { t: at("2026-11-06T01:00:00"), d: 1 }, { t: at("2026-11-08T03:15:00"), d: 2 }, { t: at("2026-11-09T01:00:00"), d: -0.5 }]);
check("many late grades: xEnd at day end", manyLate.xEnd, DAY_END);
check("many late grades: single last point carries the full total", [manyLate.points.length, manyLate.net], [3, 1.5]);
check("many late grades: final point x = dayEnd = xEnd", [manyLate.points[2].t, manyLate.points[2].t === manyLate.xEnd], [DAY_END, true]);
check("no late grades: final point x is still the real last grade", noLate.points[2].t, at("2026-11-05T02:00:00"));

const allLate = past0([{ t: at("2026-11-08T03:15:00"), d: 2 }]);
check("only late grades: one point, inside the day, net kept", [allLate.points.length, allLate.net, allLate.points[1].t, allLate.xEnd], [2, 2, DAY_END, DAY_END]);
const lateNight = past0([{ t: at("2026-11-05T04:30:00"), d: 1 }]);
check("grade at 11:30 PM CT: axis never exceeds day end, keeps 2h span", [lateNight.xEnd <= DAY_END, lateNight.xEnd - lateNight.xStart >= 2 * 3600000], [true, true]);
const todayEv = buildMomentum([{ t: at("2026-11-08T03:15:00"), d: 1 }], 0, { now: at("2026-11-08T06:00:00"), isToday: true, tz: CT, dayEnd: at("2026-11-08T05:00:00") });
check("today ignores dayEnd: xEnd = max(last, now)", todayEv.xEnd, at("2026-11-08T06:00:00"));

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nALL PASS");
