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
    // Real 10-tier calibration scheme (replaces the original 3-bucket
    // proof-of-mechanism placeholder from 3c, which was too coarse to show
    // real signal - Build Step 5's first run came back nearly flat, 53-55%
    // across all three buckets). Ten decade-wide tiers, percentage points,
    // matching the calibration scheme this rebuild targets.
    //
    // Boundary convention: BucketRuleWhen's `range` is inclusive on BOTH
    // ends (orchestrate.ts's bucketRuleMatches - shared, unmodified, also
    // used by run-diff-era.ts's non-adjacent lt/range/gt buckets). With ten
    // DIRECTLY ADJACENT buckets, naive shared decade boundaries under that
    // same inclusive-both rule would double-claim every boundary (e.g. 20
    // matching both "10 to 20" and "20 to 30"). Rather than changing
    // bucketRuleMatches' shared range semantics (which would reopen the
    // exact gap it was built to close for run-diff-era.ts's own buckets, at
    // its 3/4.5 boundaries), this fixture instead relies on a property
    // already proven above: dv_decay_delta is ALWAYS an integer (the
    // subtraction of two round(x, 0) outputs, calc_fav_pct - calc_dog_pct).
    // Because of that, a half-open "lower-inclusive, upper-exclusive"
    // interval can be expressed exactly with the existing inclusive-both
    // `range` primitive by shifting the upper bound in by 1 integer - e.g.
    // "10 to 20" (meaning delta >= 10 and < 20) is range{min:10, max:19},
    // not range{min:10, max:20}. This is a pure bucket-configuration choice
    // local to this fixture - no change to BucketRuleWhen's type, to
    // validate.ts, or to bucketRuleMatches itself.
    //
    // Ownership at each shared boundary, lower-inclusive/upper-exclusive
    // throughout, EXCEPT for one deliberate, explicitly-stated tie-break:
    // delta === 0 is assigned to "0 to 10" (the non-negative bucket), not
    // "0 to -10" - an arbitrary but consistent choice for the one boundary
    // that isn't naturally "lower" or "upper" of anything (zero is the
    // pivot, not a decade edge). "0 to -10" is therefore the strictly-open
    // interval between them (-9 to -1), owning neither 0 nor -10 - -10
    // itself is owned by "-10 to -20" instead, consistent with every other
    // interior boundary being owned by exactly one neighbor.
    //
    // Verified directly (see decay-delta-bucket-boundary-test.ts): every one
    // of delta = 0, +-10, +-20, +-30, +-40 matches EXACTLY one rule below,
    // never zero, never two.
    {
      id: "bucket_decay_delta",
      input: { ref: "dv_decay_delta" },
      rules: [
        { id: "rule_ge_40", when: { gte: 40 } },
        { id: "rule_30_to_40", when: { range: { min: 30, max: 39 } } },
        { id: "rule_20_to_30", when: { range: { min: 20, max: 29 } } },
        { id: "rule_10_to_20", when: { range: { min: 10, max: 19 } } },
        { id: "rule_0_to_10", when: { range: { min: 0, max: 9 } } },
        { id: "rule_0_to_neg10", when: { range: { min: -9, max: -1 } } },
        { id: "rule_neg10_to_neg20", when: { range: { min: -19, max: -10 } } },
        { id: "rule_neg20_to_neg30", when: { range: { min: -29, max: -20 } } },
        { id: "rule_neg30_to_neg40", when: { range: { min: -39, max: -30 } } },
        { id: "rule_le_neg40", when: { lte: -40 } },
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
