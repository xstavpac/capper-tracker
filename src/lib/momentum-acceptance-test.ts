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
check("x ticks every 2 h from the first hour, in CT", m.xTicks.map((t) => t.label), ["2PM", "4PM", "6PM", "8PM", "10PM"]);

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
  ["2PM", false], ["4PM", false], ["6PM", false], ["8PM", false], ["10PM", false], ["12AM Sun", true], ["2AM", false],
]);

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

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nALL PASS");
