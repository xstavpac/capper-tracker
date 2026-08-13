// Acceptance-test fixture #1: Decay Delta, expressed as a real Model
// Definition document. Originally structural-proof-only (Build Step 1); now
// uses real AggregationCalculations (Build Step 3c) so it can actually be
// executed through orchestration, not just validated. The key thing this
// fixture demonstrates by construction: the delta subtracts two
// ALREADY-ROUNDED calculation outputs, not the raw weighted rates or raw
// data inputs - see dv_decay_delta's expression below.
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
    // AggregationCalculations (Build Step 3c) - the declarative form of
    // Build Step 3b's favRoleRate/dogRoleRate. di_fav_rate/di_dog_rate are
    // reused here purely for their entity.role identity (favorite/
    // underdog), not their variableId's resolved stat value - nothing in
    // this model references their resolved number.
    {
      id: "calc_fav_weighted",
      aggregation: {
        source: "gameObservations",
        entities: { team: { ref: "di_fav_rate" } },
        select: {
          all: [
            { op: "equal", left: { observationField: "isPush" }, right: { literal: false } },
            { op: "equal", left: { observationField: "favTeam" }, right: { entityRef: "team" } },
          ],
        },
        value: { observationField: "favWon" },
        weightingRef: "w_recency",
        method: "weightedAverage",
      },
    },
    {
      id: "calc_dog_weighted",
      aggregation: {
        source: "gameObservations",
        entities: { team: { ref: "di_dog_rate" } },
        select: {
          all: [
            { op: "equal", left: { observationField: "isPush" }, right: { literal: false } },
            { op: "equal", left: { observationField: "dogTeam" }, right: { entityRef: "team" } },
          ],
        },
        // The underdog won exactly when the favorite did NOT - expressed as
        // favWon equal false, since this language has no negation node (see
        // types.ts's ObservationExpression comment - permanently restricted
        // to literal/observationField/entityRef/comparison/all/any).
        value: { op: "equal", left: { observationField: "favWon" }, right: { literal: false } },
        weightingRef: "w_recency",
        method: "weightedAverage",
      },
    },
    // Each weighted rate is converted to a 0-100 percentage and rounded
    // individually, BEFORE the subtraction below - round(rate * 100), the
    // exact same convention Build Step 3b's computeDecayFavDogDelta uses
    // (Math.round(rate * 100)), not round(rate, 2) on the raw 0-1 fraction -
    // that would leave this fixture's numbers on a different scale than 3b's
    // own proven output, making a real side-by-side comparison meaningless.
    // This is what proves round-before-subtract by construction.
    {
      id: "calc_fav_pct",
      expression: {
        function: "round",
        args: [{ op: "multiply", left: { ref: "calc_fav_weighted" }, right: { literal: 100 } }, { literal: 0 }],
      },
    },
    {
      id: "calc_dog_pct",
      expression: {
        function: "round",
        args: [{ op: "multiply", left: { ref: "calc_dog_weighted" }, right: { literal: 100 } }, { literal: 0 }],
      },
    },
  ],

  weighting: [{ id: "w_recency", method: "exponential", parameters: { halfLifeDays: 15 } }],

  derivedValues: [
    // Subtracts the two already-rounded PERCENTAGE calculation outputs
    // (calc_fav_pct / calc_dog_pct), not the raw weighted fractions -
    // matches 3b's mlDecayDelta exactly (favPct - dogPct, both already
    // integers 0-100).
    {
      id: "dv_decay_delta",
      expression: { op: "subtract", left: { ref: "calc_fav_pct" }, right: { ref: "calc_dog_pct" } },
    },
  ],

  conditions: [],

  buckets: [
    // Percentage-point buckets (the delta is now on a -100..100 scale, not
    // a 0-1 fraction) - same signed, direction-split structure the
    // fact-finding pass found in the original source's own DELTA_BUCKET_DEFS.
    {
      id: "bucket_decay_delta",
      input: { ref: "dv_decay_delta" },
      rules: [
        { id: "rule_underdog_edge", when: { lt: 0 } },
        { id: "rule_neutral", when: { range: { min: 0, max: 10 } } },
        { id: "rule_favorite_edge", when: { gt: 10 } },
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
