// Model Definition orchestration (Build Step 3c) - the actual execution
// engine, wiring DATA (Build Steps 2/2.5) -> calculations (3a/3b via
// ObservationExpression) -> derived values -> conditions -> buckets -> grids
// -> outcomes. Only calls existing DATA-layer/3a/3b functions; none of
// their own logic is modified here.
import { resolveVariable } from "./resolver";
import { getEvaluationEventFacts } from "./facts";
import { getPregameEventFacts } from "./pregame-facts";
import { resolveGameObservations, filterObservationsBeforeAsOf, type GameObservation } from "./observations";
import { evaluateExpression, evaluateComparison, type ValueContext } from "@/lib/model-engine/evaluate";
import { computeWeightedRate } from "@/lib/model-engine/weighted-accumulation";
import { evaluateObservationExpression, ObservationFieldUnavailable } from "@/lib/model-engine/observation-expression";
import type {
  ModelDefinition,
  Expression,
  ConditionWhen,
  Condition,
  Calculation,
  Aggregation,
  BucketRuleWhen,
} from "@/lib/model-engine/types";

// One specific game, evaluated as of one specific instant - the concrete
// input section 5 calls "an evaluation event." Two shapes, discriminated by
// key presence (same convention as Expression/Condition/Calculation) -
// GradedEvaluationEvent for an already-finished GameResult row (unchanged
// since 3c), and PregameEvaluationEvent (Build Step 6) for a matchup that
// hasn't been played yet, identified by team pair instead of a GameResult
// id since none exists. asOf still means the same thing in both: the
// instant "as of which" every weighted-history lookup runs - for the
// pregame path this should be the actual moment of evaluation (e.g. "now",
// hours before that night's games start), NOT the game's own future
// commenceTime - passing commenceTime would be harmless today (Build Step
// 2.5's gameDate >= asOf exclusion only cares about calendar day, and a
// pregame matchup has no GameObservation row of its own yet to leak), but
// "now" is the honest answer to "as of when is this prediction being made,"
// and correctly excludes any of either team's OTHER games earlier the same
// Eastern calendar day (e.g. a doubleheader opener that already finished) -
// the exact same same-day exclusion Build Step 2.5 already enforces,
// reused verbatim, not reimplemented.
export type GradedEvaluationEvent = { gameResultId: string; asOf: Date };
export type PregameEvaluationEvent = { sportKey: string; homeTeam: string; awayTeam: string; asOf: Date };
export type EvaluationEvent = GradedEvaluationEvent | PregameEvaluationEvent;

// Deliberately NOT named ResolvedValue - that name is already taken by a
// differently-shaped type from Build Step 2 ({ value, timestamp, found }).
// Used only at the point the rest of the system needs a found/not-found
// signal on a final value - Outcome results, and (optionally) any other
// node a caller wants to inspect for debugging "why did this land here."
export type AggregationOutcome<T> = { found: true; value: T } | { found: false };

export type BucketResult = { ruleId: string | null; found: boolean };
export type GridResult = { cell: (string | null)[]; found: boolean };

export type OrchestrationResult = {
  // Plain number | boolean | string values only, exactly as Build Step 3a
  // built ValueContext - never reopened to understand a wrapper type.
  context: ValueContext;
  // Unavailability tracked separately, in this parallel set - never
  // conflated with a legitimate computed value like 0.
  unavailableIds: Set<string>;
  conditions: Record<string, AggregationOutcome<boolean>>;
  buckets: Record<string, BucketResult>;
  grids: Record<string, GridResult>;
  outcomes: Record<string, AggregationOutcome<number | boolean | string>>;
};

// ---- Expression ref collection - a full recursive walk of ONE node's own
// tree, gathering every {ref: id} it names anywhere inside itself. These
// are that node's "direct" references; a reference-of-a-reference
// (node A refs B, B internally refs C) is NOT collected here - if C was
// unavailable, B's own check already caught it and marked B unavailable,
// which then IS one of A's direct references. That's what makes the
// unavailability propagation transitive "for free" in document order. ----
function collectExpressionRefIds(expr: Expression): string[] {
  if ("literal" in expr) return [];
  if ("ref" in expr) return [expr.ref];
  if ("op" in expr && "left" in expr && "right" in expr) {
    return [...collectExpressionRefIds(expr.left), ...collectExpressionRefIds(expr.right)];
  }
  if ("op" in expr && "operand" in expr) return collectExpressionRefIds(expr.operand);
  if ("function" in expr && "args" in expr) return expr.args.flatMap(collectExpressionRefIds);
  return [];
}
function collectConditionWhenRefIds(when: ConditionWhen): string[] {
  return [...collectExpressionRefIds(when.left), ...collectExpressionRefIds(when.right)];
}

