// Weighted-accumulation math for the new model engine (Build Step 3b) -
// operates only on an already-resolved GameObservation[] (Build Step 2.5
// already did the DB work and already enforces the same-day/future
// exclusion boundary; this file never touches Prisma or the DATA layer
// itself, matching 3a's lib/ vs server/data/ split).
//
// Grounded directly in the original Decay Delta source
// (StavsPredictiveAnalytics (70).jsx:260-308, computeDecayGameDelta),
// already traced and cited exactly during the fact-finding pass.
import type { GameObservation } from "@/server/data/model-engine/observations";
import type { WeightingSpec } from "./types";

// Same "no data available" convention as Build Step 2's ResolvedValue
// ({ value, timestamp, found }) - zero eligible observations for a given
// filter (a team early in a season, or rarely favored) is a legitimate,
// expected state, not an error. found: false / rate: null signal that
// explicitly, rather than propagating NaN (0/0) as a valid-looking number
// or throwing (which would treat a normal case as a calculation failure).
// weightedTotal is the denominator - always a real number, 0 when not
// found, useful on its own for diagnostics either way.
export type WeightedRateResult = {
  rate: number | null;
  weightedTotal: number;
  found: boolean;
};

// ── The generic primitive ──────────────────────────────────────────────
// Reusable across any weighting-based calculation, not specific to Decay
// Delta. Knows nothing about favorites/underdogs/pushes - filter and
// valueOf carry all of that. Push exclusion is NOT baked in here; it's
// each caller's own choice, expressed through filter (see the Decay Delta
// reproduction below, where every filter folds in !obs.isPush itself).
export function computeWeightedRate(
  observations: GameObservation[],
  asOf: Date,
  weighting: WeightingSpec,
  filter: (obs: GameObservation) => boolean,
  valueOf: (obs: GameObservation) => boolean
): WeightedRateResult {
  let numerator = 0;
  let denominator = 0;
  for (const obs of observations) {
    if (!filter(obs)) continue;
    // Real-valued, not integer-rounded - matches the original source's
    // formula exactly (daysAgo = (ref - d) / (1000*60*60*24), no rounding).
    const daysAgo = (asOf.getTime() - obs.gameDate.getTime()) / (1000 * 60 * 60 * 24);
    const weight = Math.pow(2, -daysAgo / weighting.parameters.halfLifeDays);
    denominator += weight;
    if (valueOf(obs)) numerator += weight;
  }
  if (denominator === 0) {
    return { rate: null, weightedTotal: 0, found: false };
  }
  return { rate: numerator / denominator, weightedTotal: denominator, found: true };
}

// ── Decay Delta reproduction ───────────────────────────────────────────
// Reproduces favDogMap/ouMap's per-team accumulation exactly. Every filter
// below includes !obs.isPush as part of its own condition - this
// reproduction's choice, not computeWeightedRate's.

export function favRoleRate(
  observations: GameObservation[],
  asOf: Date,
  weighting: WeightingSpec,
  teamName: string
): WeightedRateResult {
  return computeWeightedRate(
    observations,
    asOf,
    weighting,
    (obs) => !obs.isPush && obs.favTeam === teamName,
    (obs) => obs.favWon
  );
}

// The favorite and underdog outcomes are complementary within a single
// game (valueOf is !obs.favWon), even though a specific team's overall
// dog-role rate is computed from an independently-sized sample of games
// where THAT team was the underdog - not derived from any other team's
// favorite-role rate.
export function dogRoleRate(
  observations: GameObservation[],
  asOf: Date,
  weighting: WeightingSpec,
  teamName: string
): WeightedRateResult {
  return computeWeightedRate(
    observations,
    asOf,
    weighting,
    (obs) => !obs.isPush && obs.dogTeam === teamName,
    (obs) => !obs.favWon
  );
}

