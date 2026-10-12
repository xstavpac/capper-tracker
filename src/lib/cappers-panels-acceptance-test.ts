// The panel windows' date ranges (cappers-panels.ts: yesterdayRange / panelRange) - run with:
//   npx tsx src/lib/cappers-panels-acceptance-test.ts
//
// "Yesterday" on the Most Active / Biggest Winners / Hot Hand / Coldest cards is the previous Eastern
// CALENDAR day, Eastern midnight to Eastern midnight (the boundary "Today" starts on): never a rolling
// 24 hours, and never the server's own timezone. Pure: no database.
import { panelRange, yesterdayRange } from "./cappers-panels";
import { easternDateKey } from "./dates";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const iso = (r: { start: Date; end: Date }) => [r.start.toISOString(), r.end.toISOString()];
const at = (s: string) => new Date(s);
// The filter the panels' SQL applies: start <= t < end.
const inRange = (r: { start: Date; end: Date }, t: Date) => t >= r.start && t < r.end;

function main() {
  // Eastern is UTC-4 (EDT) in October: midnight ET is 04:00Z.
  check("midday ET: the whole Eastern day before", iso(yesterdayRange(at("2026-10-12T16:00:00.000Z"))), ["2026-10-11T04:00:00.000Z", "2026-10-12T04:00:00.000Z"]);
  // 10pm ET is already the next day in UTC: the Eastern day decides, not the UTC one.
  check("late evening ET (next day in UTC): still the Eastern day before", iso(yesterdayRange(at("2026-10-13T02:00:00.000Z"))), ["2026-10-11T04:00:00.000Z", "2026-10-12T04:00:00.000Z"]);

  // The boundary right at Eastern midnight.
  check("1 ms before Eastern midnight: still the old day, so yesterday is the day before it", iso(yesterdayRange(at("2026-10-12T03:59:59.999Z"))), ["2026-10-10T04:00:00.000Z", "2026-10-11T04:00:00.000Z"]);
  check("exactly Eastern midnight: the new day has begun, so yesterday is the day that just ended", iso(yesterdayRange(at("2026-10-12T04:00:00.000Z"))), ["2026-10-11T04:00:00.000Z", "2026-10-12T04:00:00.000Z"]);
  check("1 ms after Eastern midnight: the same", iso(yesterdayRange(at("2026-10-12T04:00:00.001Z"))), ["2026-10-11T04:00:00.000Z", "2026-10-12T04:00:00.000Z"]);

  // Which picks the range holds: [start, end).
  {
    const r = yesterdayRange(at("2026-10-12T16:00:00.000Z"));
    check("a pick at yesterday's Eastern midnight is in", inRange(r, at("2026-10-11T04:00:00.000Z")), true);
    check("a pick 1 ms before it is the day before: out", inRange(r, at("2026-10-11T03:59:59.999Z")), false);
    check("a pick 1 ms before today's Eastern midnight is in", inRange(r, at("2026-10-12T03:59:59.999Z")), true);
    check("a pick at today's Eastern midnight is today's: out", inRange(r, at("2026-10-12T04:00:00.000Z")), false);
    check("every instant in it is the same Eastern calendar day", [easternDateKey(r.start), easternDateKey(new Date(r.end.getTime() - 1))], ["2026-10-11", "2026-10-11"]);
  }

  // A calendar day, not the last 24 hours: at 1am ET...
  {
    const r = yesterdayRange(at("2026-10-12T05:00:00.000Z"));
    check("1am ET: a pick 30 minutes ago (today) is out", inRange(r, at("2026-10-12T04:30:00.000Z")), false);
    check("1am ET: a pick 24.5 hours ago (yesterday, 12:30am ET) is in", inRange(r, at("2026-10-11T04:30:00.000Z")), true);
  }
  // ...and at 11pm ET.
  {
    const r = yesterdayRange(at("2026-10-13T03:00:00.000Z"));
    check("11pm ET: a pick 20 hours ago (today, 3am ET) is out", inRange(r, at("2026-10-12T07:00:00.000Z")), false);
    check("11pm ET: a pick 46 hours ago (yesterday, 1am ET) is in", inRange(r, at("2026-10-11T05:00:00.000Z")), true);
  }

  // Clock changes: the day they fall on is not 24 hours long. Fall back, Sunday 2026-11-01 (25 hours).
  check("the day after fall back: yesterday is the whole 25-hour day", iso(yesterdayRange(at("2026-11-02T15:00:00.000Z"))), ["2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"]);
  check("on the fall-back day: yesterday is an ordinary 24-hour day", iso(yesterdayRange(at("2026-11-01T12:00:00.000Z"))), ["2026-10-31T04:00:00.000Z", "2026-11-01T04:00:00.000Z"]);
  check("fall back, exactly Eastern midnight after it (05:00Z)", iso(yesterdayRange(at("2026-11-02T05:00:00.000Z"))), ["2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"]);
  check("fall back, 1 ms before that midnight: still the 25-hour day", iso(yesterdayRange(at("2026-11-02T04:59:59.999Z"))), ["2026-10-31T04:00:00.000Z", "2026-11-01T04:00:00.000Z"]);
  // Spring forward, Sunday 2026-03-08 (23 hours).
  check("the day after spring forward: yesterday is the whole 23-hour day", iso(yesterdayRange(at("2026-03-09T15:00:00.000Z"))), ["2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"]);
  check("on the spring-forward day: yesterday is an ordinary 24-hour day", iso(yesterdayRange(at("2026-03-08T12:00:00.000Z"))), ["2026-03-07T05:00:00.000Z", "2026-03-08T05:00:00.000Z"]);

  // Month and year ends (EST: midnight ET is 05:00Z).
  check("New Year's Day, 1am ET: yesterday is December 31 of the year before", iso(yesterdayRange(at("2026-01-01T06:00:00.000Z"))), ["2025-12-31T05:00:00.000Z", "2026-01-01T05:00:00.000Z"]);
  check("March 1, a non-leap year: yesterday is February 28", iso(yesterdayRange(at("2026-03-01T17:00:00.000Z"))), ["2026-02-28T05:00:00.000Z", "2026-03-01T05:00:00.000Z"]);

  // panelRange: Yesterday ends exactly where Today starts (the same boundary), and is the only closed window.
  for (const now of ["2026-10-12T16:00:00.000Z", "2026-10-12T04:00:00.000Z", "2026-11-02T15:00:00.000Z", "2026-03-09T15:00:00.000Z"]) {
    const y = panelRange("yesterday", at(now));
    const t = panelRange("today", at(now));
    check(`panelRange("yesterday") == yesterdayRange [${now}]`, iso(y), iso(yesterdayRange(at(now))));
    check(`Yesterday ends where Today starts, no gap and no overlap [${now}]`, y.end.toISOString(), t.start.toISOString());
  }
  const NOW = at("2026-10-12T16:00:00.000Z");
  check("only Yesterday is closed (ended before now)", [panelRange("today", NOW).closed, panelRange("yesterday", NOW).closed, panelRange("week", NOW).closed, panelRange("30d", NOW).closed], [undefined, true, undefined, undefined]);
  check("Today is unchanged: Eastern midnight to now", iso(panelRange("today", NOW)), ["2026-10-12T04:00:00.000Z", NOW.toISOString()]);
  check("This week is unchanged: the 7 days before now", iso(panelRange("week", NOW)), ["2026-10-05T16:00:00.000Z", NOW.toISOString()]);
  check("Last 30 days is unchanged: the 30 days before now", iso(panelRange("30d", NOW)), ["2026-09-12T16:00:00.000Z", NOW.toISOString()]);

  console.log(failures === 0 ? "\nAll cappers-panels checks passed." : `\n${failures} cappers-panels check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main();
