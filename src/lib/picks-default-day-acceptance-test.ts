// Proof for the /picks default-day rollover - run with:
//   npx tsx src/lib/picks-default-day-acceptance-test.ts
// Pure: no DB. Each case prints the instant's Eastern wall-clock time so the expected value can be checked by eye.
import { easternDefaultDayKey, formatEastern } from "./dates";
import { resolveDateFilter } from "./picks-header";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const wall = (iso: string) =>
  formatEastern(new Date(iso), { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" });

function day(label: string, iso: string, expected: string) {
  check(`${label} [${iso} = ${wall(iso)} ET]`, easternDefaultDayKey(new Date(iso)), expected);
}

// Ordinary EDT day (Oct 26, EDT = UTC-4).
day("12:00 AM stays on yesterday", "2026-10-26T04:00:00Z", "2026-10-25");
day("3:59 AM is still yesterday", "2026-10-26T07:59:00Z", "2026-10-25");
day("4:00 AM is today", "2026-10-26T08:00:00Z", "2026-10-26");
day("11:59 PM is today", "2026-10-27T03:59:00Z", "2026-10-26");
day("11:59 PM the evening before still shows that evening's day", "2026-10-26T03:59:00Z", "2026-10-25");

// Ordinary EST day (Jan 15, EST = UTC-5).
day("EST 3:59 AM is yesterday", "2026-01-15T08:59:00Z", "2026-01-14");
day("EST 4:00 AM is today", "2026-01-15T09:00:00Z", "2026-01-15");

// Spring forward 2026-03-08 (2:00 AM EST jumps to 3:00 AM EDT at 07:00Z).
day("spring: 07:59Z is 3:59 AM EDT, yesterday", "2026-03-08T07:59:00Z", "2026-03-07");
day("spring: 08:00Z is 4:00 AM EDT, today", "2026-03-08T08:00:00Z", "2026-03-08");

// Fall back 2026-11-01 (2:00 AM EDT falls back to 1:00 AM EST at 06:00Z).
day("fall: 05:30Z is the first 1:30 AM, yesterday", "2026-11-01T05:30:00Z", "2026-10-31");
day("fall: 06:30Z is the repeated 1:30 AM, yesterday", "2026-11-01T06:30:00Z", "2026-10-31");
day("fall: 08:59Z is 3:59 AM EST, yesterday", "2026-11-01T08:59:00Z", "2026-10-31");
day("fall: 09:00Z is 4:00 AM EST, today", "2026-11-01T09:00:00Z", "2026-11-01");

// Month and year boundaries roll back by calendar day.
day("1st of the month at 2 AM is the last day of the prior month", "2026-12-01T07:00:00Z", "2026-11-30");
day("Jan 1 at 2 AM is Dec 31", "2026-01-01T07:00:00Z", "2025-12-31");

// An explicit date param always wins and is never shifted, even at 2 AM Eastern.
const at2am = new Date("2026-10-26T06:00:00Z");
const todayKey = easternDefaultDayKey(at2am);
check("2 AM default day is yesterday", todayKey, "2026-10-25");
check("no params -> the default day", resolveDateFilter({}, todayKey), { startDateKey: "2026-10-25", endDateKey: "2026-10-25", isRange: false, clamped: false });
check("explicit ?date= is not shifted", resolveDateFilter({ date: "2026-10-26" }, todayKey), { startDateKey: "2026-10-26", endDateKey: "2026-10-26", isRange: false, clamped: false });
check(
  "explicit startDate/endDate are not shifted",
  resolveDateFilter({ startDate: "2026-10-20", endDate: "2026-10-26" }, todayKey),
  { startDateKey: "2026-10-20", endDateKey: "2026-10-26", isRange: true, clamped: false }
);
check("single-sided endDate is not shifted", resolveDateFilter({ endDate: "2026-10-26" }, todayKey), { startDateKey: "2026-10-26", endDateKey: "2026-10-26", isRange: true, clamped: false });

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nAll passed");
