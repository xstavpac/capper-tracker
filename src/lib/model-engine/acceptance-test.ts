// Structural-validation proof for the Model Definition schema - run with
// `npx tsx src/lib/model-engine/acceptance-test.ts`. Not a general test
// suite (this repo has no test runner configured yet); a standalone,
// runnable proof that: (a) two deliberately different real Model
// Definitions validate cleanly with zero model-specific logic in the
// validator, and (b) three isolated invalid documents are each rejected
// for the expected reason. Exits non-zero if any assertion fails.
import { validateModelDefinition } from "./validate";
import { decayDeltaModel } from "./fixtures/decay-delta";
import { runDiffEraModel } from "./fixtures/run-diff-era";
import {
  invalidComparisonInArithmeticContext,
  invalidDanglingReference,
  invalidUnregisteredFunction,
} from "./fixtures/invalid";

let failures = 0;

function expectValid(label: string, doc: unknown) {
  const result = validateModelDefinition(doc);
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(doc, null, 2));
  console.log(`--- validator result: ${result.valid ? "VALID" : "INVALID"} ---`);
  if (!result.valid) {
    console.log(result.errors);
    failures++;
    console.error(`FAIL: expected ${label} to validate, but it did not.`);
  } else {
    console.log(`PASS: ${label} validated with zero errors.`);
  }
}

function expectInvalid(label: string, doc: unknown, expectedSubstring: string) {
  const result = validateModelDefinition(doc);
  console.log(`\n=== ${label} ===`);
  console.log(`--- validator result: ${result.valid ? "VALID" : "INVALID"} ---`);
  console.log(result.errors);
  if (result.valid) {
    failures++;
    console.error(`FAIL: expected ${label} to be rejected, but it validated.`);
    return;
  }
  const found = result.errors.some((e) => e.message.includes(expectedSubstring));
  if (!found) {
    failures++;
    console.error(`FAIL: ${label} was rejected, but no error mentioned "${expectedSubstring}".`);
  } else {
    console.log(`PASS: ${label} was rejected, with an error mentioning "${expectedSubstring}".`);
  }
}

// ---- Positive tests ----
expectValid("Test Model 1 - Decay Delta", decayDeltaModel);
expectValid("Test Model 2 - Run Differential vs. Starter ERA", runDiffEraModel);

// ---- Negative tests ----
expectInvalid("Invalid - unregistered function ID", invalidUnregisteredFunction, "is not a registered function");
expectInvalid("Invalid - dangling reference", invalidDanglingReference, "references unknown id");
expectInvalid(
  "Invalid - comparison operator used as arithmetic",
  invalidComparisonInArithmeticContext,
  "is not a registered arithmetic binary operator"
);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
