// Proof that the React port of the "oracle" login background
// (components/marketing/oracle-background.tsx) reproduces the original HTML
// prototype's wire geometry exactly - same bezier control points, same
// endpoints, same per-row WIN/LOSS outcomes.
//
// No test framework exists in this repo (see the runner header in
// scripts/run-tests.mjs); this is a standalone PASS/FAIL script run by
// `npm test` (and directly via `npx tsx <this file>`). It imports only from
// oracle-background-constants.ts, which is deliberately free of the "use
// client" / next/font imports that would otherwise break under plain tsx.

import {
  CUBE_X,
  CUBE_Y,
  inPathFor,
  LEFT_X,
  outPathFor,
  RIGHT_X,
  ROWS,
  SLOT_HALF,
  wirePath,
} from "./oracle-background-constants";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `${pass ? "PASS" : "FAIL"}: ${label}` +
      (pass ? "" : `\n   actual=${JSON.stringify(actual)}\n   expected=${JSON.stringify(expected)}`)
  );
  if (!pass) failures++;
}

// Independent re-implementation of the prototype's `path()` helper - if this
// and wirePath() ever disagree, that is the regression this test exists to
// catch.
function prototypePath(x1: number, y1: number, x2: number, y2: number): string {
  const midx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${midx} ${y1}, ${midx} ${y2}, ${x2} ${y2}`;
}

// 1. wirePath matches the prototype for a spread of inputs.
for (const [x1, y1, x2, y2] of [
  [274, 169, 490, 360],
  [790, 360, 1006, 549],
  [0, 0, 100, 100],
] as const) {
  check(`wirePath(${x1},${y1},${x2},${y2})`, wirePath(x1, y1, x2, y2), prototypePath(x1, y1, x2, y2));
}

// 2. Row outcomes are the locked demo data, in order.
check("row outcomes", ROWS.map((r) => r.outcome), ["win", "loss", "win", "loss", "win"]);

// 3. Every row's in/out leg matches the prototype's endpoints and curve.
const EXPECTED_YS = [169, 264, 359, 454, 549];
ROWS.forEach((row, i) => {
  check(`row ${i} y-center`, [row.ly, row.ry], [EXPECTED_YS[i], EXPECTED_YS[i]]);
  check(
    `row ${i} in-leg path`,
    inPathFor(row),
    prototypePath(LEFT_X, row.ly, CUBE_X - SLOT_HALF, CUBE_Y)
  );
  check(
    `row ${i} out-leg path`,
    outPathFor(row),
    prototypePath(CUBE_X + SLOT_HALF, CUBE_Y, RIGHT_X, row.ry)
  );
});

// 4. Legs start/end where the cards and slot actually are.
check("in-leg starts at capper card edge", inPathFor(ROWS[0]).startsWith(`M ${LEFT_X} `), true);
check("in-leg ends at slot's left gap", inPathFor(ROWS[0]).endsWith(`${CUBE_X - SLOT_HALF} ${CUBE_Y}`), true);
check("out-leg starts at slot's right gap", outPathFor(ROWS[0]).startsWith(`M ${CUBE_X + SLOT_HALF} ${CUBE_Y} `), true);
check("out-leg ends at result card edge", outPathFor(ROWS[0]).endsWith(`${RIGHT_X} ${ROWS[0].ry}`), true);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
