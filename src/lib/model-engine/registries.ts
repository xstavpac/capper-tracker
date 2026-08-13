// Closed, final allowlists for every operator/function ID a Model
// Definition may reference. These are the exact registries agreed in the
// engine's architecture review - adding to any of them later is an
// intentional, versioned schema change, never something the validator or a
// model author does implicitly.

export const ARITHMETIC_BINARY_OPS = ["add", "subtract", "multiply", "divide", "modulo", "power"] as const;
export type ArithmeticBinaryOpId = (typeof ARITHMETIC_BINARY_OPS)[number];

export const ARITHMETIC_UNARY_OPS = ["negate", "abs"] as const;
export type ArithmeticUnaryOpId = (typeof ARITHMETIC_UNARY_OPS)[number];

// Boolean-result operators - valid only inside a Condition leaf's `when`,
// never as a general Expression node (see validate.ts's validateExpression
// vs validateConditionWhen).
export const COMPARISON_OPS = [
  "equal",
  "notEqual",
  "greaterThan",
  "greaterThanOrEqual",
  "lessThan",
  "lessThanOrEqual",
] as const;
export type ComparisonOpId = (typeof COMPARISON_OPS)[number];

// No overlap with the operator registries above - `abs` is UnaryOp only,
// not repeated here.
export const FUNCTION_IDS = ["round", "min", "max", "sum", "average", "normalize"] as const;
export type FunctionId = (typeof FUNCTION_IDS)[number];

// Arity bounds read directly off each function's declared signature in the
// contract (round(value, decimals); min/max/sum/average(values: number[]),
// modeled as a variadic args list since FunctionCall.args is flat rather
// than a nested array literal; normalize(value, min, max)). Structural
// only - this step never executes a function, just checks it was called
// with a plausible number of arguments.
export const FUNCTION_ARITY: Record<FunctionId, { min: number; max: number }> = {
  round: { min: 2, max: 2 },
  min: { min: 1, max: Infinity },
  max: { min: 1, max: Infinity },
  sum: { min: 1, max: Infinity },
  average: { min: 1, max: Infinity },
  normalize: { min: 3, max: 3 },
};

export function isArithmeticBinaryOp(op: string): op is ArithmeticBinaryOpId {
  return (ARITHMETIC_BINARY_OPS as readonly string[]).includes(op);
}
export function isArithmeticUnaryOp(op: string): op is ArithmeticUnaryOpId {
  return (ARITHMETIC_UNARY_OPS as readonly string[]).includes(op);
}
export function isComparisonOp(op: string): op is ComparisonOpId {
  return (COMPARISON_OPS as readonly string[]).includes(op);
}
export function isFunctionId(id: string): id is FunctionId {
  return (FUNCTION_IDS as readonly string[]).includes(id);
}
