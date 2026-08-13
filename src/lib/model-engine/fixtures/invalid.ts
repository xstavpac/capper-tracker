// Three intentionally invalid Model Definitions, each isolating exactly
// one violation so the validator's rejection reason is unambiguous.
// Everything else in each document is minimally valid, so the only error
// that should surface is the one under test.

const baseMetadata = {
  description: "invalid fixture",
  createdAt: "2026-08-13T00:00:00.000Z",
  updatedAt: "2026-08-13T00:00:00.000Z",
  createdBy: "acceptance-test",
  tags: [],
  ownerRef: null,
  sourceRefs: [],
};

// Violation: an unregistered function ID ("square" is not in FUNCTION_IDS).
export const invalidUnregisteredFunction = {
  schemaVersion: 1,
  modelId: "invalid-unregistered-function",
  name: "Invalid - unregistered function",
  sport: "baseball_mlb",
  dataInputs: [],
  calculations: [{ id: "calc_bad", expression: { function: "square", args: [{ literal: 2 }] } }],
  weighting: [],
  derivedValues: [],
  conditions: [],
  buckets: [],
  grids: [],
  outcomes: [],
  metadata: baseMetadata,
};

// Violation: a dangling reference (no id "does_not_exist" is defined
// anywhere in the document).
export const invalidDanglingReference = {
  schemaVersion: 1,
  modelId: "invalid-dangling-reference",
  name: "Invalid - dangling reference",
  sport: "baseball_mlb",
  dataInputs: [],
  calculations: [],
  weighting: [],
  derivedValues: [{ id: "dv_bad", expression: { ref: "does_not_exist" } }],
  conditions: [],
  buckets: [],
  grids: [],
  outcomes: [],
  metadata: baseMetadata,
};

// Violation: a comparison operator ("greaterThan") used as a general
// Expression, where only arithmetic binary ops are valid.
export const invalidComparisonInArithmeticContext = {
  schemaVersion: 1,
  modelId: "invalid-comparison-in-arithmetic",
  name: "Invalid - comparison op used as arithmetic",
  sport: "baseball_mlb",
  dataInputs: [],
  calculations: [
    { id: "calc_bad2", expression: { op: "greaterThan", left: { literal: 1 }, right: { literal: 2 } } },
  ],
  weighting: [],
  derivedValues: [],
  conditions: [],
  buckets: [],
  grids: [],
  outcomes: [],
  metadata: baseMetadata,
};
