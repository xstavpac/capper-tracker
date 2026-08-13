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

export type Calculation = {
  id: string;
  expression: Expression;
  weightingRef?: string;
};

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
  // Top-level and named, not a pipeline stage - referenced by id via
  // Calculation.weightingRef, not positioned in the document-order chain
  // the other sections' references are checked against (see validate.ts).
  weighting: WeightingSpec[];
  derivedValues: DerivedValue[];
  conditions: Condition[];
  buckets: Bucket[];
  grids: Grid[];
  outcomes: Outcome[];
  metadata: Metadata;
};