function anyUnavailable(ids: string[], unavailableIds: Set<string>): boolean {
  return ids.some((id) => unavailableIds.has(id));
}

// ---- DataInput entity resolution ----
// Maps a DataInput's entity.role to an actual team name using this specific
// evaluation event's canonical facts (GameResult.favTeam is the established
// canonical field for the graded path - see facts.ts; PregameEventFacts'
// favTeam is the same concept sourced from OddsSnapshot instead - see
// pregame-facts.ts). dogTeam is derived the same way observations.ts
// already does: whichever of home/away isn't favTeam. Deliberately typed to
// the minimal shape both EvaluationEventFacts and the pregame branch's
// locally-built equivalent satisfy structurally, rather than the full
// EvaluationEventFacts type - this function never needed gameResultId/
// externalId/scores, only these three fields. Returns null when the role
// can't be resolved for this event (e.g. no favTeam was ever matched) - the
// caller marks the referencing node unavailable rather than crashing.
function resolveRoleTeamName(role: string, facts: { favTeam: string | null; homeTeam: string; awayTeam: string }): string | null {
  switch (role) {
    case "favorite":
      return facts.favTeam;
    case "underdog":
      return facts.favTeam === null ? null : facts.favTeam === facts.homeTeam ? facts.awayTeam : facts.homeTeam;
    case "home":
      return facts.homeTeam;
    case "away":
      return facts.awayTeam;
    default:
      return null;
  }
}

