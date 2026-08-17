// Boundary-ownership proof for the Decay Delta 10-tier bucket scheme
// (lib/model-engine/fixtures/decay-delta.ts's bucket_decay_delta rules,
// added when the original 3-bucket placeholder was replaced). Confirms,
// through the real shared orchestration path (runModelDefinition's
// bucket-matching, unmodified), that each of the boundary values the tier
// scheme was built around - 0, +-10, +-20, +-30, +-40 - lands in EXACTLY
// one rule, never zero, never two. Uses the fixture's own rules array
// verbatim (decayDeltaModel.buckets[0].rules), not a re-typed copy, so this
// can never silently drift from what the fixture actually ships.
// Run with: npx tsx src/server/data/model-engine/decay-delta-bucket-boundary-test.ts
import { prisma } from "@/lib/prisma";
import { runModelDefinition } from "./orchestrate";
import { decayDeltaModel } from "@/lib/model-engine/fixtures/decay-delta";
import type { ModelDefinition } from "@/lib/model-engine/types";

let failures = 0;

function buildProbeModel(testValue: number): ModelDefinition {
  return {
    schemaVersion: 1,
    modelId: "bucket-boundary-probe",
    name: "Bucket boundary probe",
    sport: "baseball_mlb",
    dataInputs: [],
    calculations: [],
    weighting: [],
    derivedValues: [{ id: "dv_test", expression: { literal: testValue } }],
    conditions: [],
    buckets: [{ id: "bucket_test", input: { ref: "dv_test" }, rules: decayDeltaModel.buckets[0].rules }],
    grids: [],
    outcomes: [],
    metadata: {
      description: "Synthetic probe model - forces dv_test to an exact boundary value and reads which real decay-delta bucket rule it matches.",
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
      createdBy: "bucket-boundary-test",
      tags: [],
      ownerRef: null,
      sourceRefs: [],
    },
  };
}

async function main() {
  // Any real GameResult row works - dataInputs is empty, so no entity/stat
  // resolution ever happens; this id is only needed to satisfy
  // getEvaluationEventFacts' non-null lookup. Same real row already used by
  // orchestrate-acceptance-test.ts's Part A.
  const gameResultId = "cmsqu2pbr0031j52lw78k55cg";
  const game = await prisma.gameResult.findUnique({ where: { id: gameResultId } });
  if (!game) {
    console.log("FAIL: prerequisite real GameResult row not found - cannot run boundary probe.");
    process.exit(1);
  }

  const boundaryValues = [0, 10, -10, 20, -20, 30, -30, 40, -40];

  for (const value of boundaryValues) {
    const model = buildProbeModel(value);
    const result = await runModelDefinition(model, { gameResultId, asOf: game.gameDate });
    const bucket = result.buckets["bucket_test"];

    // Independently recount matches across every rule for this same value,
    // walking the fixture's own rules verbatim, so a "found exactly one"
    // claim is actually checked - not just trusted because bucketRuleMatches
    // (which only ever returns the FIRST match via Array.find) said so.
    const matchCountByRecomputation = decayDeltaModel.buckets[0].rules.filter((rule) => {
      const w = rule.when;
      if ("lt" in w) return value < w.lt;
      if ("lte" in w) return value <= w.lte;
      if ("gt" in w) return value > w.gt;
      if ("gte" in w) return value >= w.gte;
      return value >= w.range.min && value <= w.range.max;
    }).length;

    const pass = bucket.found && bucket.ruleId !== null && matchCountByRecomputation === 1;
    console.log(
      `${pass ? "PASS" : "FAIL"}: delta=${value} -> ruleId=${bucket.ruleId} (independently recomputed match count=${matchCountByRecomputation})`
    );
    if (!pass) failures++;
  }

  if (failures > 0) {
    console.log(`\n${failures} FAILURE(S).`);
    process.exit(1);
  }
  console.log("\nALL CHECKS PASSED - every boundary value matches exactly one bucket rule.");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