// Both home and away teams in a game receive the identical wentOver
// observation - not split by role the way Fav/Dog is. obs.wentOver !== null
// is part of the filter (a game with no determinable total line has no
// Over/Under observation for either team), so valueOf below never actually
// sees a null - the `=== true`/`=== false` comparisons are just a safe,
// explicit way to keep TypeScript's boolean-returning contract honest
// without asserting past the type.
export function overRate(
  observations: GameObservation[],
  asOf: Date,
  weighting: WeightingSpec,
  teamName: string
): WeightedRateResult {
  return computeWeightedRate(
    observations,
    asOf,
    weighting,
    (obs) => !obs.isPush && (obs.favTeam === teamName || obs.dogTeam === teamName) && obs.wentOver !== null,
    (obs) => obs.wentOver === true
  );
}

export function underRate(
  observations: GameObservation[],
  asOf: Date,
  weighting: WeightingSpec,
  teamName: string
): WeightedRateResult {
  return computeWeightedRate(
    observations,
    asOf,
    weighting,
    (obs) => !obs.isPush && (obs.favTeam === teamName || obs.dogTeam === teamName) && obs.wentOver !== null,
    (obs) => obs.wentOver === false
  );
}

// ── The two rounding compositions ──────────────────────────────────────
// Deliberately different from each other - see each function's own comment.

export type DecayFavDogDeltaResult = {
  delta: number | null;
  favPct: number | null;
  dogPct: number | null;
  found: boolean;
};

// Fav/Dog: round EACH team's own rate independently, THEN subtract. Same
// found convention as computeWeightedRate itself - if either side has zero
// eligible observations, there's no honest delta to report, so this
// propagates found: false rather than doing arithmetic on a null.
export function computeDecayFavDogDelta(
  observations: GameObservation[],
  asOf: Date,
  weighting: WeightingSpec,
  favTeamName: string,
  dogTeamName: string
): DecayFavDogDeltaResult {
  const fav = favRoleRate(observations, asOf, weighting, favTeamName);
  const dog = dogRoleRate(observations, asOf, weighting, dogTeamName);
  if (fav.rate === null || dog.rate === null) {
    return { delta: null, favPct: null, dogPct: null, found: false };
  }
  const favPct = Math.round(fav.rate * 100);
  const dogPct = Math.round(dog.rate * 100);
  return { delta: favPct - dogPct, favPct, dogPct, found: true };
}

export type DecayTotalDeltaResult = {
  delta: number | null;
  overPct: number | null;
  underPct: number | null;
  found: boolean;
};

// Combined Over/Under: the OPPOSITE order from Fav/Dog above - average the
// two teams' RAW, unrounded rates first, THEN round once. Rounding each
// team's rate before averaging would be a different, incorrect number - not
// done here. This is a deliberate, specified behavior for this step, not a
// claim that it matches every rounding detail of the original prototype's
// own pct() helper (which rounds per-team before its own combinedOverPct
// average, then rounds that average again - a double-rounding artifact this
// step intentionally does not reproduce). Same found convention as
// computeDecayFavDogDelta above - any of the four underlying rates missing
// (zero eligible observations for that team/side) means no honest combined
// percentage can be reported.
export function computeDecayTotalDelta(
  observations: GameObservation[],
  asOf: Date,
  weighting: WeightingSpec,
  homeTeamName: string,
  awayTeamName: string
): DecayTotalDeltaResult {
  const homeOver = overRate(observations, asOf, weighting, homeTeamName);
  const awayOver = overRate(observations, asOf, weighting, awayTeamName);
  const homeUnder = underRate(observations, asOf, weighting, homeTeamName);
  const awayUnder = underRate(observations, asOf, weighting, awayTeamName);
  if (homeOver.rate === null || awayOver.rate === null || homeUnder.rate === null || awayUnder.rate === null) {
    return { delta: null, overPct: null, underPct: null, found: false };
  }
  const overPct = Math.round(((homeOver.rate + awayOver.rate) / 2) * 100);
  const underPct = Math.round(((homeUnder.rate + awayUnder.rate) / 2) * 100);
  return { delta: overPct - underPct, overPct, underPct, found: true };
}
