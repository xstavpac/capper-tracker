// The NFL Pace calculation engine - pure functions only, no I/O. NFL
// sibling of mlb-pace.ts, kept as its own file (not importing from the MLB
// version) for the same reason nfl-momentum.ts stays independent of
// mlb-momentum.ts: the two sports' state-to-trajectory math is genuinely
// different (quarter/clock-remaining here, inning/outs there), and sharing
// an implementation would mean nullable-field sprawl for no real reuse.
// What IS shared is pace.ts's classification shape/assembly (buildPaceTrend)
// and the point-in-time baseline math (computeTeamBaseline) - see that
// file's header.
//
// Quarter/clock-aware, not just elapsed-clock-aware: a 14-point game with 11
// minutes left in Q2 and a 14-point game with 2 minutes left in Q4 are NOT
// the same trajectory (see PR description) - nflFractionComplete below is
// what makes those two states produce very different expected-scoring
// baselines, and therefore very different Pace reads for the same actual
// score.
import { buildPaceTrend, type PaceTrend } from "@/server/data/pace";

// ---------------------------------------------------------------------------
// Tentative thresholds - placeholders, not calibrated (same caveat as
// mlb-pace.ts and Momentum's own constants). Deliberately NOT copied from
// MLB's numbers - reusing baseball-tuned ratios for football would be a
// guess dressed up as reuse, same reasoning nfl-momentum.ts already gives
// for not reusing MLB's momentum thresholds.
// ---------------------------------------------------------------------------
export const NFL_PACE_REGULATION_PERIODS = 4;
export const NFL_PACE_REGULATION_PERIOD_SECONDS = 15 * 60; // 900 - confirmed live via ESPN's own `format.regulation` (900s/period)
export const NFL_PACE_OT_PERIOD_SECONDS = 10 * 60; // 600 - confirmed live via ESPN's own `format.overtime` (600s/period)
export const NFL_PACE_REGULATION_SECONDS = NFL_PACE_REGULATION_PERIODS * NFL_PACE_REGULATION_PERIOD_SECONDS;

export const NFL_PACE_MUCH_SLOWER_RATIO = 0.5;
export const NFL_PACE_SLOWER_RATIO = 0.75;
export const NFL_PACE_FASTER_RATIO = 1.3;
export const NFL_PACE_MUCH_FASTER_RATIO = 1.7;
// At least 5 game-minutes of real clock must have elapsed before a read is
// trusted - early-game protection, same idea as MLB's one-inning floor and
// Momentum's min-deltas-for-read gate.
export const NFL_PACE_MIN_FRACTION_FOR_READ = 300 / NFL_PACE_REGULATION_SECONDS;

function periodLengthSeconds(period: number): number {
  return period <= NFL_PACE_REGULATION_PERIODS ? NFL_PACE_REGULATION_PERIOD_SECONDS : NFL_PACE_OT_PERIOD_SECONDS;
}

export type NflGameProgress = { period: number; clockSeconds: number | null };

// Seconds elapsed in every period strictly before the current one, plus
// however much of the CURRENT period's own length has elapsed (length minus
// clock remaining), all over one regulation game's total seconds. A null
// clockSeconds (ESPN's display clock didn't parse - see
// nfl-live-game-state.ts's parseClockToSeconds) degrades to "just started
// this period" (0 elapsed) rather than crashing or assuming the period is
// over - a conservative under-estimate of progress, which biases toward
// "not enough data yet" rather than a fabricated read.
export function nflFractionComplete(progress: NflGameProgress): number {
  const period = Math.max(1, progress.period);
  const currentPeriodLength = periodLengthSeconds(period);
  const clockRemaining = progress.clockSeconds === null ? currentPeriodLength : Math.max(0, Math.min(progress.clockSeconds, currentPeriodLength));
  const secondsElapsedThisPeriod = currentPeriodLength - clockRemaining;
  let priorSeconds = 0;
  for (let p = 1; p < period; p++) priorSeconds += periodLengthSeconds(p);
  return (priorSeconds + secondsElapsedThisPeriod) / NFL_PACE_REGULATION_SECONDS;
}

export function computeNflPaceTrend(params: {
  homeBaselinePointsPerGame: number;
  awayBaselinePointsPerGame: number;
  progress: NflGameProgress | null;
  actualHomeScore: number;
  actualAwayScore: number;
}): PaceTrend {
  const fractionComplete = params.progress ? nflFractionComplete(params.progress) : 0;
  const expectedTotal = (params.homeBaselinePointsPerGame + params.awayBaselinePointsPerGame) * fractionComplete;
  const actualTotal = params.actualHomeScore + params.actualAwayScore;
  return buildPaceTrend({
    actualTotal,
    expectedTotal,
    fractionComplete,
    minFractionForRead: NFL_PACE_MIN_FRACTION_FOR_READ,
    thresholds: {
      muchSlower: NFL_PACE_MUCH_SLOWER_RATIO,
      slower: NFL_PACE_SLOWER_RATIO,
      faster: NFL_PACE_FASTER_RATIO,
      muchFaster: NFL_PACE_MUCH_FASTER_RATIO,
    },
  });
}
