// Proof of findSameDayDuplicateEvents / warnSameDayDuplicateEvents - the log-only
// detector for two Odds API events on the same teams + ET date.
//
// Run with:
//   npx tsx src/lib/odds-duplicate-events-acceptance-test.ts
// Exits non-zero on any failed assertion.
import { findSameDayDuplicateEvents, warnSameDayDuplicateEvents } from "./odds-duplicate-events";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const ev = (id: string, home: string, away: string, commenceTime: string) => ({ id, homeTeam: home, awayTeam: away, commenceTime });
const ATL = "Atlanta Braves";
const PHI = "Philadelphia Phillies";

// The real 2026-10-01 seed row.
const seed = [
  ev("2b7c78b3c1a232ece3e9752493924b6c", ATL, PHI, "2026-10-01T18:00:00Z"),
  ev("5524c44b05e28aa899909c9e001184ec", ATL, PHI, "2026-10-02T00:11:00Z"),
  ev("other", "New York Mets", "Miami Marlins", "2026-10-01T23:10:00Z"),
];
const found = findSameDayDuplicateEvents(seed);
expect("1a. the Oct 1 phantom pair is reported once", found.length, 1);
expect("1b. with both ids and times", found[0]?.events, [
  { id: "2b7c78b3c1a232ece3e9752493924b6c", commenceTime: "2026-10-01T18:00:00Z" },
  { id: "5524c44b05e28aa899909c9e001184ec", commenceTime: "2026-10-02T00:11:00Z" },
]);
expect("1c. keyed to the ET date", found[0]?.etDate, "2026-10-01");

expect(
  "2. consecutive series games (different ET dates) are not reported",
  findSameDayDuplicateEvents([
    ev("a", ATL, PHI, "2026-09-29T18:00:00Z"),
    ev("b", ATL, PHI, "2026-09-30T18:00:00Z"),
    ev("c", ATL, PHI, "2026-10-02T00:11:00Z"),
  ]),
  []
);
expect("3. a clean slate reports nothing", findSameDayDuplicateEvents([seed[2]]), []);

// warn output is one JSON line per group.
const warned: string[] = [];
const origWarn = console.warn;
console.warn = (...args: unknown[]) => warned.push(args.join(" "));
warnSameDayDuplicateEvents("seed", "baseball_mlb", "2026-10-01", found);
warnSameDayDuplicateEvents("backfill", "baseball_mlb", "2026-10-01", []);
console.warn = origWarn;
expect("4a. one warn line per group, none for an empty list", warned.length, 1);
const payload = JSON.parse(warned[0].replace("[odds-duplicate-events] ", ""));
expect("4b. line carries source, sport, date and both ids", [payload.source, payload.sportKey, payload.fetchDate, payload.events.length], [
  "seed",
  "baseball_mlb",
  "2026-10-01",
  2,
]);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
if (failures > 0) process.exit(1);
