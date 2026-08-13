// Acceptance-test fixture #1: Decay Delta, expressed as a real Model
// Definition document. Structural proof only - nothing here is executed.
// The key thing this fixture has to demonstrate by construction: the delta
// subtracts two ALREADY-ROUNDED calculation outputs, not the raw weighted
// rates or raw data inputs - see dv_decay_delta's expression below.
import type { ModelDefinition } from "../types";

export const decayDeltaModel: ModelDefinition = {
  schemaVersion: 1,
  modelId: "decay-delta-v1",
  name: "Decay Delta",
  sport: "baseball_mlb",

  dataInputs: [
    {
      id: "di_fav_rate",
      variableId: "tendency_fav_win_pct",
      entity: { type: "team", role: "favorite" },
      params: {},
      sourceRef: null,
    },
    {
      id: "di_dog_rate",
      variableId: "tendency_dog_win_pct",
      entity: { type: "team", role: "underdog" },
      params: {},
      sourceRef: null,
    },
  ],

  calculations: [
    // Weighted rate calculations - reference their raw data input and
    // invoke the exponential weighting spec via weightingRef. How
    // weighting actually combines with the expression is an execution-
    // engine concern, out of scope for this step.
    { id: "calc_fav_weighted", expression: { ref: "di_fav_rate" }, weightingRef: "w_recency" },
    { id: "calc_dog_weighted", expression: { ref: "di_dog_rate" }, weightingRef: "w_recency" },
    // Each weighted rate is rounded individually, BEFORE the subtraction
    // below - this is what proves round-before-subtract by construction.
    {
      id: "calc_fav_rounded",
      expression: { function: "round", args: [{ ref: "calc_fav_weighted" }, { literal: 2 }] },
    },
    {
      id: "calc_dog_rounded",
      expression: { function: "round", args: [{ ref: "calc_dog_weighted" }, { literal: 2 }] },
    },
  ],

  weighting: [{ id: "w_recency", method: "exponential", parameters: { halfLifeDays: 15 } }],

  derivedValues: [
    // Subtracts the two already-rounded calculation outputs
    // (calc_fav_rounded / calc_dog_rounded), not the raw weighted values.
    {
      id: "dv_decay_delta",
      expression: { op: "subtract", left: { ref: "calc_fav_rounded" }, right: { ref: "calc_dog_rounded" } },
    },
  ],

  conditions: [],

  buckets: [
    {
      id: "bucket_decay_delta",
      input: { ref: "dv_decay_delta" },
      rules: [
        { id: "rule_negative_edge", when: { lt: 0 } },
        { id: "rule_neutral", when: { range: { min: 0, max: 0.05 } } },
        { id: "rule_positive_edge", when: { gt: 0.05 } },
      ],
    },
  ],

  grids: [],

  outcomes: [{ id: "outcome_edge", type: "numeric", unit: "percent", expression: { ref: "dv_decay_delta" } }],

  metadata: {
    description: "Decay-weighted favorite/underdog win-rate delta, the first configuration run through the general engine.",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    createdBy: "acceptance-test",
    tags: ["decay-delta", "team_tendencies"],
    ownerRef: null,
    sourceRefs: [],
  },
};
