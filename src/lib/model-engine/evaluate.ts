// The pure expression evaluator - evaluateExpression walks one Expression
// node and returns its value; evaluateComparison is the separate function
// for Condition.when (comparison ops never appear as a general Expression
// node, per registries.ts). Neither function resolves data, decides
// calculation order, or knows anything about weighting/orchestration - this
// is Build Step 3a only. Populating ValueContext correctly, in the right
// order, is Build Step 3c's job.
import {
  isArithmeticBinaryOp,
  isArithmeticUnaryOp,
  isComparisonOp,
  isFunctionId,
  FUNCTION_ARITY,
  type FunctionId,
} from "./registries";
import type { Expression, ConditionWhen, BinaryOpExpr, UnaryOpExpr, FunctionCallExpr } from "./types";

export type ValueContext = { [id: string]: number | boolean | string };

function requireNumber(value: number | boolean | string, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`evaluateExpression: ${label} must be a finite number, got ${JSON.stringify(value)}.`);
  }
  return value;
}

// The general rule from the contract: any arithmetic result that comes out
// NaN or ±Infinity fails loudly instead of propagating. This alone covers
// divide-by-zero, modulo-by-zero, a fractional power of a negative base, and
// anything else that produces a mathematically invalid result - no need to
// enumerate cases individually.
function requireFiniteResult(value: number, description: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`evaluateExpression: ${description} produced a non-finite result (${value}).`);
  }
  return value;
}

export function evaluateExpression(expr: Expression, context: ValueContext): number | boolean | string {
  if ("literal" in expr) {
    return expr.literal;
  }
  if ("ref" in expr) {
    // Build Step 1's validator already rejects dangling refs at the schema
    // level - this shouldn't happen in a well-formed Model Definition. If a
    // Build Step 3c orchestration bug calls this out of order anyway, fail
    // visibly rather than returning undefined/NaN silently.
    if (!(expr.ref in context)) {
      throw new Error(`evaluateExpression: no value in context for ref "${expr.ref}".`);
    }
    return context[expr.ref];
  }
  if ("op" in expr && "left" in expr && "right" in expr) {
    return evaluateBinaryOp(expr, context);
  }
  if ("op" in expr && "operand" in expr) {
    return evaluateUnaryOp(expr, context);
  }
  if ("function" in expr && "args" in expr) {
    return evaluateFunctionCall(expr, context);
  }
  throw new Error(`evaluateExpression: unrecognized expression shape: ${JSON.stringify(expr)}.`);
}

function evaluateBinaryOp(expr: BinaryOpExpr, context: ValueContext): number {
  if (!isArithmeticBinaryOp(expr.op)) {
    throw new Error(`evaluateExpression: "${expr.op}" is not a registered arithmetic binary operator.`);
  }
  const left = requireNumber(evaluateExpression(expr.left, context), `${expr.op}'s left operand`);
  const right = requireNumber(evaluateExpression(expr.right, context), `${expr.op}'s right operand`);

  let result: number;
  switch (expr.op) {
    case "add":
      result = left + right;
      break;
    case "subtract":
      result = left - right;
      break;
    case "multiply":
      result = left * right;
      break;
    case "divide":
      result = left / right;
      break;
    case "modulo":
      result = left % right;
      break;
    case "power":
      result = Math.pow(left, right);
      break;
  }
  return requireFiniteResult(result, `${expr.op}(${left}, ${right})`);
}

function evaluateUnaryOp(expr: UnaryOpExpr, context: ValueContext): number {
  if (!isArithmeticUnaryOp(expr.op)) {
    throw new Error(`evaluateExpression: "${expr.op}" is not a registered arithmetic unary operator.`);
  }
  const operand = requireNumber(evaluateExpression(expr.operand, context), `${expr.op}'s operand`);
  const result = expr.op === "negate" ? -operand : Math.abs(operand);
  return requireFiniteResult(result, `${expr.op}(${operand})`);
}

