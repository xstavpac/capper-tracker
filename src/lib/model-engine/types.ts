// The Model Definition contract - the single typed shape the visual
// builder, saved models, and eventually a connected AI all produce, and
// that the (not-yet-built) execution engine will interpret. This file is
// types only; see validate.ts for the structural validator and
// registries.ts for the closed operator/function allowlists these types
// reference.
import type { ArithmeticBinaryOpId, ArithmeticUnaryOpId, ComparisonOpId, FunctionId } from "./registries";

// ===== Expression tree =====
// Discriminated by which keys are present, not a `kind` tag - see
// validate.ts's classifyExpression for how the five shapes are told apart.
export type LiteralExpr = { literal: number | boolean | string };
export type RefExpr = { ref: string };
export type BinaryOpExpr = { op: ArithmeticBinaryOpId; left: Expression; right: Expression };
export type UnaryOpExpr = { op: ArithmeticUnaryOpId; operand: Expression };
export type FunctionCallExpr = { function: FunctionId; args: Expression[] };

export type Expression = LiteralExpr | RefExpr | BinaryOpExpr | UnaryOpExpr | FunctionCallExpr;

// A comparison is never itself an Expression - it only appears as a
// Condition leaf's `when`. Its own left/right are ordinary (arithmetic)
// Expressions; comparisons don't nest inside each other or inside
// arithmetic.
export type ConditionWhen = { op: ComparisonOpId; left: Expression; right: Expression };

export type ConditionLeaf = { id: string; when: ConditionWhen };
export type ConditionRef = { ref: string };
// Exactly one of all/any - a group is AND (`all`) or OR (`any`), never
// both. Groups can nest: a group's ConditionRef can point at another
// group's id, since every Condition (leaf or group) lives in the same flat
// top-level `conditions` array and is addressed by id.
export type ConditionGroupAll = { id: string; all: ConditionRef[] };
export type ConditionGroupAny = { id: string; any: ConditionRef[] };
export type Condition = ConditionLeaf | ConditionGroupAll | ConditionGroupAny;

export type DataInput = {
  id: string;
  // Not existence-checked against the live MODEL_VARIABLES catalog
  // (src/lib/model-builder.ts) - this step is deliberately decoupled from
  // that surviving infrastructure, per the instruction not to touch or
  // wire into it yet. Structural validation only checks this is a
  // non-empty string.
  variableId: string;
  entity: { type: string; role: string };
  params: Record<string, unknown>;
  // Future provenance hook - nullable, unused until the resolver/DATA-layer
  // step exists. The validator only type-checks it.
  sourceRef: string | null;
};

// A pure expression calculation - evaluated via evaluateExpression (Build
// Step 3a) against whatever's already in the ValueContext.
export type ExpressionCalculation = { id: string; expression: Expression };

// ===== ObservationExpression - a second, deliberately much smaller
// expression language, scoped to per-observation selection/value extraction
// inside an Aggregation. Permanently restricted: no BinaryOp/UnaryOp/
// FunctionCall node exists here, and none may be added - it answers exactly
// two questions (should this observation be included, what value does it
// contribute), never general computation. Any future per-observation
// transformation is a new, explicitly registered, closed capability with
// its own schema/engine version bump, not an expansion of this language. =====
export type ObservationLiteralExpr = { literal: number | boolean | string };
// observationField is closed PER SOURCE, not one global list - see
// OBSERVATION_FIELDS_BY_SOURCE in registries.ts. A future source registers
// its own closed field set independently; these never merge into one
// shared enum.
export type ObservationFieldExpr = { observationField: string };
// Must match a key in the enclosing Aggregation's own `entities` map -
// checked by the validator, not by this type itself.
export type ObservationEntityRefExpr = { entityRef: string };
// Comparison ops reused verbatim from the already-closed registry
// (registries.ts's ComparisonOpId) - the exact same six values Condition.when
// uses, not a parallel list.
export type ObservationComparisonExpr = { op: ComparisonOpId; left: ObservationExpression; right: ObservationExpression };
export type ObservationAllExpr = { all: ObservationExpression[] };
export type ObservationAnyExpr = { any: ObservationExpression[] };

