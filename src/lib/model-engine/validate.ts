// Structural + type validator for a Model Definition document. Deliberately
// does not compute, execute, or type-infer through the expression graph
// (e.g. it never asks "does this ref resolve to a number") - only whether
// the document is shaped correctly: every op/function id is in its correct
// registry, every reference exists and was defined earlier in the
// document, and no id is reused. That's the full scope of this step - the
// execution/resolver engine is a separate, later piece of work.
import {
  ARITHMETIC_BINARY_OPS,
  ARITHMETIC_UNARY_OPS,
  COMPARISON_OPS,
  FUNCTION_ARITY,
  isArithmeticBinaryOp,
  isArithmeticUnaryOp,
  isComparisonOp,
  isFunctionId,
} from "./registries";
import type { BucketRule, Condition, Metadata, ModelDefinition, Outcome } from "./types";

export type ValidationError = { path: string; message: string };
export type ValidationResult = { valid: boolean; errors: ValidationError[] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}
function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

// Every id encountered anywhere in the document, and where each top-level
// (referenceable) id sits in document order. Built in one pass before any
// reference is checked, so existence/ordering checks never depend on
// traversal order elsewhere.
type IdRegistry = {
  allIds: Map<string, number>; // id -> count seen (for duplicate detection, every nesting level)
  orderIndex: Map<string, number>; // id -> position, top-level referenceable ids only
  weightingIds: Set<string>; // existence-only target set for weightingRef
};

