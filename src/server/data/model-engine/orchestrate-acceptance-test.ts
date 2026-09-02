// Proof for Model Definition orchestration (Build Step 3c) - run with
// `npx tsx src/server/data/model-engine/orchestrate-acceptance-test.ts`.
// Real seed data throughout. Exits non-zero if any assertion fails.
import { prisma } from "@/lib/prisma";
import { runModelDefinition } from "./orchestrate";
import { decayDeltaModel } from "@/lib/model-engine/fixtures/decay-delta";
import { runDiffEraModel } from "@/lib/model-engine/fixtures/run-diff-era";
import { favRoleRate, dogRoleRate, computeDecayFavDogDelta } from "@/lib/model-engine/weighted-accumulation";
import { resolveGameObservations } from "./observations";
import type { ModelDefinition, WeightingSpec } from "@/lib/model-engine/types";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown, tolerance = 0) {
  const pass =
    typeof actual === "number" && typeof expected === "number" ? Math.abs(actual - expected) <= tolerance : actual === expected;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

async function main() {
  // ==========================================================================
  // PART A - Decay Delta, end-to-end, against a real historical matchup
  // ==========================================================================
  console.log("\n########## PART A: Decay Delta end-to-end reproduction ##########");

  const decayEvent = await prisma.gameResult.findUnique({ where: { id: "cmsqu2pbr0031j52lw78k55cg" } });
  if (!decayEvent) {
    // A bare `return` here would skip the `process.exit(1)` at the end of
    // main(), so a missing prerequisite row printed FAIL but exited 0 (the
    // runner reported PASS). Exit non-zero immediately instead.
    check("prerequisite: the real Rangers/Braves GameResult row exists", false, null);
    await prisma.$disconnect();
    process.exit(1);
  }
  console.log("\nreal evaluation event (GameResult row):", decayEvent);
  const decayAsOf = new Date("2026-07-19T18:00:00.000Z"); // same Eastern day as the game itself
  const favTeam = decayEvent.favTeam!;
  const dogTeam = favTeam === decayEvent.homeTeam ? decayEvent.awayTeam : decayEvent.homeTeam;
  console.log(`favTeam=${favTeam}, dogTeam=${dogTeam}, asOf=${decayAsOf.toISOString()}`);

  const orchestrated = await runModelDefinition(decayDeltaModel, { gameResultId: decayEvent.id, asOf: decayAsOf });

  // Independently, via 3b's own already-proven direct-call functions -
  // exactly the same inputs, computed through a completely different code
  // path (no orchestration involved at all).
  const weighting: WeightingSpec = { id: "w_recency", method: "exponential", parameters: { halfLifeDays: 15 } };
  const observations = await resolveGameObservations(decayEvent.sportKey, decayAsOf);
  const directFav = favRoleRate(observations, decayAsOf, weighting, favTeam);
  const directDog = dogRoleRate(observations, decayAsOf, weighting, dogTeam);
  const directDelta = computeDecayFavDogDelta(observations, decayAsOf, weighting, favTeam, dogTeam);

  console.log("\n--- Intermediate value comparison: orchestration vs. 3b direct-call ---");
  check("calc_fav_weighted (raw fav rate)", orchestrated.context["calc_fav_weighted"], directFav.rate, 1e-9);
  check("calc_dog_weighted (raw dog rate)", orchestrated.context["calc_dog_weighted"], directDog.rate, 1e-9);
  check("calc_fav_pct (rounded fav %)", orchestrated.context["calc_fav_pct"], directDelta.favPct);
  check("calc_dog_pct (rounded dog %)", orchestrated.context["calc_dog_pct"], directDelta.dogPct);
  check("dv_decay_delta (final delta)", orchestrated.context["dv_decay_delta"], directDelta.delta);
  check("outcome_edge.found", orchestrated.outcomes["outcome_edge"].found, true);
  if (orchestrated.outcomes["outcome_edge"].found) {
    check("outcome_edge.value matches dv_decay_delta", orchestrated.outcomes["outcome_edge"].value, directDelta.delta);
  }
  check("bucket_decay_delta classified (found)", orchestrated.buckets["bucket_decay_delta"].found, true);
  console.log("bucket_decay_delta matched rule:", orchestrated.buckets["bucket_decay_delta"].ruleId);
  console.log("unavailableIds:", [...orchestrated.unavailableIds]);
  // di_fav_rate/di_dog_rate's OWN variableId (tendency_fav_win_pct/
  // tendency_dog_win_pct, resolved via TeamTendencySnapshot) legitimately
  // has no data this far back (July) - that snapshot table only starts
  // Aug 10. Expected and harmless: nothing in this model references either
  // DataInput's resolved NUMBER, only their entity.role identity (used via
  // entityIdentities, resolved independently of this) - already proven by
  // every downstream value above matching 3b's direct-call output exactly.
  check(
    "unavailableIds contains exactly the two harmless, unused DataInput stat resolutions",
    JSON.stringify([...orchestrated.unavailableIds].sort()),
    JSON.stringify(["di_dog_rate", "di_fav_rate"])
  );

  // ==========================================================================
  // PART B - Test Model 2, actually executed (not just validated)
  // ==========================================================================
  console.log("\n########## PART B: Test Model 2 (run-diff-era) actually executed ##########");

  const model2Event = await prisma.gameResult.findUnique({ where: { id: "cmspnjxg7000d5g6fwr1mb075" } });
  if (!model2Event) {
    check("prerequisite: the real Giants/Astros GameResult row exists", false, null);
  } else {
    console.log("\nreal evaluation event (GameResult row):", model2Event);
    const model2AsOf = new Date("2026-08-13T18:00:00.000Z"); // within the live TeamStatSnapshot window
    const result2 = await runModelDefinition(runDiffEraModel, { gameResultId: model2Event.id, asOf: model2AsOf });

    console.log("\ndi_run_diff (context):", result2.context["di_run_diff"]);
    console.log("di_opp_era (context):", result2.context["di_opp_era"]);
    console.log("calc_scaled_diff:", result2.context["calc_scaled_diff"]);
    console.log("calc_era_penalty:", result2.context["calc_era_penalty"]);
    console.log("calc_combined:", result2.context["calc_combined"]);
    console.log("calc_normalized:", result2.context["calc_normalized"]);
    console.log("dv_composite_score:", result2.context["dv_composite_score"]);
    console.log("cond_diff_positive:", result2.conditions["cond_diff_positive"]);
    console.log("cond_era_low:", result2.conditions["cond_era_low"]);
    console.log("cond_group (AND):", result2.conditions["cond_group"]);
    console.log("bucket_run_diff:", result2.buckets["bucket_run_diff"]);
    console.log("bucket_era:", result2.buckets["bucket_era"]);
    console.log("grid_main:", result2.grids["grid_main"]);
    console.log("outcome_score:", result2.outcomes["outcome_score"]);
    console.log("unavailableIds:", [...result2.unavailableIds]);

    check("di_run_diff resolved (no weighting model - DATA layer resolved directly)", typeof result2.context["di_run_diff"], "number");
    check("di_opp_era resolved", typeof result2.context["di_opp_era"], "number");
    check("dv_composite_score is a real, finite number", Number.isFinite(result2.context["dv_composite_score"] as number), true);
    check("outcome_score.found (Test Model 2 produces a real result)", result2.outcomes["outcome_score"].found, true);
    if (result2.outcomes["outcome_score"].found) {
      check(
        "outcome_score.value matches dv_composite_score",
        result2.outcomes["outcome_score"].value,
        result2.context["dv_composite_score"]
      );
    }
    check("grid_main classified (found) - both grid axes resolved", result2.grids["grid_main"].found, true);
    check("cond_group is a real boolean, not unavailable", result2.conditions["cond_group"].found, true);
    check("no weighting was used (weighting: [] in this model)", runDiffEraModel.weighting.length, 0);
  }

  // ==========================================================================
  // PART C - unavailableIds propagation, proven directly
  // ==========================================================================
  console.log("\n########## PART C: unavailableIds propagation ##########");

  // A minimal, purpose-built model: one AggregationCalculation guaranteed to
  // return found: false (asOf before ANY seed history exists), a full
  // dependent chain off it (rounding -> derivedValue -> bucket -> outcome),
  // AND one completely INDEPENDENT ExpressionCalculation/outcome with zero
  // reference to the missing aggregation, to prove the unrelated one still
  // resolves normally in the very same run.
  const propagationModel: ModelDefinition = {
    schemaVersion: 1,
    modelId: "propagation-proof-v1",
    name: "Propagation proof",
    sport: "baseball_mlb",
    dataInputs: [
      { id: "di_fav", variableId: "tendency_fav_win_pct", entity: { type: "team", role: "favorite" }, params: {}, sourceRef: null },
    ],
    calculations: [
      {
        id: "calc_missing_history",
        aggregation: {
          source: "gameObservations",
          entities: { team: { ref: "di_fav" } },
          select: {
            all: [
              { op: "equal", left: { observationField: "isPush" }, right: { literal: false } },
              { op: "equal", left: { observationField: "favTeam" }, right: { entityRef: "team" } },
            ],
          },
          value: { observationField: "favWon" },
          weightingRef: "w_test",
          method: "weightedAverage",
        },
      },
      {
        id: "calc_dependent_rounded",
        expression: { function: "round", args: [{ ref: "calc_missing_history" }, { literal: 2 }] },
      },
      // Completely independent of calc_missing_history - a plain literal.
      { id: "calc_independent", expression: { literal: 42 } },
    ],
    weighting: [{ id: "w_test", method: "exponential", parameters: { halfLifeDays: 15 } }],
    derivedValues: [{ id: "dv_dependent", expression: { ref: "calc_dependent_rounded" } }],
    conditions: [],
    buckets: [
      { id: "bucket_dependent", input: { ref: "dv_dependent" }, rules: [{ id: "rule_any", when: { gte: -1000 } }] },
    ],
    grids: [],
    outcomes: [
      { id: "outcome_dependent", type: "numeric", expression: { ref: "dv_dependent" } },
      { id: "outcome_independent", type: "numeric", expression: { op: "add", left: { ref: "calc_independent" }, right: { literal: 8 } } },
    ],
    metadata: {
      description: "Purpose-built for the unavailableIds propagation proof.",
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
      createdBy: "acceptance-test",
      tags: [],
      ownerRef: null,
      sourceRefs: [],
    },
  };

  // Reuse the real Rangers/Braves event, but with an asOf BEFORE the
  // earliest real seed-data date (2026-06-01) - so calc_missing_history has
  // zero eligible observations, guaranteed, against real data (not a
  // fabricated team name).
  const tooEarlyAsOf = new Date("2026-05-01T12:00:00.000Z");
  const propagated = await runModelDefinition(propagationModel, { gameResultId: decayEvent.id, asOf: tooEarlyAsOf });

  console.log("\nunavailableIds:", [...propagated.unavailableIds]);
  console.log("context:", propagated.context);
  console.log("outcomes:", propagated.outcomes);

  check("calc_missing_history is unavailable (found: false at the primitive)", propagated.unavailableIds.has("calc_missing_history"), true);
  check("calc_missing_history has NO value in context", "calc_missing_history" in propagated.context, false);
  check(
    "calc_dependent_rounded propagated to unavailable (direct ref to the missing calc)",
    propagated.unavailableIds.has("calc_dependent_rounded"),
    true
  );
  check("dv_dependent propagated to unavailable", propagated.unavailableIds.has("dv_dependent"), true);
  check("bucket_dependent propagated to unavailable", propagated.unavailableIds.has("bucket_dependent"), true);
  check("bucket_dependent.found is false", propagated.buckets["bucket_dependent"].found, false);
  check("outcome_dependent.found is false", propagated.outcomes["outcome_dependent"].found, false);

  // The unrelated calculation, in the SAME run, is untouched.
  check("calc_independent is NOT marked unavailable", propagated.unavailableIds.has("calc_independent"), false);
  check("calc_independent resolved normally in context", propagated.context["calc_independent"], 42);
  check("outcome_independent.found is true (unrelated to the missing aggregation)", propagated.outcomes["outcome_independent"].found, true);
  if (propagated.outcomes["outcome_independent"].found) {
    check("outcome_independent.value = 42 + 8 = 50", propagated.outcomes["outcome_independent"].value, 50);
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  await prisma.$disconnect();
  if (failures > 0) process.exit(1);
}

main();