// options.allObservations (Build Step 5 performance fix) - a caller running
// many evaluation events against the same sport in one process (e.g. a
// historical backtest) can fetch+derive the sport's full observation history
// ONCE via resolveAllGameObservations and pass it here for every event,
// instead of this function re-querying and re-deriving the whole table from
// scratch per event. When supplied, it's filtered per-event through the
// exact same filterObservationsBeforeAsOf boundary resolveGameObservations
// itself uses below - so the temporal-integrity guarantee (an event can
// never see a same-day or later observation) is identical either way; this
// only changes where the data was fetched from, never what a given event is
// allowed to see. Omitted (the default), this behaves exactly as it always
// has - a fresh resolveGameObservations call per event.
export async function runModelDefinition(
  model: ModelDefinition,
  event: EvaluationEvent,
  options?: { allObservations?: GameObservation[] }
): Promise<OrchestrationResult> {
  const context: ValueContext = {};
  const unavailableIds = new Set<string>();
  // DataInput id -> team name, populated whenever a role resolves to a real
  // team, independent of whether that DataInput's own variableId stat
  // resolution succeeds. This is what lets a DataInput be used purely as an
  // Aggregation.entities identity target (see the Decay Delta reproduction),
  // separate from ValueContext's numeric stat values.
  const entityIdentities = new Map<string, string>();
  const conditionResults: Record<string, boolean> = {};
  const bucketResults: Record<string, BucketResult> = {};
  const gridResults: Record<string, GridResult> = {};
  const outcomeResults: Record<string, AggregationOutcome<number | boolean | string>> = {};

  // ---- Resolve this event's own facts - graded (GameResult) or pregame
  // (OddsSnapshot), completely unchanged for the graded path. Both branches
  // produce the same minimal { sportKey, homeTeam, awayTeam, favTeam } shape
  // resolveRoleTeamName/resolveGameObservations/resolveVariable actually
  // need below - neither branch's own richer type (EvaluationEventFacts /
  // PregameEventFacts) is widened or modified to make this work. ----
  let sportKey: string;
  let roleFacts: { favTeam: string | null; homeTeam: string; awayTeam: string };

  if ("gameResultId" in event) {
    const facts = await getEvaluationEventFacts(event.gameResultId);
    if (!facts) {
      throw new Error(`runModelDefinition: no GameResult found for gameResultId "${event.gameResultId}".`);
    }
    sportKey = facts.sportKey;
    roleFacts = { favTeam: facts.favTeam, homeTeam: facts.homeTeam, awayTeam: facts.awayTeam };
  } else {
    const pregame = await getPregameEventFacts(event.sportKey, event.homeTeam, event.awayTeam);
    if (!pregame) {
      throw new Error(
        `runModelDefinition: no OddsSnapshot found for "${event.awayTeam} @ ${event.homeTeam}" (sportKey "${event.sportKey}") - no pregame odds cached yet today.`
      );
    }
    sportKey = event.sportKey;
    roleFacts = { favTeam: pregame.favTeam, homeTeam: event.homeTeam, awayTeam: event.awayTeam };
  }

  // Fetched once for the whole run (asOf/sportKey are fixed for this
  // evaluation event) and reused by every AggregationCalculation, rather
  // than one resolveGameObservations() call per calculation. If the caller
  // supplied a precomputed full history (see options.allObservations above),
  // reuse it via the same filter boundary instead of hitting the database
  // again for this event.
  const observations: GameObservation[] = options?.allObservations
    ? filterObservationsBeforeAsOf(options.allObservations, event.asOf)
    : await resolveGameObservations(sportKey, event.asOf);

  // ---- Step 1: resolve every DataInput ----
  for (const input of model.dataInputs) {
    const teamName = resolveRoleTeamName(input.entity.role, roleFacts);
    if (teamName !== null) entityIdentities.set(input.id, teamName);

    if (teamName === null) {
      unavailableIds.add(input.id);
      continue;
    }
    if (input.entity.type !== "team") {
      // No DATA-layer path today from an evaluation event to a pitcher (or
      // any other non-team entity) identity - GameStarters was removed in
      // the model-builder cleanup and never replaced (see run-diff-era.ts's
      // fixture comment for the full explanation). A DataInput of this
      // shape can still serve as an entities-map identity target (handled
      // above via entityIdentities), but its own stat can't be resolved.
      unavailableIds.add(input.id);
      continue;
    }
    const result = await resolveVariable(input.variableId, { type: "team", teamName }, event.asOf, { sportKey });
    if (result.found) {
      context[input.id] = result.value as number;
    } else {
      unavailableIds.add(input.id);
    }
  }

  // ---- Step 2: walk calculations[] in document order ----
  for (const calc of model.calculations) {
    if ("expression" in calc) {
      const refIds = collectExpressionRefIds(calc.expression);
      if (anyUnavailable(refIds, unavailableIds)) {
        unavailableIds.add(calc.id);
        continue;
      }
      context[calc.id] = evaluateExpression(calc.expression, context);
      continue;
    }
    // AggregationCalculation
    const aggregation: Aggregation = calc.aggregation;
    const entityRefIds = Object.values(aggregation.entities).map((e) => e.ref);
    // Deliberately checked against entityIdentities, NOT unavailableIds - an
    // entities-map DataInput's own variableId/stat resolution is irrelevant
    // here (see the DataInput resolution loop above: entityIdentities is
    // populated whenever a role resolves to a real team, independent of
    // whether that DataInput's own resolveVariable call succeeds). Checking
    // unavailableIds here instead would wrongly block an aggregation just
    // because the DataInput it borrows identity from happened to have an
    // unrelated, unresolvable stat at this asOf.
    if (entityRefIds.some((id) => !entityIdentities.has(id))) {
      unavailableIds.add(calc.id);
      continue;
    }
    // Entity resolution currently only covers what GameResult/
    // getEvaluationEventFacts exposes directly (favorite/underdog team for a
    // given game). There is no general "resolve today's entity of type X"
    // mechanism yet - e.g. a pitcher-scoped model has no path from "today's
    // game" to "today's probable starter," even though the DATA layer's
    // resolver can fetch pitcher-scoped variables once given a specific
    // pitcher id (proven in Build Step 2). This is why Test Model 2's
    // fixture uses a team-scoped variable (team_era) instead of the original
    // pitcher-scoped pitcher_era - not a design choice, a known gap.
    // Building general entity resolution for non-team entity types is
    // future work.
    const entityValues: Record<string, string> = {};
    for (const [name, ref] of Object.entries(aggregation.entities)) {
      entityValues[name] = entityIdentities.get(ref.ref)!;
    }
    const weighting = model.weighting.find((w) => w.id === aggregation.weightingRef);
    if (!weighting) {
      // Should be impossible - the validator already rejects a dangling
      // weightingRef at the schema level. Fail loudly if a 3c orchestration
      // bug ever gets here anyway, same "shouldn't happen, but don't
      // silently produce a wrong number" principle as 3a's dangling-ref
      // check.
      throw new Error(`runModelDefinition: calculation "${calc.id}" references unknown weighting id "${aggregation.weightingRef}".`);
    }

    const filter = (obs: GameObservation): boolean => {
      try {
        const v = evaluateObservationExpression(aggregation.select, obs, entityValues);
        if (typeof v !== "boolean") {
          throw new Error(`calculation "${calc.id}": select must evaluate to boolean, got ${JSON.stringify(v)}.`);
        }
        return v;
      } catch (e) {
        if (e instanceof ObservationFieldUnavailable) return false;
        throw e;
      }
    };
    const valueOf = (obs: GameObservation): boolean | number => {
      const v = evaluateObservationExpression(aggregation.value, obs, entityValues);
      if (typeof v !== "boolean" && typeof v !== "number") {
        throw new Error(`calculation "${calc.id}": value must evaluate to boolean or number, got ${JSON.stringify(v)}.`);
      }
      return v;
    };

    const result = computeWeightedRate(observations, event.asOf, weighting, filter, valueOf);
    if (result.found) {
      // Only result.rate ever crosses into ValueContext - numerator/
      // denominator/weightedTotal are 3b's own internal accumulation
      // details, not model-expression-layer values.
      context[calc.id] = result.rate as number;
    } else {
      unavailableIds.add(calc.id);
    }
  }

  // ---- Step 3: derivedValues[], same pattern as ExpressionCalculation ----
  for (const dv of model.derivedValues) {
    const refIds = collectExpressionRefIds(dv.expression);
    if (anyUnavailable(refIds, unavailableIds)) {
      unavailableIds.add(dv.id);
      continue;
    }
    context[dv.id] = evaluateExpression(dv.expression, context);
  }

  // ---- Step 4: conditions[] ----
  for (const cond of model.conditions) {
    evaluateConditionNode(cond, context, unavailableIds, conditionResults);
  }

  // ---- Step 5: buckets[] ----
  for (const bucket of model.buckets) {
    const refIds = [bucket.input.ref];
    if (anyUnavailable(refIds, unavailableIds)) {
      unavailableIds.add(bucket.id);
      bucketResults[bucket.id] = { ruleId: null, found: false };
      continue;
    }
    const value = context[bucket.input.ref];
    if (typeof value !== "number") {
      throw new Error(`runModelDefinition: bucket "${bucket.id}" input "${bucket.input.ref}" is not a number.`);
    }
    const matched = bucket.rules.find((rule) => bucketRuleMatches(rule.when, value));
    bucketResults[bucket.id] = { ruleId: matched?.id ?? null, found: true };
  }

  // ---- Step 6: grids[] ----
  for (const grid of model.grids) {
    const axisBucketIds = grid.axes.map((a) => a.source.ref);
    if (anyUnavailable(axisBucketIds, unavailableIds)) {
      unavailableIds.add(grid.id);
      gridResults[grid.id] = { cell: [], found: false };
      continue;
    }
    const cell = axisBucketIds.map((bucketId) => bucketResults[bucketId]?.ruleId ?? null);
    gridResults[grid.id] = { cell, found: true };
  }

  // ---- Step 7: outcomes[] ----
  for (const outcome of model.outcomes) {
    const refIds = collectExpressionRefIds(outcome.expression);
    if (anyUnavailable(refIds, unavailableIds)) {
      unavailableIds.add(outcome.id);
      outcomeResults[outcome.id] = { found: false };
      continue;
    }
    const value = evaluateExpression(outcome.expression, context);
    outcomeResults[outcome.id] = { found: true, value };
  }

  return {
    context,
    unavailableIds,
    conditions: Object.fromEntries(
      model.conditions.map((c): [string, AggregationOutcome<boolean>] => [
        c.id,
        unavailableIds.has(c.id) ? { found: false } : { found: true, value: conditionResults[c.id] },
      ])
    ),
    buckets: bucketResults,
    grids: gridResults,
    outcomes: outcomeResults,
  };
}

