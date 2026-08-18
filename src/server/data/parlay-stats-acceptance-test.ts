// Structural-validation proof for the parlay payout math - run with
// `npx tsx src/server/data/parlay-stats-acceptance-test.ts`. Same pattern as
// parlay-grading-acceptance-test.ts. Checks effectiveParlayDecimalOdds/
// unitsWonOnParlay against hand-computed sportsbook payouts before trusting
// them inside computeParlayStats.
import { effectiveParlayDecimalOdds, unitsWonOnParlay } from "./parlay-stats";

let failures = 0;

function expectClose(label: string, actual: number, expected: number, tolerance = 0.0001) {
  const pass = Math.abs(actual - expected) < tolerance;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} - expected=${expected} actual=${actual}`);
  if (!pass) failures++;
}

// Two -110 legs: decimal odds 1.9091 each -> combined 3.6465 -> a 1-unit
// stake profits 2.6465u. Hand-computed against a standard -110/-110 2-leg
// parlay payout table (implied combined price is roughly +265).
expectClose(
  "two -110 legs combined decimal odds",
  effectiveParlayDecimalOdds([
    { status: "WIN", odds: -110 },
    { status: "WIN", odds: -110 },
  ]),
  (1 + 100 / 110) * (1 + 100 / 110)
);
expectClose(
  "two -110 legs, 1 unit profit",
  unitsWonOnParlay(1, [
    { status: "WIN", odds: -110 },
    { status: "WIN", odds: -110 },
  ]),
  (1 + 100 / 110) * (1 + 100 / 110) - 1
);

// A +150 underdog leg alongside a -200 favorite leg - mixed sign odds.
expectClose(
  "mixed +150/-200 legs combined decimal odds",
  effectiveParlayDecimalOdds([
    { status: "WIN", odds: 150 },
    { status: "WIN", odds: -200 },
  ]),
  2.5 * 1.5
);

// A pushed leg is excluded entirely - the payout recalculates as if it were
// never in the parlay ("recalculates at N-1 legs"), not treated as a 1.0x
// (break-even) multiplier baked in, and not treated as a loss.
expectClose(
  "pushed leg excluded, not multiplied in as 1.0x or zeroed",
  effectiveParlayDecimalOdds([
    { status: "WIN", odds: -110 },
    { status: "PUSH", odds: -110 },
    { status: "WIN", odds: -110 },
  ]),
  (1 + 100 / 110) * (1 + 100 / 110)
);

// A cancelled leg is excluded the same way.
expectClose(
  "cancelled leg excluded same as push",
  effectiveParlayDecimalOdds([
    { status: "WIN", odds: 200 },
    { status: "CANCELLED", odds: -150 },
  ]),
  3
);

// Single surviving leg after everything else pushed - degenerates to that
// leg's own straight decimal odds, not some parlay-specific bonus.
expectClose("single surviving leg after others push", effectiveParlayDecimalOdds([{ status: "WIN", odds: -110 }]), 1 + 100 / 110);

// No winning legs at all (e.g. called on a PUSH-resolved parlay, which this
// function should never actually be asked to price, but shouldn't produce
// nonsense if it is) - empty product is 1 (break-even), not 0 or NaN.
expectClose("no winning legs -> empty product is 1", effectiveParlayDecimalOdds([{ status: "PUSH", odds: -110 }]), 1);

console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
