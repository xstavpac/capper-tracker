// Pure evaluator for ObservationExpression (Build Step 3c) - the smaller,
// permanently restricted expression language scoped to an Aggregation's
// select/value. Evaluates one node against a single GameObservation plus
// the entity-identity bindings resolved for this Aggregation (e.g.
// entities.team -> "Texas Rangers"). No document-order/ref concerns here,
// unlike evaluateExpression's `{ref}` (Build Step 3a) - entityRef is
// resolved against the local entities map passed in, not a document-wide
// ValueContext.
import { isComparisonOp } from "./registries";
import type { ObservationExpression } from "./types";
import type { GameObservation } from "@/server/data/model-engine/observations";

export type ObservationEntities = Record<string, string | number | boolean>;

// A designed gap-fill, not part of the given contract's exact shapes:
// ObservationExpression has no null literal (its literal type is
// number | boolean | string, matching Expression's), but
// GameObservation.wentOver is boolean | null. A well-formed Aggregation's
// select is expected to exclude null-wentOver observations before value
// ever references the field (the same !== null condition Build Step 3b's
// own overRate/underRate filters already apply) - but nothing in this
// language lets a select expression state "wentOver is not null" directly.
// evaluateObservationExpression throws this specific, distinguishable error
// for a null field access; only the filter side of the orchestration
// wrapper (observation-expression.ts's caller in orchestrate.ts) catches it
// and treats it as "exclude this observation," the same "not an error, an
// expected gap" treatment this project already gives found: false
// elsewhere. Any other thrown error still propagates and fails loudly.
export class ObservationFieldUnavailable extends Error {
  constructor(field: string) {
    super(`observationField "${field}" is unavailable (null) for this observation.`);
    this.name = "ObservationFieldUnavailable";
  }
}

function requireNumber(value: boolean | number | string, label: string): number {
  if (typeof value !== "number") {
    throw new Error(`evaluateObservationExpression: ${label} must be a number, got ${JSON.stringify(value)}.`);
  }
  return value;
}

function requireBoolean(value: boolean | number | string, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`evaluateObservationExpression: ${label} must be a boolean, got ${JSON.stringify(value)}.`);
  }
  return value;
}

export function evaluateObservationExpression(
  expr: ObservationExpression,
  obs: GameObservation,
  entities: ObservationEntities
): boolean | number | string {
  if ("literal" in expr) {
    return expr.literal;
  }

  if ("observationField" in expr) {
    switch (expr.observationField) {
      case "favTeam":
        return obs.favTeam;
      case "dogTeam":
        return obs.dogTeam;
      case "favWon":
        return obs.favWon;
      case "isPush":
        return obs.isPush;
      // Only nullable field among the six - see ObservationFieldUnavailable
      // above for why this throws instead of returning something.
      case "wentOver":
        if (obs.wentOver === null) throw new ObservationFieldUnavailable("wentOver");
        return obs.wentOver;
      // No timestamp/date literal exists in this language either - exposed
      // as milliseconds-since-epoch so it's at least comparable via the
      // ordering operators, a judgment call not spelled out in the given
      // field list beyond the field's existence.
      case "gameDate":
        return obs.gameDate.getTime();
      default:
        throw new Error(`evaluateObservationExpression: unrecognized observationField "${expr.observationField}".`);
    }
  }

  if ("entityRef" in expr) {
    if (!(expr.entityRef in entities)) {
      throw new Error(`evaluateObservationExpression: no entity bound for entityRef "${expr.entityRef}".`);
    }
    return entities[expr.entityRef];
  }

  if ("op" in expr && "left" in expr && "right" in expr) {
    if (!isComparisonOp(expr.op)) {
      throw new Error(`evaluateObservationExpression: "${expr.op}" is not a registered comparison operator.`);
    }
    const left = evaluateObservationExpression(expr.left, obs, entities);
    const right = evaluateObservationExpression(expr.right, obs, entities);
    switch (expr.op) {
      case "equal":
        return left === right;
      case "notEqual":
        return left !== right;
      case "greaterThan":
        return requireNumber(left, "left") > requireNumber(right, "right");
      case "greaterThanOrEqual":
        return requireNumber(left, "left") >= requireNumber(right, "right");
      case "lessThan":
        return requireNumber(left, "left") < requireNumber(right, "right");
      case "lessThanOrEqual":
        return requireNumber(left, "left") <= requireNumber(right, "right");
    }
  }

  if ("all" in expr) {
    return expr.all.every((child, i) => requireBoolean(evaluateObservationExpression(child, obs, entities), `all[${i}]`));
  }

  if ("any" in expr) {
    return expr.any.some((child, i) => requireBoolean(evaluateObservationExpression(child, obs, entities), `any[${i}]`));
  }

  throw new Error(`evaluateObservationExpression: unrecognized expression shape: ${JSON.stringify(expr)}.`);
}
