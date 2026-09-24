// Proof for isInvalidOdds, the shared odds=0 guard used by both Pick.odds
// write paths - manual entry (createPickAction, server/actions/picks.ts) and
// bulk/catalog import (bulkImportPicksAction, server/actions/bulk-picks.ts).
// Those two files can't be exercised directly by this repo's plain-tsx test
// runner (they transitively import server/auth.ts, whose getCurrentUser is
// wrapped in React's cache() - unavailable outside Next's own React build,
// so merely importing either action file crashes under `tsx` - confirmed by
// running this repo's react package directly: `cache` is undefined on
// react@18.3.1 outside Next's bundler). This tests the actual shared
// predicate both files call instead, which is what a stray 0 is actually
// rejected by - see the "isInvalidOdds(odds)" call sites in each file. Pure,
// no dependencies. Run with:
//   npx tsx src/lib/pick-validation-acceptance-test.ts
import { isInvalidOdds } from "@/lib/pick-validation";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

expect("0 is rejected", isInvalidOdds(0), true);
expect("-0 is rejected (same value as 0)", isInvalidOdds(-0), true);
expect("-110 (a normal favorite price) is accepted", isInvalidOdds(-110), false);
expect("+150 (a normal underdog price) is accepted", isInvalidOdds(150), false);
expect("-100 (pick'em) is accepted", isInvalidOdds(-100), false);
expect("a large explicit price is accepted", isInvalidOdds(2500), false);

console.log(`\n${failures === 0 ? "All tests passed!" : failures + " test(s) failed."}`);
process.exit(failures > 0 ? 1 : 0);
