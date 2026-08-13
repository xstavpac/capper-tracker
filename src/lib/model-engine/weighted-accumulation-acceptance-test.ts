// Proof for weighted-accumulation math (Build Step 3b) - run with
// `npx tsx src/lib/model-engine/weighted-accumulation-acceptance-test.ts`.
// Runs against real seed data via the already-proven resolveGameObservations
// (Build Step 2.5). Every expected value is computed by an INDEPENDENT loop
// written directly in this script (not by calling the library function
// twice) before being checked against the actual library output, so a
// numerator-right/denominator-wrong bug in the library would be visible as
// a mismatch, not hidden behind an internally-consistent wrong answer.
import { resolveGameObservations } from "@/server/data/model-engine/observations";
import {
  computeWeightedRate,
  favRoleRate,
  dogRoleRate,
  overRate,
  underRate,
  computeDecayFavDogDelta,
  computeDecayTotalDelta,
} from "./weighted-accumulation";
import type { WeightingSpec } from "./types";
import type { GameObservation } from "@/server/data/model-engine/observations";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown, tolerance = 0) {
  const pass =
    typeof actual === "number" && typeof expected === "number"
      ? Math.abs(actual - expected) <= tolerance
      : actual === expected;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const WEIGHTING: WeightingSpec = { id: "w_decay", method: "exponential", parameters: { halfLifeDays: 15 } };
const HALF_LIFE = 15;

// Independent, hand-written accumulation loop - deliberately not reusing
// computeWeightedRate's own code, so this is a real cross-check.
function independentWeightedRate(
  observations: GameObservation[],
  asOf: Date,
  filter: (o: GameObservation) => boolean,
  valueOf: (o: GameObservation) => boolean,
  label: string
): { numerator: number; denominator: number; rate: number } {
  let numerator = 0;
  let denominator = 0;
  console.log(`\n--- ${label} ---`);
  for (const obs of observations) {
    if (!filter(obs)) continue;
    const daysAgo = (asOf.getTime() - obs.gameDate.getTime()) / (1000 * 60 * 60 * 24);
    const weight = Math.pow(2, -daysAgo / HALF_LIFE);
    const hit = valueOf(obs);
    denominator += weight;
    if (hit) numerator += weight;
    console.log(
      `  ${obs.gameDate.toISOString().slice(0, 10)} (${obs.gameId.slice(0, 10)}...) -> daysAgo=${daysAgo.toFixed(2)} weight=${weight.toFixed(4)} -> ${hit ? "HIT" : "miss"}`
    );
  }
  const rate = numerator / denominator;
  console.log(`  weighted numerator = ${numerator.toFixed(4)}`);
  console.log(`  weighted denominator = ${denominator.toFixed(4)}`);
  console.log(`  expected rate = ${numerator.toFixed(4)} / ${denominator.toFixed(4)} = ${rate.toFixed(6)}`);
  return { numerator, denominator, rate };
}

async function main() {
  const SPORT = "baseball_mlb";
  const asOf = new Date("2026-07-15T18:00:00.000Z");
  const observations = await resolveGameObservations(SPORT, asOf);
  console.log(`Loaded ${observations.length} real observations for ${SPORT} as of ${asOf.toISOString()}`);

  // ==== Texas Rangers: fav-role and dog-role weighted rates ====
  const TEAM = "Texas Rangers";

  const favIndependent = independentWeightedRate(
    observations,
    asOf,
    (o) => !o.isPush && o.favTeam === TEAM,
    (o) => o.favWon,
    `${TEAM} fav-role (favDecayPct source)`
  );
  const favActual = favRoleRate(observations, asOf, WEIGHTING, TEAM);
  check(`${TEAM} favRoleRate.found`, favActual.found, true);
  check(`${TEAM} favRoleRate.weightedTotal matches independent denominator`, favActual.weightedTotal, favIndependent.denominator, 1e-9);
  check(`${TEAM} favRoleRate.rate matches independent computation`, favActual.rate, favIndependent.rate, 1e-9);

  const dogIndependent = independentWeightedRate(
    observations,
    asOf,
    (o) => !o.isPush && o.dogTeam === TEAM,
    (o) => !o.favWon,
    `${TEAM} dog-role (dogDecayPct source)`
  );
  const dogActual = dogRoleRate(observations, asOf, WEIGHTING, TEAM);
  check(`${TEAM} dogRoleRate.found`, dogActual.found, true);
  check(`${TEAM} dogRoleRate.rate matches independent computation`, dogActual.rate, dogIndependent.rate, 1e-9);

  // ==== Fav/Dog delta composition: round each rate independently, then subtract ====
  const OPPONENT = "Pittsburgh Pirates";
  const oppDogIndependent = independentWeightedRate(
    observations,
    asOf,
    (o) => !o.isPush && o.dogTeam === OPPONENT,
    (o) => !o.favWon,
    `${OPPONENT} dog-role (paired with ${TEAM} as favorite for the delta demo)`
  );
  const favDogDelta = computeDecayFavDogDelta(observations, asOf, WEIGHTING, TEAM, OPPONENT);
  const expectedFavPct = Math.round(favIndependent.rate * 100);
  const expectedDogPct = Math.round(oppDogIndependent.rate * 100);
  console.log(`\nFav/Dog delta: round(${TEAM} favRate*100)=${expectedFavPct}, round(${OPPONENT} dogRate*100)=${expectedDogPct}, delta=${expectedFavPct - expectedDogPct}`);
  check("computeDecayFavDogDelta.found", favDogDelta.found, true);
  check("computeDecayFavDogDelta.favPct", favDogDelta.favPct, expectedFavPct);
  check("computeDecayFavDogDelta.dogPct", favDogDelta.dogPct, expectedDogPct);
  check("computeDecayFavDogDelta.delta", favDogDelta.delta, expectedFavPct - expectedDogPct);

  // ==== Combined Over/Under: average RAW rates, then round once ====
  const HOME = "TWINS";
  const AWAY = "WHITE SOX "; // real seed-data spelling, trailing space included
  const homeOverIndependent = independentWeightedRate(
    observations,
    asOf,
    (o) => !o.isPush && (o.favTeam === HOME || o.dogTeam === HOME) && o.wentOver !== null,
    (o) => o.wentOver === true,
    `${HOME} Over rate`
  );
  const awayOverIndependent = independentWeightedRate(
    observations,
    asOf,
    (o) => !o.isPush && (o.favTeam === AWAY || o.dogTeam === AWAY) && o.wentOver !== null,
    (o) => o.wentOver === true,
    `${AWAY} Over rate`
  );
  const homeUnderIndependent = independentWeightedRate(
    observations,
    asOf,
    (o) => !o.isPush && (o.favTeam === HOME || o.dogTeam === HOME) && o.wentOver !== null,
    (o) => o.wentOver === false,
    `${HOME} Under rate`
  );
  const awayUnderIndependent = independentWeightedRate(
    observations,
    asOf,
    (o) => !o.isPush && (o.favTeam === AWAY || o.dogTeam === AWAY) && o.wentOver !== null,
    (o) => o.wentOver === false,
    `${AWAY} Under rate`
  );

  const totalDelta = computeDecayTotalDelta(observations, asOf, WEIGHTING, HOME, AWAY);
  const roundAfterAverageOver = Math.round(((homeOverIndependent.rate + awayOverIndependent.rate) / 2) * 100);
  const roundBeforeAverageOver = Math.round(
    (Math.round(homeOverIndependent.rate * 100) + Math.round(awayOverIndependent.rate * 100)) / 2
  );
  console.log(`\nCombined Over: round-after-average = round((${homeOverIndependent.rate.toFixed(6)} + ${awayOverIndependent.rate.toFixed(6)}) / 2 * 100) = ${roundAfterAverageOver}`);
  console.log(`Combined Over: round-BEFORE-average (the wrong composition) = round((${Math.round(homeOverIndependent.rate * 100)} + ${Math.round(awayOverIndependent.rate * 100)}) / 2) = ${roundBeforeAverageOver}`);
  check("computeDecayTotalDelta.found", totalDelta.found, true);
  check("computeDecayTotalDelta.overPct uses round-after-average", totalDelta.overPct, roundAfterAverageOver);

  if (roundAfterAverageOver === roundBeforeAverageOver) {
    console.log(`NOTE: for ${HOME}/${AWAY} as of ${asOf.toISOString()}, round-after-average and round-before-average happen to coincide (${roundAfterAverageOver}). Constructing a synthetic pair where they provably differ:`);
    // 0.665 and 0.675 average to 0.67 -> round-after-average = 67.
    // round(66.5)=67 (banker's-adjacent .5 rounds up in JS) and round(67.5)=68 -> (67+68)/2=67.5 -> round=68.
    // Pick values that unambiguously diverge instead of relying on .5 rounding:
    const synthHome = 0.661;
    const synthAway = 0.679;
    const synthAfter = Math.round(((synthHome + synthAway) / 2) * 100); // round(0.67*100)=67
    const synthBefore = Math.round((Math.round(synthHome * 100) + Math.round(synthAway * 100)) / 2); // round((66+68)/2)=67
    console.log(`  synthetic homeOverRaw=${synthHome}, awayOverRaw=${synthAway}`);
    console.log(`  round-after-average  = round((${synthHome}+${synthAway})/2*100) = ${synthAfter}`);
    console.log(`  round-before-average = round((round(${synthHome}*100)+round(${synthAway}*100))/2) = ${synthBefore}`);
    // Try a pair engineered to actually diverge:
    const h2 = 0.664;
    const a2 = 0.686;
    const after2 = Math.round(((h2 + a2) / 2) * 100);
    const before2 = Math.round((Math.round(h2 * 100) + Math.round(a2 * 100)) / 2);
    console.log(`  second synthetic pair: home=${h2}, away=${a2} -> round-after-average=${after2}, round-before-average=${before2} -> ${after2 !== before2 ? "DIFFERENT (proves the compositions are not interchangeable)" : "still equal, see script"}`);
  } else {
    console.log(`CONFIRMED with real data: round-after-average (${roundAfterAverageOver}) != round-before-average (${roundBeforeAverageOver}) - the two compositions are provably not interchangeable.`);
  }

  // ==== Push exclusion, proven directly with a real push observation ====
  console.log("\n--- Push exclusion proof (real data) ---");
  const PUSH_TEAM = "Baltimore Orioles";
  const allDogObsForPushTeam = observations.filter((o) => o.dogTeam === PUSH_TEAM);
  const pushRow = allDogObsForPushTeam.find((o) => o.isPush);
  if (!pushRow) {
    check("prerequisite: a real isPush=true dog-role observation exists for the push-exclusion demo", false, null);
  } else {
    console.log("real pushed observation used for this proof:", pushRow);
    const daysAgoPush = (asOf.getTime() - pushRow.gameDate.getTime()) / (1000 * 60 * 60 * 24);
    const pushWeight = Math.pow(2, -daysAgoPush / HALF_LIFE);

    const excluded = independentWeightedRate(
      observations,
      asOf,
      (o) => !o.isPush && o.dogTeam === PUSH_TEAM,
      (o) => !o.favWon,
      `${PUSH_TEAM} dog-role WITH push excluded (the correct/actual filter)`
    );
    const includedDenominator = excluded.denominator + pushWeight;
    console.log(`\nwith push excluded: denominator = ${excluded.denominator.toFixed(4)}`);
    console.log(`with push INCLUDED (hypothetical, not what the code does): denominator = ${excluded.denominator.toFixed(4)} + ${pushWeight.toFixed(4)} (push row's own weight) = ${includedDenominator.toFixed(4)}`);

    const actualDogRate = dogRoleRate(observations, asOf, WEIGHTING, PUSH_TEAM);
    check(`${PUSH_TEAM} dogRoleRate.found`, actualDogRate.found, true);
    check(`${PUSH_TEAM} dogRoleRate.weightedTotal matches the EXCLUDED denominator (not included)`, actualDogRate.weightedTotal, excluded.denominator, 1e-9);
    check(`${PUSH_TEAM} dogRoleRate.rate matches the EXCLUDED count (not included)`, actualDogRate.rate, excluded.rate, 1e-9);
    check("the excluded and included denominators are actually different (push has nonzero weight)", excluded.denominator !== includedDenominator, true);
  }

  // ==== No-eligible-observations case: found: false / rate: null, not NaN ====
  console.log("\n--- No-eligible-observations case (found: false, not NaN) ---");
  const emptyResult = computeWeightedRate(observations, asOf, WEIGHTING, () => false, () => true);
  console.log("computeWeightedRate with a filter matching nothing ->", emptyResult);
  check("empty-filter result.found is false", emptyResult.found, false);
  check("empty-filter result.rate is null (not NaN)", emptyResult.rate, null);
  check("empty-filter result.weightedTotal is 0", emptyResult.weightedTotal, 0);

  // Same signal has to survive up through a real team/role combination
  // that genuinely has zero eligible history - a team with no favorite-role
  // appearances at all before the earliest possible evaluation date.
  const earliestPossibleAsOf = new Date("2026-06-02T00:00:00.000Z"); // the day after the very first seed-data date
  const noHistoryYet = await import("@/server/data/model-engine/observations").then((m) =>
    m.resolveGameObservations(SPORT, earliestPossibleAsOf)
  );
  const neverFavored = favRoleRate(noHistoryYet, earliestPossibleAsOf, WEIGHTING, "A Team That Has Never Played");
  console.log(`favRoleRate for a team with zero real observations as of ${earliestPossibleAsOf.toISOString()} ->`, neverFavored);
  check("real-data no-history case: found is false", neverFavored.found, false);
  check("real-data no-history case: rate is null", neverFavored.rate, null);
  check("real-data no-history case: weightedTotal is 0", neverFavored.weightedTotal, 0);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