export function validateModelDefinition(doc: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });

  if (!isPlainObject(doc)) {
    return { valid: false, errors: [{ path: "$", message: "Model Definition must be a JSON object." }] };
  }

  if (doc.schemaVersion !== 1) {
    err("$.schemaVersion", `schemaVersion must be exactly 1, got ${JSON.stringify(doc.schemaVersion)}.`);
  }
  if (!isNonEmptyString(doc.modelId)) err("$.modelId", "modelId must be a non-empty string.");
  if (!isNonEmptyString(doc.name)) err("$.name", "name must be a non-empty string.");
  if (!isNonEmptyString(doc.sport)) err("$.sport", "sport must be a non-empty string.");

  const sectionNames = [
    "dataInputs",
    "calculations",
    "weighting",
    "derivedValues",
    "conditions",
    "buckets",
    "grids",
    "outcomes",
  ] as const;
  for (const s of sectionNames) {
    if (!isArray((doc as Record<string, unknown>)[s])) err(`$.${s}`, `${s} must be an array.`);
  }
  if (!isPlainObject(doc.metadata)) err("$.metadata", "metadata must be an object.");

  // Bail before reference/registry checks if the basic shape is broken -
  // those checks assume the sections above exist as arrays.
  if (errors.length > 0) return { valid: false, errors };

  const dataInputs = doc.dataInputs as unknown[];
  const calculations = doc.calculations as unknown[];
  const weighting = doc.weighting as unknown[];
  const derivedValues = doc.derivedValues as unknown[];
  const conditions = doc.conditions as unknown[];
  const buckets = doc.buckets as unknown[];
  const grids = doc.grids as unknown[];
  const outcomes = doc.outcomes as unknown[];

  // ---- Pass 1: collect every id (duplicate detection) and build the
  // document-order index for top-level referenceable ids. ----
  const registry: IdRegistry = { allIds: new Map(), orderIndex: new Map(), weightingIds: new Set() };
  let orderCounter = 0;

  function recordId(id: unknown, path: string, referenceable: boolean) {
    if (!isNonEmptyString(id)) {
      err(path, "id must be a non-empty string.");
      return;
    }
    registry.allIds.set(id, (registry.allIds.get(id) ?? 0) + 1);
    if (referenceable) registry.orderIndex.set(id, orderCounter++);
  }

  dataInputs.forEach((item, i) => isPlainObject(item) && recordId(item.id, `$.dataInputs[${i}].id`, true));
  calculations.forEach((item, i) => isPlainObject(item) && recordId(item.id, `$.calculations[${i}].id`, true));
  weighting.forEach((item, i) => {
    if (!isPlainObject(item)) return;
    if (!isNonEmptyString(item.id)) {
      err(`$.weighting[${i}].id`, "id must be a non-empty string.");
      return;
    }
    registry.allIds.set(item.id, (registry.allIds.get(item.id) ?? 0) + 1);
    registry.weightingIds.add(item.id);
  });
  derivedValues.forEach((item, i) => isPlainObject(item) && recordId(item.id, `$.derivedValues[${i}].id`, true));
  conditions.forEach((item, i) => isPlainObject(item) && recordId(item.id, `$.conditions[${i}].id`, true));
  buckets.forEach((item, i) => {
    if (!isPlainObject(item)) return;
    recordId(item.id, `$.buckets[${i}].id`, true);
    if (isArray(item.rules)) {
      item.rules.forEach((rule, j) => isPlainObject(rule) && recordId(rule.id, `$.buckets[${i}].rules[${j}].id`, false));
    }
  });
  grids.forEach((item, i) => {
    if (!isPlainObject(item)) return;
    recordId(item.id, `$.grids[${i}].id`, true);
    if (isArray(item.axes)) {
      item.axes.forEach((axis, j) => isPlainObject(axis) && recordId(axis.id, `$.grids[${i}].axes[${j}].id`, false));
    }
  });
  outcomes.forEach((item, i) => isPlainObject(item) && recordId(item.id, `$.outcomes[${i}].id`, true));

  for (const [id, count] of registry.allIds) {
    if (count > 1) err("$", `Duplicate id "${id}" appears ${count} times in the document - every id must be unique.`);
  }

  // ---- Reference checking, shared by every section below. `sourceIndex`
  // is the referencing top-level construct's own position in document
  // order - a target is valid only if it exists and its position is
  // strictly earlier. Self-references and forward references both fail
  // this the same way (target index >= source index), and since order is
  // a total order computed independently of the reference graph itself, no
  // cycle can pass this check either - a cycle would require some edge in
  // it to point at or ahead of its own source, which is exactly what this
  // rejects. ----
  function checkRef(targetId: unknown, path: string, sourceIndex: number) {
    if (!isNonEmptyString(targetId)) {
      err(path, "ref must be a non-empty string id.");
      return;
    }
    if (!registry.allIds.has(targetId)) {
      err(path, `references unknown id "${targetId}".`);
      return;
    }
    const targetIndex = registry.orderIndex.get(targetId);
    if (targetIndex === undefined) {
      err(path, `"${targetId}" exists but is not a valid reference target (not a top-level dataInput/calculation/derivedValue/condition/bucket/grid/outcome id).`);
      return;
    }
    if (targetIndex >= sourceIndex) {
      err(path, `references "${targetId}", which is not defined earlier in the document (no forward references or cycles allowed).`);
    }
  }

  function checkWeightingRef(targetId: unknown, path: string) {
    if (!isNonEmptyString(targetId)) {
      err(path, "weightingRef must be a non-empty string id.");
      return;
    }
    if (!registry.weightingIds.has(targetId)) {
      err(path, `references unknown weighting id "${targetId}".`);
    }
  }

  // ---- Expression validation. `ctx` carries the source index (for ref
  // ordering) and path for error messages. ----
  function validateExpression(node: unknown, path: string, sourceIndex: number): void {
    if (!isPlainObject(node)) {
      err(path, "Expression must be an object.");
      return;
    }
    const shapes = {
      literal: "literal" in node,
      ref: "ref" in node,
      binary: "op" in node && "left" in node && "right" in node,
      unary: "op" in node && "operand" in node,
      call: "function" in node && "args" in node,
    };
    const matched = Object.entries(shapes).filter(([, v]) => v);
    if (matched.length === 0) {
      err(path, "Expression does not match any known shape (literal/ref/op+left+right/op+operand/function+args).");
      return;
    }
    if (matched.length > 1) {
      err(path, `Expression matches more than one shape (${matched.map(([k]) => k).join(", ")}) - ambiguous.`);
      return;
    }

    if (shapes.literal) {
      const v = node.literal;
      if (typeof v !== "number" && typeof v !== "boolean" && typeof v !== "string") {
        err(`${path}.literal`, "literal must be a number, boolean, or string.");
      }
      return;
    }
    if (shapes.ref) {
      checkRef(node.ref, `${path}.ref`, sourceIndex);
      return;
    }
    if (shapes.binary) {
      const op = node.op;
      if (!isString(op) || !isArithmeticBinaryOp(op)) {
        err(`${path}.op`, `"${String(op)}" is not a registered arithmetic binary operator (${ARITHMETIC_BINARY_OPS.join(", ")}).`);
      }
      validateExpression(node.left, `${path}.left`, sourceIndex);
      validateExpression(node.right, `${path}.right`, sourceIndex);
      return;
    }
    if (shapes.unary) {
      const op = node.op;
      if (!isString(op) || !isArithmeticUnaryOp(op)) {
        err(`${path}.op`, `"${String(op)}" is not a registered arithmetic unary operator (${ARITHMETIC_UNARY_OPS.join(", ")}).`);
      }
      validateExpression(node.operand, `${path}.operand`, sourceIndex);
      return;
    }
    if (shapes.call) {
      const fn = node.function;
      if (!isString(fn) || !isFunctionId(fn)) {
        err(`${path}.function`, `"${String(fn)}" is not a registered function.`);
      }
      if (!isArray(node.args)) {
        err(`${path}.args`, "args must be an array of Expression.");
        return;
      }
      node.args.forEach((arg, i) => validateExpression(arg, `${path}.args[${i}]`, sourceIndex));
      if (isString(fn) && isFunctionId(fn)) {
        const arity = FUNCTION_ARITY[fn];
        if (node.args.length < arity.min || node.args.length > arity.max) {
          err(`${path}.args`, `${fn} expects ${arity.min === arity.max ? arity.min : `${arity.min}-${arity.max === Infinity ? "many" : arity.max}`} argument(s), got ${node.args.length}.`);
        }
      }
      return;
    }
  }

  function validateConditionWhen(node: unknown, path: string, sourceIndex: number): void {
    if (!isPlainObject(node)) {
      err(path, "Condition.when must be an object.");
      return;
    }
    const op = node.op;
    if (!isString(op) || !isComparisonOp(op)) {
      err(`${path}.op`, `"${String(op)}" is not a registered comparison operator (${COMPARISON_OPS.join(", ")}).`);
    }
    if (!("left" in node)) err(`${path}.left`, "when.left is required.");
    else validateExpression(node.left, `${path}.left`, sourceIndex);
    if (!("right" in node)) err(`${path}.right`, "when.right is required.");
    else validateExpression(node.right, `${path}.right`, sourceIndex);
  }

  // ---- DataInput ----
  dataInputs.forEach((item, i) => {
    const path = `$.dataInputs[${i}]`;
    if (!isPlainObject(item)) return err(path, "must be an object.");
    if (!isNonEmptyString(item.variableId)) err(`${path}.variableId`, "variableId must be a non-empty string.");
    if (!isPlainObject(item.entity)) {
      err(`${path}.entity`, "entity must be an object with { type, role }.");
    } else {
      if (!isNonEmptyString(item.entity.type)) err(`${path}.entity.type`, "entity.type must be a non-empty string.");
      if (!isNonEmptyString(item.entity.role)) err(`${path}.entity.role`, "entity.role must be a non-empty string.");
    }
    if (!isPlainObject(item.params)) err(`${path}.params`, "params must be an object.");
    if (item.sourceRef !== null && !isString(item.sourceRef)) err(`${path}.sourceRef`, "sourceRef must be a string or null.");
  });

  // ---- Calculation ----
  calculations.forEach((item, i) => {
    const path = `$.calculations[${i}]`;
    if (!isPlainObject(item)) return err(path, "must be an object.");
    const sourceIndex = registry.orderIndex.get(item.id as string) ?? -1;
    validateExpression(item.expression, `${path}.expression`, sourceIndex);
    if (item.weightingRef !== undefined) checkWeightingRef(item.weightingRef, `${path}.weightingRef`);
  });

  // ---- WeightingSpec ----
  weighting.forEach((item, i) => {
    const path = `$.weighting[${i}]`;
    if (!isPlainObject(item)) return err(path, "must be an object.");
    if (item.method !== "exponential") {
      err(`${path}.method`, `"${String(item.method)}" is not a registered weighting method (only "exponential" is defined).`);
    }
    if (!isPlainObject(item.parameters) || !isNumber(item.parameters.halfLifeDays) || (item.parameters.halfLifeDays as number) <= 0) {
      err(`${path}.parameters.halfLifeDays`, "parameters.halfLifeDays must be a positive number.");
    }
  });

  // ---- DerivedValue ----
  derivedValues.forEach((item, i) => {
    const path = `$.derivedValues[${i}]`;
    if (!isPlainObject(item)) return err(path, "must be an object.");
    const sourceIndex = registry.orderIndex.get(item.id as string) ?? -1;
    validateExpression(item.expression, `${path}.expression`, sourceIndex);
  });

  // ---- Condition ----
  conditions.forEach((item, i) => {
    const path = `$.conditions[${i}]`;
    if (!isPlainObject(item)) return err(path, "must be an object.");
    const sourceIndex = registry.orderIndex.get(item.id as string) ?? -1;
    const hasWhen = "when" in item;
    const hasAll = "all" in item;
    const hasAny = "any" in item;
    const shapeCount = [hasWhen, hasAll, hasAny].filter(Boolean).length;
    if (shapeCount === 0) {
      err(path, "Condition must have exactly one of: when (leaf), all (AND group), any (OR group).");
      return;
    }
    if (shapeCount > 1) {
      err(path, "Condition must have exactly one of when/all/any, not more than one.");
      return;
    }
    if (hasWhen) {
      validateConditionWhen((item as Condition & { when: unknown }).when, `${path}.when`, sourceIndex);
      return;
    }
    const refs = hasAll ? (item as { all: unknown }).all : (item as { any: unknown }).any;
    const key = hasAll ? "all" : "any";
    if (!isArray(refs)) {
      err(`${path}.${key}`, `${key} must be an array of { ref }.`);
      return;
    }
    if (refs.length === 0) err(`${path}.${key}`, `${key} must contain at least one condition reference.`);
    refs.forEach((r, j) => {
      if (!isPlainObject(r) || !("ref" in r)) {
        err(`${path}.${key}[${j}]`, "must be an object of the form { ref: <conditionId> }.");
        return;
      }
      checkRef(r.ref, `${path}.${key}[${j}].ref`, sourceIndex);
    });
  });

  // ---- Bucket ----
  function validateBucketRuleWhen(when: unknown, path: string): void {
    if (!isPlainObject(when)) {
      err(path, "rule.when must be an object.");
      return;
    }
    const keys = (["lt", "lte", "gt", "gte", "range"] as const).filter((k) => k in when);
    if (keys.length === 0) {
      err(path, "rule.when must have exactly one of: lt, lte, gt, gte, range.");
      return;
    }
    if (keys.length > 1) {
      err(path, `rule.when must have exactly one boundary key, found ${keys.join(", ")}.`);
      return;
    }
    const key = keys[0];
    if (key === "range") {
      const range = (when as { range: unknown }).range;
      if (!isPlainObject(range) || !isNumber(range.min) || !isNumber(range.max)) {
        err(`${path}.range`, "range must be { min: number, max: number }.");
      } else if ((range.min as number) >= (range.max as number)) {
        err(`${path}.range`, "range.min must be less than range.max.");
      }
    } else {
      const v = (when as Record<string, unknown>)[key];
      if (!isNumber(v)) err(`${path}.${key}`, `${key} must be a number.`);
    }
  }

  buckets.forEach((item, i) => {
    const path = `$.buckets[${i}]`;
    if (!isPlainObject(item)) return err(path, "must be an object.");
    const sourceIndex = registry.orderIndex.get(item.id as string) ?? -1;
    if (!isPlainObject(item.input) || !("ref" in item.input)) {
      err(`${path}.input`, "input must be an object of the form { ref: <id> }.");
    } else {
      checkRef((item.input as { ref: unknown }).ref, `${path}.input.ref`, sourceIndex);
    }
    if (!isArray(item.rules) || item.rules.length === 0) {
      err(`${path}.rules`, "rules must be a non-empty array of BucketRule.");
    } else {
      (item.rules as unknown[]).forEach((rule, j) => {
        const rulePath = `${path}.rules[${j}]`;
        if (!isPlainObject(rule)) return err(rulePath, "must be an object.");
        validateBucketRuleWhen((rule as BucketRule).when, `${rulePath}.when`);
      });
    }
  });

  // ---- Grid ----
  grids.forEach((item, i) => {
    const path = `$.grids[${i}]`;
    if (!isPlainObject(item)) return err(path, "must be an object.");
    const sourceIndex = registry.orderIndex.get(item.id as string) ?? -1;
    if (!isArray(item.axes) || item.axes.length === 0) {
      err(`${path}.axes`, "axes must be a non-empty array.");
      return;
    }
    (item.axes as unknown[]).forEach((axis, j) => {
      const axisPath = `${path}.axes[${j}]`;
      if (!isPlainObject(axis)) return err(axisPath, "must be an object.");
      if (!isNonEmptyString(axis.id)) err(`${axisPath}.id`, "id must be a non-empty string.");
      if (!isPlainObject(axis.source) || !("ref" in axis.source)) {
        err(`${axisPath}.source`, "source must be an object of the form { ref: <bucketId> }.");
      } else {
        checkRef((axis.source as { ref: unknown }).ref, `${axisPath}.source.ref`, sourceIndex);
      }
    });
  });

  // ---- Outcome ----
  outcomes.forEach((item, i) => {
    const path = `$.outcomes[${i}]`;
    if (!isPlainObject(item)) return err(path, "must be an object.");
    const sourceIndex = registry.orderIndex.get(item.id as string) ?? -1;
    const type = (item as Outcome).type;
    if (type !== "numeric" && type !== "boolean") {
      err(`${path}.type`, `type must be "numeric" or "boolean", got ${JSON.stringify(type)}.`);
    }
    if (item.unit !== undefined && !isString(item.unit)) err(`${path}.unit`, "unit must be a string when present.");
    validateExpression(item.expression, `${path}.expression`, sourceIndex);
  });

  // ---- Metadata ----
  if (isPlainObject(doc.metadata)) {
    const m = doc.metadata as Partial<Metadata>;
    if (!isString(m.description)) err("$.metadata.description", "description must be a string.");
    if (!isString(m.createdAt)) err("$.metadata.createdAt", "createdAt must be a string.");
    if (!isString(m.updatedAt)) err("$.metadata.updatedAt", "updatedAt must be a string.");
    if (!isString(m.createdBy)) err("$.metadata.createdBy", "createdBy must be a string.");
    if (!isArray(m.tags) || !m.tags.every((t) => isString(t))) err("$.metadata.tags", "tags must be an array of strings.");
    if (m.ownerRef !== null && !isString(m.ownerRef)) err("$.metadata.ownerRef", "ownerRef must be a string or null.");
    if (!isArray(m.sourceRefs) || !m.sourceRefs.every((t) => isString(t))) {
      err("$.metadata.sourceRefs", "sourceRefs must be an array of strings.");
    }
  }

  return { valid: errors.length === 0, errors };
}

// Lets a caller validating a value of unknown shape narrow it after a
// successful validation without a second type-cast elsewhere.
export function isValidModelDefinition(doc: unknown): doc is ModelDefinition {
  return validateModelDefinition(doc).valid;
}