function evaluateConditionNode(
  cond: Condition,
  context: ValueContext,
  unavailableIds: Set<string>,
  conditionResults: Record<string, boolean>
): void {
  if ("when" in cond) {
    const refIds = collectConditionWhenRefIds(cond.when);
    if (anyUnavailable(refIds, unavailableIds)) {
      unavailableIds.add(cond.id);
      return;
    }
    conditionResults[cond.id] = evaluateComparison(cond.when, context);
    return;
  }
  const isAll = "all" in cond;
  const refs = isAll ? cond.all : cond.any;
  const refIds = refs.map((r) => r.ref);
  if (anyUnavailable(refIds, unavailableIds)) {
    unavailableIds.add(cond.id);
    return;
  }
  const values = refIds.map((id) => conditionResults[id]);
  conditionResults[cond.id] = isAll ? values.every(Boolean) : values.some(Boolean);
}

// range is inclusive on BOTH ends (value >= min && value <= max) - not an
// arbitrary choice. Both fixtures' bucket rules pair a range with an
// adjacent lt/gt sharing the same boundary number (e.g. lt:0 / range[0,10] /
// gt:10) - an exclusive upper bound leaves the shared boundary value (e.g.
// exactly 10) matching NO rule at all, a gap neither Build Step 1's
// validator nor its own examples call out explicitly. Inclusive-both closes
// it without creating a double-match at the shared boundary either, since
// the adjacent lt/gt is strict (<, >) rather than <=/>=.
function bucketRuleMatches(when: BucketRuleWhen, value: number): boolean {
  if ("lt" in when) return value < when.lt;
  if ("lte" in when) return value <= when.lte;
  if ("gt" in when) return value > when.gt;
  if ("gte" in when) return value >= when.gte;
  return value >= when.range.min && value <= when.range.max;
}
