// Proof for the pure expression evaluator (Build Step 3a) - run with
// `npx tsx src/lib/model-engine/evaluate-acceptance-test.ts`. Every expected
// value below is hand-computed in the comment next to it, not just asserted
// against whatever the code happens to produce. Exits non-zero if any
// assertion fails.
import { evaluateExpression, evaluateComparison, type ValueContext } from "./evaluate";
import type { Expression, ConditionWhen } from "./types";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = actual === expected;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}
function checkThrows(label: string, fn: () => void, mustInclude: string) {
  try {
    fn();
    console.log(`FAIL: ${label} -> did not throw`);
    failures++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const pass = msg.includes(mustInclude);
    console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> threw "${msg}"`);
    if (!pass) failures++;
  }
}

const empty: ValueContext = {};

// ---- Nested arithmetic tree, 4 levels deep, 4 different binary ops ----
// (2 + 3) * 4 - 5) / 3 = (5 * 4 - 5) / 3 = (20 - 5) / 3 = 15 / 3 = 5
const nested: Expression = {
  op: "divide",
  left: {
    op: "subtract",
    left: { op: "multiply", left: { op: "add", left: { literal: 2 }, right: { literal: 3 } }, right: { literal: 4 } },
    right: { literal: 5 },
  },
  right: { literal: 3 },
};
check("nested arithmetic tree (add/multiply/subtract/divide, 4 levels)", evaluateExpression(nested, empty), 5);

// ---- Reference node ----
check("Reference resolves against context", evaluateExpression({ ref: "x" }, { x: 42 }), 42);

// ---- Each of the 6 arithmetic BinaryOps ----
check("add: 3 + 4", evaluateExpression({ op: "add", left: { literal: 3 }, right: { literal: 4 } }, empty), 7);
check("subtract: 10 - 4", evaluateExpression({ op: "subtract", left: { literal: 10 }, right: { literal: 4 } }, empty), 6);
check("multiply: 6 * 7", evaluateExpression({ op: "multiply", left: { literal: 6 }, right: { literal: 7 } }, empty), 42);
check("divide: 20 / 4", evaluateExpression({ op: "divide", left: { literal: 20 }, right: { literal: 4 } }, empty), 5);
check("modulo: 17 % 5", evaluateExpression({ op: "modulo", left: { literal: 17 }, right: { literal: 5 } }, empty), 2);
check("power: 2 ^ 10", evaluateExpression({ op: "power", left: { literal: 2 }, right: { literal: 10 } }, empty), 1024);

// ---- Both UnaryOps ----
check("negate: -(5)", evaluateExpression({ op: "negate", operand: { literal: 5 } }, empty), -5);
check("abs: |-7|", evaluateExpression({ op: "abs", operand: { literal: -7 } }, empty), 7);

// ---- Each FunctionCall ----
check("round(3.14159, 2)", evaluateExpression({ function: "round", args: [{ literal: 3.14159 }, { literal: 2 }] }, empty), 3.14);
check(
  "min(5, 2, 9, -3)",
  evaluateExpression({ function: "min", args: [{ literal: 5 }, { literal: 2 }, { literal: 9 }, { literal: -3 }] }, empty),
  -3
);
check(
  "max(5, 2, 9, -3)",
  evaluateExpression({ function: "max", args: [{ literal: 5 }, { literal: 2 }, { literal: 9 }, { literal: -3 }] }, empty),
  9
);
check(
  "sum(1, 2, 3, 4)",
  evaluateExpression({ function: "sum", args: [{ literal: 1 }, { literal: 2 }, { literal: 3 }, { literal: 4 }] }, empty),
  10
);
check(
  "average(2, 4, 6)",
  evaluateExpression({ function: "average", args: [{ literal: 2 }, { literal: 4 }, { literal: 6 }] }, empty),
  4
);
check(
  "normalize(5, 0, 10) -> midpoint",
  evaluateExpression({ function: "normalize", args: [{ literal: 5 }, { literal: 0 }, { literal: 10 }] }, empty),
  0.5
);
check(
  "normalize(-5, 0, 10) -> clamps to 0",
  evaluateExpression({ function: "normalize", args: [{ literal: -5 }, { literal: 0 }, { literal: 10 }] }, empty),
  0
);
check(
  "normalize(15, 0, 10) -> clamps to 1",
  evaluateExpression({ function: "normalize", args: [{ literal: 15 }, { literal: 0 }, { literal: 10 }] }, empty),
  1
);

// ---- At least 2 comparison operators ----
check(
  "greaterThan: 5 > 3",
  evaluateComparison({ op: "greaterThan", left: { literal: 5 }, right: { literal: 3 } }, empty),
  true
);
check("equal: 4 == 4", evaluateComparison({ op: "equal", left: { literal: 4 }, right: { literal: 4 } }, empty), true);
check(
  "lessThan: 5 < 3",
  evaluateComparison({ op: "lessThan", left: { literal: 5 }, right: { literal: 3 } }, empty),
  false
);

// ---- Round-before-subtract composition - the single most important
// correctness property in this project. Context holds BOTH the raw
// (unrounded) weighted values AND their already-rounded counterparts; the
// expression only references the rounded ids. If this evaluator ever used
// the raw values instead, the result would be 66.4 - 39.7 = 26.7, not 26. ----
const decayContext: ValueContext = {
  calc_fav_weighted: 66.4,
  calc_dog_weighted: 39.7,
  calc_fav_rounded: 66,
  calc_dog_rounded: 40,
};
const roundBeforeSubtract: Expression = { op: "subtract", left: { ref: "calc_fav_rounded" }, right: { ref: "calc_dog_rounded" } };
check(
  "round-before-subtract: subtracts the ROUNDED values (66-40=26), not raw (66.4-39.7=26.7)",
  evaluateExpression(roundBeforeSubtract, decayContext),
  26
);

// ---- Negative test: dangling reference ----
checkThrows(
  "Reference to a missing context id fails loudly",
  () => evaluateExpression({ ref: "does_not_exist" }, empty),
  'no value in context for ref "does_not_exist"'
);

// ---- Numeric-error negative tests ----
checkThrows(
  "divide by zero fails loudly",
  () => evaluateExpression({ op: "divide", left: { literal: 5 }, right: { literal: 0 } }, empty),
  "non-finite result"
);
checkThrows(
  "modulo by zero fails loudly (bonus: same general rule)",
  () => evaluateExpression({ op: "modulo", left: { literal: 5 }, right: { literal: 0 } }, empty),
  "non-finite result"
);
checkThrows(
  "normalize with min > max fails loudly",
  () =>
    evaluateExpression(
      { function: "normalize", args: [{ literal: 5 }, { literal: 10 }, { literal: 0 }] },
      empty
    ),
  "requires min < max"
);
checkThrows(
  "normalize with min == max fails loudly",
  () =>
    evaluateExpression(
      { function: "normalize", args: [{ literal: 5 }, { literal: 10 }, { literal: 10 }] },
      empty
    ),
  "requires min < max"
);
checkThrows(
  "round with negative decimals fails loudly",
  () => evaluateExpression({ function: "round", args: [{ literal: 5.5 }, { literal: -1 }] }, empty),
  "non-negative integer"
);
checkThrows(
  "round with non-integer decimals fails loudly",
  () => evaluateExpression({ function: "round", args: [{ literal: 5.5 }, { literal: 1.5 }] }, empty),
  "non-negative integer"
);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