export type ObservationExpression =
  | ObservationLiteralExpr
  | ObservationFieldExpr
  | ObservationEntityRefExpr
  | ObservationComparisonExpr
  | ObservationAllExpr
  | ObservationAnyExpr;

// source is a closed registry (registries.ts's AGGREGATION_SOURCES) - exactly
// one value today ("gameObservations"). Adding a source is an intentional,
// versioned schema/engine change, same rule as every other closed registry.
export type AggregationSource = "gameObservations";
// method is likewise closed (AGGREGATION_METHODS) - exactly "weightedAverage"
// today. Subsumes what would otherwise have been a separate "weightedRate" -
// a rate is an average of 0/1 values, same math, one primitive.
export type AggregationMethod = "weightedAverage";

export type Aggregation = {
  source: AggregationSource;
  // A named map, not a single field - each entry's ref points to an
  // existing DataInput's id, which identifies an entity (e.g. a team) via
  // the existing DATA layer. A future source needing two simultaneous
  // bindings (e.g. a pitcher and their team) adds a second named entry, not
  // a new top-level field.
  entities: Record<string, { ref: string }>;
  // Must evaluate to boolean - whether a given observation is included.
  select: ObservationExpression;
  // May evaluate to boolean or number - what value that observation
  // contributes if included.
  value: ObservationExpression;
  // The only place weightingRef is still meaningful - relocated here from
  // the old flat Calculation shape.
  weightingRef: string;
  method: AggregationMethod;
};

// An aggregation calculation - resolves a dated observation series (e.g.
// Build Step 2.5's resolveGameObservations) and reduces it to one weighted
// value via Build Step 3b's computeWeightedRate. This is the declarative
// counterpart to 3b's filter/valueOf TypeScript closures, which can't live
// in JSON.
export type AggregationCalculation = { id: string; aggregation: Aggregation };

// Discriminated by which key is present (expression vs. aggregation) -
// matching Expression's existing key-presence convention. No `kind` field.
export type Calculation = ExpressionCalculation | AggregationCalculation;

// Only "exponential" is defined by the finalized contract this step
// implements. Adding a method is the same kind of intentional, versioned
// change as adding to the operator/function registries in registries.ts -
// not something this step decides.
export type WeightingMethod = "exponential";
export type WeightingSpec = {
  id: string;
  method: WeightingMethod;
  parameters: { halfLifeDays: number };
};

export type DerivedValue = {
  id: string;
  expression: Expression;
};

// Formalized bucket-rule shape (the contract's own examples used two
// inconsistent shapes - `{ when: { lt: 0 } }` vs. a bare `{ range: {...} }`
// - and asked for one consistent convention). Every rule uses the same
// `when` envelope, with exactly one boundary key.
export type BucketRuleWhen =
  | { lt: number }
  | { lte: number }
  | { gt: number }
  | { gte: number }
  | { range: { min: number; max: number } };

export type BucketRule = { id: string; when: BucketRuleWhen };
export type Bucket = { id: string; input: { ref: string }; rules: BucketRule[] };

export type GridAxis = { id: string; source: { ref: string } };
export type Grid = { id: string; axes: GridAxis[] };

export type Outcome = {
  id: string;
  type: "numeric" | "boolean";
  unit?: string;
  expression: Expression;
};

export type Metadata = {
  description: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  tags: string[];
  // Future ownership/sharing hooks - present so a later step doesn't need
  // a schema migration to add them, but nothing in this step reads or acts
  // on them beyond type-checking their shape.
  ownerRef: string | null;
  sourceRefs: string[];
};

export type ModelDefinition = {
  schemaVersion: 1;
  modelId: string;
  name: string;
  sport: string;
  dataInputs: DataInput[];
  calculations: Calculation[];
  // Top-level and named, not a pipeline stage - referenced by id via an
  // AggregationCalculation's Aggregation.weightingRef, not positioned in
  // the document-order chain the other sections' references are checked
  // against (see validate.ts).
  weighting: WeightingSpec[];
  derivedValues: DerivedValue[];
  conditions: Condition[];
  buckets: Bucket[];
  grids: Grid[];
  outcomes: Outcome[];
  metadata: Metadata;
};