// args: Expression[] is read as a variadic list of expressions - each
// element is evaluated individually first, then the function is applied to
// the resulting list of values. Not a single expression that evaluates to
// an array; FunctionCallExpr never has exactly one arg node whose own value
// is an array, all of min/max/sum/average's "list" semantics come from the
// flat args array itself.
function evaluateFunctionCall(expr: FunctionCallExpr, context: ValueContext): number {
  if (!isFunctionId(expr.function)) {
    throw new Error(`evaluateExpression: "${expr.function}" is not a registered function.`);
  }
  const fn: FunctionId = expr.function;
  const values = expr.args.map((arg, i) => requireNumber(evaluateExpression(arg, context), `${fn}'s args[${i}]`));

  const arity = FUNCTION_ARITY[fn];
  if (values.length < arity.min || values.length > arity.max) {
    const expected = arity.min === arity.max ? `${arity.min}` : `${arity.min}-${arity.max === Infinity ? "many" : arity.max}`;
    throw new Error(`evaluateExpression: ${fn} expects ${expected} argument(s), got ${values.length}.`);
  }

  let result: number;
  switch (fn) {
    case "round": {
      const [value, decimals] = values;
      // Not caught by the general finite-result rule below - a negative or
      // fractional `decimals` produces a valid-looking but wrong finite
      // number (e.g. rounding to the nearest ten), not NaN/Infinity, so it
      // needs its own explicit check. Nothing in this project needs
      // rounding to the nearest ten.
      if (!Number.isInteger(decimals) || decimals < 0) {
        throw new Error(`evaluateExpression: round's decimals must be a non-negative integer, got ${decimals}.`);
      }
      const factor = Math.pow(10, decimals);
      result = Math.round(value * factor) / factor;
      break;
    }
    case "min":
      result = Math.min(...values);
      break;
    case "max":
      result = Math.max(...values);
      break;
    case "sum":
      result = values.reduce((a, b) => a + b, 0);
      break;
    case "average":
      result = values.reduce((a, b) => a + b, 0) / values.length;
      break;
    case "normalize": {
      const [value, min, max] = values;
      // Also not caught by the general finite-result rule - min == max
      // would fail via that rule (division by zero -> NaN/Infinity), but
      // min > max produces a valid-looking, semantically inverted finite
      // number instead, so this needs its own explicit check. min/max can
      // be arbitrary expressions, not just literals, so this can only be
      // checked here, at evaluation time.
      if (min >= max) {
        throw new Error(`evaluateExpression: normalize requires min < max, got min=${min}, max=${max}.`);
      }
      result = value <= min ? 0 : value >= max ? 1 : (value - min) / (max - min);
      break;
    }
  }
  return requireFiniteResult(result, `${fn}(${values.join(", ")})`);
}

// Separate from evaluateExpression on purpose - comparisons only ever
// appear inside a Condition leaf's `when`, never as a general Expression
// node, mirroring the closed arithmetic-vs-comparison registry split from
// Build Step 1. equal/notEqual work on any matching type (strict equality);
// the four ordering comparisons require numeric operands, since ordering
// isn't meaningful for the other value types Expression can produce.
export function evaluateComparison(when: ConditionWhen, context: ValueContext): boolean {
  if (!isComparisonOp(when.op)) {
    throw new Error(`evaluateComparison: "${when.op}" is not a registered comparison operator.`);
  }
  const left = evaluateExpression(when.left, context);
  const right = evaluateExpression(when.right, context);

  switch (when.op) {
    case "equal":
      return left === right;
    case "notEqual":
      return left !== right;
    case "greaterThan":
      return requireNumber(left, "when.left") > requireNumber(right, "when.right");
    case "greaterThanOrEqual":
      return requireNumber(left, "when.left") >= requireNumber(right, "when.right");
    case "lessThan":
      return requireNumber(left, "when.left") < requireNumber(right, "when.right");
    case "lessThanOrEqual":
      return requireNumber(left, "when.left") <= requireNumber(right, "when.right");
  }
}
