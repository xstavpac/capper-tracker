// Posted-odds capture rules (lib/odds-source.ts postedOddsCapture / unpricedReasonFor). Pure - no database.
//   npx tsx src/lib/odds-source-capture-acceptance-test.ts
import { postedOddsCapture, unpricedReasonFor } from "@/lib/odds-source";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

const importedAt = new Date("2026-11-03T22:00:00Z");
const snapAt = new Date("2026-11-03T05:05:00Z");
const freshAt = new Date("2026-11-03T21:58:00Z");

check(
  "STATED: the import time, no book, no reason",
  postedOddsCapture({ oddsSource: "STATED", importedAt, line: -3.5, priced: null, unpricedReason: null }),
  { postedLine: -3.5, oddsCapturedAt: importedAt, oddsBook: null, oddsNullReason: null }
);
check(
  "STATED with no line (a moneyline): postedLine null",
  postedOddsCapture({ oddsSource: "STATED", importedAt, line: null, priced: null, unpricedReason: null }).postedLine,
  null
);
check(
  "MARKET from a fresh fetch: its fetchedAt and the book",
  postedOddsCapture({ oddsSource: "MARKET", importedAt, line: 8.5, priced: { capturedAt: freshAt, book: "fanduel" }, unpricedReason: null }),
  { postedLine: 8.5, oddsCapturedAt: freshAt, oddsBook: "fanduel", oddsNullReason: null }
);
check(
  "MARKET from the snapshot: the snapshot's time, NOT the import time",
  postedOddsCapture({ oddsSource: "MARKET", importedAt, line: null, priced: { capturedAt: snapAt, book: "draftkings" }, unpricedReason: null }).oddsCapturedAt,
  snapAt
);
check(
  "MARKET whose data time was unreadable: null, never the import time",
  postedOddsCapture({ oddsSource: "MARKET", importedAt, line: null, priced: { capturedAt: null, book: null }, unpricedReason: null }).oddsCapturedAt,
  null
);
check(
  "DEFAULTED is not a real price: no capture time, no book, a reason",
  postedOddsCapture({ oddsSource: "DEFAULTED", importedAt, line: -3, priced: null, unpricedReason: "unsupported_prop" }),
  { postedLine: -3, oddsCapturedAt: null, oddsBook: null, oddsNullReason: "unsupported_prop" }
);
check(
  "DEFAULTED with no stated reason still carries one",
  postedOddsCapture({ oddsSource: "DEFAULTED", importedAt, line: null, priced: null, unpricedReason: null }).oddsNullReason,
  "no_market"
);
check(
  "a DEFAULTED pick ignores any priced data it was handed",
  postedOddsCapture({ oddsSource: "DEFAULTED", importedAt, line: null, priced: { capturedAt: freshAt, book: "fanduel" }, unpricedReason: "no_market" }).oddsCapturedAt,
  null
);

const before = new Date("2026-11-03T21:00:00Z");
const after = new Date("2026-11-03T23:00:00Z");
check("started game outranks the rest", unpricedReasonFor({ betType: "PLAYER_PROP", gameTime: before, importedAt }), "game_started");
check("a game at exactly the import time has started", unpricedReasonFor({ betType: "SPREAD", gameTime: importedAt, importedAt }), "game_started");
check("an upcoming prop with no price: unsupported_prop", unpricedReasonFor({ betType: "PLAYER_PROP", gameTime: after, importedAt }), "unsupported_prop");
check("an upcoming game line with no price: no_market", unpricedReasonFor({ betType: "TOTAL", gameTime: after, importedAt }), "no_market");

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nall passed");
