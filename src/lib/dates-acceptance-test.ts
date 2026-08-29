// Proof for easternDayStart/easternDateRange (added for the Picks page's
// query-level date scoping - see server/data/picks.ts's getFilteredPicksForUser)
// - run with:
//   npx tsx src/lib/dates-acceptance-test.ts
//
// No test framework exists in this repo; this follows the same persisted
// tsx-script convention parse-catalog-acceptance-test.ts established.
import { easternDateKey, easternDayStart, easternDateRange, addDaysToDateKey, withinDateDriftDays } from "./dates";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

function main() {
  // easternDayStart must NOT be reachable by naively parsing "YYYY-MM-DD"
  // via `new Date(dateKey)` (UTC midnight) - that's already the previous
  // Eastern calendar day for the entire Eastern evening. Confirm round-trip:
  // the instant easternDayStart returns for a given key, re-read through
  // easternDateKey, comes back as that same key (not the day before).
  for (const key of ["2026-01-01", "2026-08-16", "2026-12-31", "2026-03-08", "2026-11-01"]) {
    check(`easternDayStart("${key}") round-trips through easternDateKey`, easternDateKey(easternDayStart(key)), key);
  }

  // A single-day range (startKey === endKey) must cover exactly that
  // Eastern day: 1s before start is the PREVIOUS day, 1s before end (i.e.
  // the last second of the day) is still the SAME day.
  {
    const { start, end } = easternDateRange("2026-08-16", "2026-08-16");
    check("single-day range: 1s before start is the prior day", easternDateKey(new Date(start.getTime() - 1000)), "2026-08-15");
    check("single-day range: 1s after start is the same day", easternDateKey(new Date(start.getTime() + 1000)), "2026-08-16");
    check("single-day range: 1s before end is still the same day", easternDateKey(new Date(end.getTime() - 1000)), "2026-08-16");
    check("single-day range: end instant itself is the next day", easternDateKey(end), "2026-08-17");
  }

  // A multi-day range must cover every day from start through end inclusive,
  // with nothing from the day just outside either edge.
  {
    const { start, end } = easternDateRange("2026-08-09", "2026-08-12");
    check("multi-day range: 1s before start excluded (prior day)", easternDateKey(new Date(start.getTime() - 1000)), "2026-08-08");
    check("multi-day range: start instant is the first day", easternDateKey(start), "2026-08-09");
    check("multi-day range: 1s before end is the last included day", easternDateKey(new Date(end.getTime() - 1000)), "2026-08-12");
    check("multi-day range: end instant is the day after the range", easternDateKey(end), "2026-08-13");
  }

  // DST transition (2026: spring-forward Mar 8, fall-back Nov 1) - each
  // boundary is resolved independently via easternDayStart on its OWN
  // calendar day, not by adding a fixed 86400000ms, so a range spanning the
  // transition should still land on the correct wall-clock instant on both
  // sides rather than drifting an hour. Checked via the UTC offset implied
  // by each boundary (4h = EDT, 5h = EST), not by asserting a specific
  // elapsed duration.
  {
    const springForward = easternDateRange("2026-03-07", "2026-03-09");
    check("spring-forward: day before transition is still EST (UTC-5)", springForward.start.getUTCHours(), 5);
    check("spring-forward: day after transition is EDT (UTC-4)", easternDayStart("2026-03-09").getUTCHours(), 4);

    const fallBack = easternDateRange("2026-10-31", "2026-11-02");
    check("fall-back: day before transition is still EDT (UTC-4)", fallBack.start.getUTCHours(), 4);
    check("fall-back: day after transition is EST (UTC-5)", easternDayStart("2026-11-02").getUTCHours(), 5);
  }

  // Cross-year-boundary range (Dec 31 -> Jan 1) - exercises the Date.UTC
  // month/year overflow easternDateRange's nextDayKey computation relies on.
  {
    const { end } = easternDateRange("2026-12-30", "2026-12-31");
    check("year-boundary range: end instant rolls into next year", easternDateKey(end), "2027-01-01");
  }

  // addDaysToDateKey - pure calendar-key math, overflows month/year.
  check("addDaysToDateKey: +4 within a month", addDaysToDateKey("2026-08-29", 4), "2026-09-02");
  check("addDaysToDateKey: crosses a month boundary", addDaysToDateKey("2026-08-30", 4), "2026-09-03");
  check("addDaysToDateKey: negative days", addDaysToDateKey("2026-09-02", -4), "2026-08-29");
  check("addDaysToDateKey: year overflow", addDaysToDateKey("2026-12-30", 3), "2027-01-02");

  // withinDateDriftDays - the resolver's date backstop (odds.ts). The
  // Tennessee State case: a pick imported Aug 29 must NOT accept a Sept 5
  // game (7 days out), but must accept a game the same day or a day or two
  // out (a Thu import for a Sat game).
  {
    const importDay = new Date("2026-08-29T15:00:00-04:00");
    const sameDayGame = new Date("2026-08-29T19:30:00-04:00");
    const twoDaysOut = new Date("2026-08-31T13:00:00-04:00");
    const threeDaysOut = new Date("2026-09-01T13:00:00-04:00");
    const sept5Georgia = new Date("2026-09-05T15:00:00-04:00");
    check("withinDateDriftDays: same-day game accepted", withinDateDriftDays(sameDayGame, importDay, 2), true);
    check("withinDateDriftDays: 2 days out accepted", withinDateDriftDays(twoDaysOut, importDay, 2), true);
    check("withinDateDriftDays: 3 days out rejected (>2)", withinDateDriftDays(threeDaysOut, importDay, 2), false);
    check("withinDateDriftDays: the Sept 5 Georgia game (7 days out) rejected", withinDateDriftDays(sept5Georgia, importDay, 2), false);
    // Direction doesn't matter - a stale pick imported a few days after a
    // game is still 'near' it.
    check("withinDateDriftDays: 2 days BEFORE reference also accepted", withinDateDriftDays(new Date("2026-08-27T19:00:00-04:00"), importDay, 2), true);
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
