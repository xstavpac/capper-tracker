// The /cappers time tabs' "Yesterday" range (stats.ts: scorecardWindowRange / filterPicksByGameWindow) - run with:
//   npx tsx src/server/data/scorecard-window-range-acceptance-test.ts
//
// "Yesterday" is the previous Eastern CALENDAR day, Eastern midnight to Eastern midnight: the very
// range the panel cards use (cappers-panels.ts yesterdayRange), never today's midnight minus a flat
// 24 hours, which is an hour off on the day after a clock change. Pure: no database.
import { yesterdayRange } from "@/lib/cappers-panels";
import { easternDateKey } from "@/lib/dates";
import { filterPicksByGameWindow, scorecardWindowRange } from "./stats";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const at = (s: string) => new Date(s);
const yesterday = (now: string) => {
  const r = scorecardWindowRange("YESTERDAY", at(now))!;
  return [r.start.toISOString(), r.end.toISOString()];
};
// Which of these game times the Yesterday tab keeps (all graded).
const kept = (now: string, gameTimes: string[]) =>
  filterPicksByGameWindow(gameTimes.map((g) => ({ gameTime: at(g), gradedAt: at(now) })), "YESTERDAY", at(now)).map((p) => p.gameTime.toISOString());

function main() {
  // An ordinary day. Eastern is UTC-4 (EDT) in October: midnight ET is 04:00Z.
  check("midday ET: the whole Eastern day before", yesterday("2026-10-12T16:00:00.000Z"), ["2026-10-11T04:00:00.000Z", "2026-10-12T04:00:00.000Z"]);

  // The boundary right at Eastern midnight.
  check("1 ms before Eastern midnight: still the old day, so yesterday is the day before it", yesterday("2026-10-12T03:59:59.999Z"), ["2026-10-10T04:00:00.000Z", "2026-10-11T04:00:00.000Z"]);
  check("exactly Eastern midnight: the new day has begun, so yesterday is the day that just ended", yesterday("2026-10-12T04:00:00.000Z"), ["2026-10-11T04:00:00.000Z", "2026-10-12T04:00:00.000Z"]);
  check("1 ms after Eastern midnight: the same", yesterday("2026-10-12T04:00:00.001Z"), ["2026-10-11T04:00:00.000Z", "2026-10-12T04:00:00.000Z"]);

  // Fall back, Sunday 2026-11-01: a 25-hour day (04:00Z to 05:00Z). A flat 24 hours back from
  // Monday's midnight starts at 05:00Z and drops its first hour.
  check("the day after fall back: yesterday is the whole 25-hour day", yesterday("2026-11-02T15:00:00.000Z"), ["2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"]);
  check("the day after fall back: a game in the day's first hour (12:30am EDT) is kept", kept("2026-11-02T15:00:00.000Z", ["2026-11-01T04:30:00.000Z"]), ["2026-11-01T04:30:00.000Z"]);
  check("fall back, 1 ms before the midnight after it: the fall-back day is still today", yesterday("2026-11-02T04:59:59.999Z"), ["2026-10-31T04:00:00.000Z", "2026-11-01T04:00:00.000Z"]);
  check("fall back, exactly the midnight after it", yesterday("2026-11-02T05:00:00.000Z"), ["2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"]);
  check("fall back, 1 ms after the midnight after it", yesterday("2026-11-02T05:00:00.001Z"), ["2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"]);
  check("on the fall-back day: yesterday is an ordinary 24-hour day", yesterday("2026-11-01T12:00:00.000Z"), ["2026-10-31T04:00:00.000Z", "2026-11-01T04:00:00.000Z"]);

  // Spring forward, Sunday 2026-03-08: a 23-hour day (05:00Z to 04:00Z). A flat 24 hours back from
  // Monday's midnight starts at 04:00Z and takes in Saturday's last hour.
  check("the day after spring forward: yesterday is the whole 23-hour day", yesterday("2026-03-09T15:00:00.000Z"), ["2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"]);
  check("the day after spring forward: a game in Saturday's last hour (11:30pm EST) is left out", kept("2026-03-09T15:00:00.000Z", ["2026-03-08T04:30:00.000Z", "2026-03-08T05:00:00.000Z"]), ["2026-03-08T05:00:00.000Z"]);
  check("spring forward, 1 ms before the midnight after it: the spring-forward day is still today", yesterday("2026-03-09T03:59:59.999Z"), ["2026-03-07T05:00:00.000Z", "2026-03-08T05:00:00.000Z"]);
  check("spring forward, exactly the midnight after it", yesterday("2026-03-09T04:00:00.000Z"), ["2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"]);
  check("spring forward, 1 ms after the midnight after it", yesterday("2026-03-09T04:00:00.001Z"), ["2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"]);
  check("on the spring-forward day: yesterday is an ordinary 24-hour day", yesterday("2026-03-08T12:00:00.000Z"), ["2026-03-07T05:00:00.000Z", "2026-03-08T05:00:00.000Z"]);

  // Which picks the tab keeps: [start, end) on gameTime.
  check(
    "a game at yesterday's midnight and one 1 ms before today's are kept; 1 ms before yesterday and today's midnight are not",
    kept("2026-10-12T16:00:00.000Z", ["2026-10-11T03:59:59.999Z", "2026-10-11T04:00:00.000Z", "2026-10-12T03:59:59.999Z", "2026-10-12T04:00:00.000Z"]),
    ["2026-10-11T04:00:00.000Z", "2026-10-12T03:59:59.999Z"]
  );

  for (const now of ["2026-10-12T16:00:00.000Z", "2026-10-12T04:00:00.000Z", "2026-11-02T15:00:00.000Z", "2026-11-01T12:00:00.000Z", "2026-03-09T15:00:00.000Z", "2026-03-08T12:00:00.000Z", "2026-01-01T06:00:00.000Z"]) {
    const r = scorecardWindowRange("YESTERDAY", at(now))!;
    const panel = yesterdayRange(at(now));
    check(`the same range the panel cards use [${now}]`, [r.start.toISOString(), r.end.toISOString()], [panel.start.toISOString(), panel.end.toISOString()]);
    check(`Yesterday ends where Today starts [${now}]`, r.end.toISOString(), scorecardWindowRange("TODAY", at(now))!.start.toISOString());
    check(`one Eastern calendar day from first instant to last [${now}]`, easternDateKey(r.start), easternDateKey(new Date(r.end.getTime() - 1)));
  }

  // The other windows are untouched.
  const NOW = at("2026-11-02T15:00:00.000Z");
  const iso = (r: { start: Date; end: Date } | null) => r && [r.start.toISOString(), r.end.toISOString()];
  check("Today: Eastern midnight to now", iso(scorecardWindowRange("TODAY", NOW)), ["2026-11-02T05:00:00.000Z", NOW.toISOString()]);
  check("Last 7 days: the 7 days before now", iso(scorecardWindowRange("LAST_7", NOW)), ["2026-10-26T15:00:00.000Z", NOW.toISOString()]);
  check("All time: unbounded", iso(scorecardWindowRange("ALL", NOW)), null);

  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nAll passed");
}

main();
