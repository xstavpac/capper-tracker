// Acceptance-test fixture #2: deliberately different from Decay Delta -
// two real, non-percentage catalog variables (team_run_differential in
// runs, team_era in earned-run average), a longer calculation chain
// (multiply -> add -> normalize), a multi-condition AND group, two
// independent grid axes, a non-percentage numeric outcome, and NO
// weighting at all, to prove weighting is genuinely optional rather than
// implicitly required.
//
// Originally used pitcher_era (entity.type "pitcher", role "favorite") -
// changed to team_era for Build Step 3c, which actually EXECUTES this model
// against real data, not just validates its structure. Resolving a specific
// game's starting pitcher requires GameStarters, which was deliberately
// removed in the model-builder cleanup pass and never replaced - there is
// no DATA-layer path today from an evaluation event to a pitcher identity.
// This is a real seam, reported rather than worked around; team_era keeps
// every other property this fixture exists to prove (non-percentage
// outcome, more operations, a multi-condition group, two grid axes, no
// weighting) while being genuinely resolvable today.
import type { ModelDefinition } from "../types";

export const runDiffEraModel: ModelDefinition = {
  schemaVersion: 1,
  modelId: "run-diff-era-v1",
  name: "Run Differential vs. Starter ERA",
  sport: "baseball_mlb",

  dataInputs: [
    {
      id: "di_run_diff",
      variableId: "team_run_differential",
      entity: { type: "team", role: "favorite" },
      params: {},
      sourceRef: null,
    },
    {
      id: "di_opp_era",
      variableId: "team_era",
      entity: { type: "team", role: "favorite" },
      params: {},
      sourceRef: null,
    },
  ],

  calculations: [
    { id: "calc_scaled_diff", expression: { op: "multiply", left: { ref: "di_run_diff" }, right: { literal: 1.5 } } },
    { id: "calc_era_penalty", expression: { op: "multiply", left: { ref: "di_opp_era" }, right: { literal: -1 } } },
    {
      id: "calc_combined",
      expression: { op: "add", left: { ref: "calc_scaled_diff" }, right: { ref: "calc_era_penalty" } },
    },
    {
      id: "calc_normalized",
      expression: { function: "normalize", args: [{ ref: "calc_combined" }, { literal: -20 }, { literal: 20 }] },
    },
  ],

  // No weighting entries at all - proves weighting is optional, not an
  // implicit requirement of every model.
  weighting: [],

  derivedValues: [{ id: "dv_composite_score", expression: { ref: "calc_normalized" } }],

  conditions: [
    {
      id: "cond_diff_positive",
      when: { op: "greaterThan", left: { ref: "di_run_diff" }, right: { literal: 0 } },
    },
    {
      id: "cond_era_low",
      when: { op: "lessThan", left: { ref: "di_opp_era" }, right: { literal: 3.5 } },
    },
    // AND group combining both leaf conditions above.
    { id: "cond_group", all: [{ ref: "cond_diff_positive" }, { ref: "cond_era_low" }] },
  ],

  buckets: [
    {
      id: "bucket_run_diff",
      input: { ref: "di_run_diff" },
      rules: [
        { id: "rd_low", when: { lt: 0 } },
        { id: "rd_mid", when: { range: { min: 0, max: 3 } } },
        { id: "rd_high", when: { gt: 3 } },
      ],
    },
    {
      id: "bucket_era",
      input: { ref: "di_opp_era" },
      rules: [
        { id: "era_ace", when: { lt: 3 } },
        { id: "era_mid", when: { range: { min: 3, max: 4.5 } } },
        { id: "era_high", when: { gt: 4.5 } },
      ],
    },
  ],

  grids: [
    {
      id: "grid_main",
      axes: [
        { id: "axis_run_diff", source: { ref: "bucket_run_diff" } },
        { id: "axis_era", source: { ref: "bucket_era" } },
      ],
    },
  ],

  outcomes: [
    // Non-percentage numeric outcome - a normalized composite index, not a
    // delta/percentage.
    { id: "outcome_score", type: "numeric", unit: "index", expression: { ref: "dv_composite_score" } },
  ],

  metadata: {
    description: "Run differential adjusted for opposing team ERA - a second, unrelated configuration through the same engine.",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    createdBy: "acceptance-test",
    tags: ["team_stats"],
    ownerRef: null,
    sourceRefs: [],
  },
};
