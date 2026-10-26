// The day grouping of "Load older picks" is Eastern, whatever zone the browser
// is in, and LocalGameTime's first paint (server + hydration) is Eastern too, so
// an evening game never shows the next day's date. Pure, no DB. The expected
// values are absolute, so the same file passing under each TZ proves they match:
//   TZ=America/Los_Angeles npx tsx src/lib/older-picks-day-key-acceptance-test.ts
//   TZ=America/Chicago     npx tsx src/lib/older-picks-day-key-acceptance-test.ts
//   TZ=UTC                 npx tsx src/lib/older-picks-day-key-acceptance-test.ts
import { groupByDay, olderDayHeading, olderDayKey } from "@/lib/older-picks";
import { APP_TIME_ZONE, formatInZone } from "@/lib/dates";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!pass) failures++;
}

console.log("process TZ: " + (process.env.TZ ?? "(unset)"));

const NOW = new Date("2026-10-26T15:00:00Z");
// Newest first, like the Settled order. 10 PM ET Oct 25 and 12:30 AM ET Oct 26 are
// one day apart in Eastern but the same calendar day for a Pacific browser (7:30 PM
// and 9:30 PM PT on Oct 25).
const rows = [
  { id: "a", iso: "2026-10-26T04:30:00Z" }, // 12:30 AM ET Oct 26
  { id: "b", iso: "2026-10-26T02:00:00Z" }, // 10 PM ET Oct 25 (9 PM CT, 02:00 UTC next day)
  { id: "c", iso: "2026-10-25T23:00:00Z" }, // 7 PM ET Oct 25
  { id: "d", iso: "2026-10-24T23:30:00Z" }, // 7:30 PM ET Oct 24
];

expect("keys are Eastern days", rows.map((r) => olderDayKey(r.iso)), ["2026-10-26", "2026-10-25", "2026-10-25", "2026-10-24"]);
expect("grouped into three Eastern days", groupByDay(rows, (r) => olderDayKey(r.iso)).map((g) => [g.dayKey, g.rows.map((r) => r.id).join("")]), [["2026-10-26", "a"], ["2026-10-25", "bc"], ["2026-10-24", "d"]]);
expect("heading is the Eastern day", [olderDayHeading(rows[0].iso, NOW), olderDayHeading(rows[1].iso, NOW)], ["Mon, Oct 26", "Sun, Oct 25"]);
expect("a different Eastern year adds the year", olderDayHeading("2025-10-25T23:00:00Z", NOW), "Sat, Oct 25, 2025");
expect("the year is compared in Eastern: 11 PM ET Dec 31 is still this year", olderDayHeading("2026-01-01T03:00:00Z", new Date("2026-06-01T12:00:00Z")), "Wed, Dec 31, 2025");
expect("DST fall-back day keeps its own key", [olderDayKey("2026-11-01T03:30:00Z"), olderDayKey("2026-11-01T05:30:00Z")], ["2026-10-31", "2026-11-01"]);

// LocalGameTime's initial text: 9 PM Central Oct 25 is 02:00Z Oct 26 - UTC would paint "Oct 26".
const first = (iso: string) => formatInZone(new Date(iso), APP_TIME_ZONE, { month: "short", day: "numeric" });
expect("first paint of a 9 PM Central game is its own day", first("2026-10-26T02:00:00Z").startsWith("Oct 25"), true);
expect("the old UTC first paint would have shown the next day", formatInZone(new Date("2026-10-26T02:00:00Z"), "UTC", { month: "short", day: "numeric" }).startsWith("Oct 26"), true);

console.log(failures ? `\n${failures} FAILED` : "\nAll older-picks day-key checks passed.");
process.exit(failures ? 1 : 0);
