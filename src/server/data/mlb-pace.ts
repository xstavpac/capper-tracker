// The MLB Pace calculation engine - pure functions only, no I/O. Fed
// pre-fetched inputs (each team's rolling season baseline, the live game's
// current inning/outs/score) by mlb-pace-data.ts, which owns every
// prisma/fetch call. Same pure-engine/I/O split as mlb-momentum.ts /
// mlb-momentum-data.ts.
//
// Pace is NOT score divided by time elapsed - it's the live scoring
// trajectory compared against an EXPECTED trajectory built from both teams'
// own rolling season averages (see pace.ts's point-in-time invariant),
// accounting for game state (inning/half-inning/outs), not just a clock.
// MLB has no clock, so "how far through the game" is derived from
// half-innings-plus-outs against a 9-inning regulation game.
import { buildPaceTrend, type PaceTrend } from "@/server/data/pace";

// ---------------------------------------------------------------------------
// Tentative thresholds - a reasonable placeholder, not a calibrated one
// (same caveat as Momentum's own thresholds - real calibration needs a
// season of real trajectories to backtest against, which doesn't exist
// yet). Exported so the acceptance test and any future calibration pass
// share these constants instead of hardcoding copies.
// ---------------------------------------------------------------------------
export const MLB_PACE_REGULATION_INNINGS = 9;
// Ratio (actual runs so far / expected runs so far) thresholds for the
// 5-bucket classification. Asymmetric around 1.0 on purpose - actual can
// never go below 0 (ratio floor at 0) but has no ceiling, so "much faster"
// and "much slower" aren't mirror images of each other.
export const MLB_PACE_MUCH_SLOWER_RATIO = 0.5;
export const MLB_PACE_SLOWER_RATIO = 0.75;
export const MLB_PACE_FASTER_RATIO = 1.35;
export const MLB_PACE_MUCH_FASTER_RATIO = 1.75;
// At least one full inning must have elapsed before a read is trusted -
// early-game protection, same idea as Momentum's MOMENTUM_MIN_DELTAS_FOR_READ.
// Half an inning in, a single run makes the ratio meaningless.
export const MLB_PACE_MIN_FRACTION_FOR_READ = 1 / MLB_PACE_REGULATION_INNINGS;

export type MlbGameProgress = { inning: number; isTopInning: boolean; outs: number };

// Half-innings completed (top = 0/2, bottom = 1/2 through the inning) plus a
// fractional adjustment for outs already recorded in the CURRENT half
// (0/1/2 outs -> 0, 1/3, 2/3 of that half), all over 18 total half-innings
// in a 9-inning regulation game. Extra innings simply push this past 1.0,
// which is correct - more innings played means more scoring is expected,
// not a cap on how "complete" the game can read as.
export function mlbFractionComplete(progress: MlbGameProgress): number {
  const inning = Math.max(1, progress.inning);
  const halfInningsCompleted = (inning - 1) * 2 + (progress.isTopInning ? 0 : 1);
  const outsFraction = Math.max(0, Math.min(progress.outs, 3)) / 3;
  return (halfInningsCompleted + outsFraction) / (MLB_PACE_REGULATION_INNINGS * 2);
}

export function computeMlbPaceTrend(params: {
  homeBaselineRunsPerGame: number;
  awayBaselineRunsPerGame: number;
  progress: MlbGameProgress | null;
  actualHomeScore: number;
  actualAwayScore: number;
}): PaceTrend {
  const fractionComplete = params.progress ? mlbFractionComplete(params.progress) : 0;
  const expectedTotal = (params.homeBaselineRunsPerGame + params.awayBaselineRunsPerGame) * fractionComplete;
  const actualTotal = params.actualHomeScore + params.actualAwayScore;
  return buildPaceTrend({
    actualTotal,
    expectedTotal,
    fractionComplete,
    minFractionForRead: MLB_PACE_MIN_FRACTION_FOR_READ,
    thresholds: {
      muchSlower: MLB_PACE_MUCH_SLOWER_RATIO,
      slower: MLB_PACE_SLOWER_RATIO,
      faster: MLB_PACE_FASTER_RATIO,
      muchFaster: MLB_PACE_MUCH_FASTER_RATIO,
    },
  });
}
