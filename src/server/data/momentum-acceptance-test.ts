// Correctness proof for computeMomentum's streak-bucketing logic in
// stats.ts, run with:
//   npx tsx src/server/data/momentum-acceptance-test.ts
// Not a general test suite (see grading-correctness-acceptance-test.ts for
// the same pattern - this repo has no test runner configured).
//
// One hand-constructed synthetic sequence, worked out by hand alongside the
// code (not derived from it), covering: the "1/2/3/4+" bucket boundaries in
// both directions, a streak that keeps growing past 4 (5 losses/wins still
// bucket into "4+"), and PUSH/PENDING picks interspersed to confirm they're
// invisible to streak tracking - same convention as currentStreak() itself,
// which computeMomentum calls directly rather than re-deriving.
//
// Every pick uses 1 unit at -110, so a win contributes +0.9090909... units
// and a loss contributes -1 - net units below are the hand-computed sums,
// rounded to 2dp once (matching computeMomentum's own single round2 call).
//
// Exits non-zero if any assertion fails.
import type { Pick } from "@prisma/client";
import { computeMomentum, type MomentumBreakdown } from "./stats";

let failures = 0;

function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}`);
  if (!pass) {
    console.log("  expected:", JSON.stringify(expected));
    console.log("  actual:  ", JSON.stringify(actual));
    failures++;
  }
}

let gameTimeCounter = 0;
function mkPick(status: "WIN" | "LOSS" | "PUSH" | "PENDING"): Pick {
  gameTimeCounter += 1;
  return {
    status,
    units: 1,
    odds: -110,
    // Chronological order is all computeMomentum reads gameTime for -
    // strictly increasing, one minute apart, is enough.
    gameTime: new Date(2026, 0, 1, 0, gameTimeCounter),
  } as unknown as Pick;
}

// Sequence (results only, chronological): L L L W [PUSH] L L W [PENDING] W W W W L W W
// The bracketed PUSH/PENDING entries must not appear in any bucket and must
// not break the surrounding streak - i.e. results should be IDENTICAL to
// the same sequence with those two entries removed entirely.
const picks: Pick[] = [
  mkPick("LOSS"), // i=0 in the decided-only sequence - no preceding streak, never bucketed
  mkPick("LOSS"), // preceding: 1L -> afterLoss[1] += this result (L)
  mkPick("LOSS"), // preceding: 2L -> afterLoss[2] += (L)
  mkPick("WIN"), // preceding: 3L -> afterLoss[3] += (W)
  mkPick("PUSH"), // invisible - must not affect anything below
  mkPick("LOSS"), // preceding: 1W (the WIN two picks ago) -> afterWin[1] += (L)
  mkPick("LOSS"), // preceding: 1L -> afterLoss[1] += (L)
  mkPick("WIN"), // preceding: 2L -> afterLoss[2] += (W)
  mkPick("PENDING"), // invisible - must not affect anything below
  mkPick("WIN"), // preceding: 1W -> afterWin[1] += (W)
  mkPick("WIN"), // preceding: 2W -> afterWin[2] += (W)
  mkPick("WIN"), // preceding: 3W -> afterWin[3] += (W)
  mkPick("WIN"), // preceding: 4W -> afterWin[4+] += (W)
  mkPick("LOSS"), // preceding: 5W (still 4+) -> afterWin[4+] += (L)
  mkPick("WIN"), // preceding: 1L -> afterLoss[1] += (W)
  mkPick("WIN"), // preceding: 1W -> afterWin[1] += (W)
];

const result = computeMomentum(picks);

// winPct deliberately NOT rounded here - matches computeMomentum's own
// toRows, which stores the raw (wins/sampleSize)*100 with no rounding
// (only netUnits goes through round2). Rounding only happens at display
// time (Math.round in MomentumPanel).
// Key order matches MomentumRow's own field order exactly - the expect()
// helper below compares via JSON.stringify, which is key-order sensitive.
function row(wins: number, losses: number, netUnits: number) {
  const sampleSize = wins + losses;
  return {
    wins,
    losses,
    winPct: sampleSize > 0 ? (wins / sampleSize) * 100 : 0,
    netUnits,
    sampleSize,
  };
}

// afterLoss["1"]: L(i1), L(i6), W(i14) -> wins=1 losses=2, net = 0.91 - 2 = -1.09
// afterLoss["2"]: L(i2), W(i7)         -> wins=1 losses=1, net = 0.91 - 1 = -0.09
// afterLoss["3"]: W(i3)                -> wins=1 losses=0, net = 0.91
// afterLoss["4+"]: (none)              -> wins=0 losses=0, net = 0
const expectedAfterLoss = [
  { length: "1", ...row(1, 2, -1.09) },
  { length: "2", ...row(1, 1, -0.09) },
  { length: "3", ...row(1, 0, 0.91) },
  { length: "4+", ...row(0, 0, 0) },
];

// afterWin["1"]: L(i5), W(i9), W(i15)  -> wins=2 losses=1, net = 1.82 - 1 = 0.82
// afterWin["2"]: W(i10)                -> wins=1 losses=0, net = 0.91
// afterWin["3"]: W(i11)                -> wins=1 losses=0, net = 0.91
// afterWin["4+"]: W(i12), L(i13)       -> wins=1 losses=1, net = 0.91 - 1 = -0.09
const expectedAfterWin = [
  { length: "1", ...row(2, 1, 0.82) },
  { length: "2", ...row(1, 0, 0.91) },
  { length: "3", ...row(1, 0, 0.91) },
  { length: "4+", ...row(1, 1, -0.09) },
];

expect("afterLoss buckets match the hand-computed sequence", result.afterLoss, expectedAfterLoss);
expect("afterWin buckets match the hand-computed sequence", result.afterWin, expectedAfterWin);

expect(
  "PUSH/PENDING picks contributed to zero buckets - total bucketed picks equals decided picks minus 1 (the very first pick, which has no preceding streak)",
  result.afterLoss.reduce((s, r) => s + r.sampleSize, 0) + result.afterWin.reduce((s, r) => s + r.sampleSize, 0),
  13 // 14 WIN/LOSS picks in the sequence, minus the first one (no preceding streak)
);

// ---- Empty / trivial inputs ----

const empty: MomentumBreakdown = computeMomentum([]);
expect(
  "no picks at all: all 8 rows present, all zero",
  empty.afterLoss.every((r) => r.sampleSize === 0) && empty.afterWin.every((r) => r.sampleSize === 0),
  true
);

const singlePick: MomentumBreakdown = computeMomentum([mkPick("WIN")]);
expect(
  "exactly one decided pick: still zero everywhere (no preceding streak exists for the very first pick)",
  singlePick.afterLoss.every((r) => r.sampleSize === 0) && singlePick.afterWin.every((r) => r.sampleSize === 0),
  true
);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
if (failures > 0) process.exit(1);
