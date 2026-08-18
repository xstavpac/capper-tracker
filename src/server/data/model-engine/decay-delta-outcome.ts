// The actualFavWon derivation, factored into its own side-effect-free
// module (Build Step 7 fix) - decay-delta-backtest.ts and
// decay-delta-predictions.ts both need this pure function, but
// decay-delta-backtest.ts is a runnable script with an unguarded top-level
// main() call. Importing a function FROM a script file still executes that
// file's module body, including its top-level main() invocation - so
// decay-delta-predictions.ts importing actualFavWon directly from
// decay-delta-backtest.ts silently re-ran the entire ~30-minute Build Step
// 5 backtest as a side effect of every import (confirmed: the first
// backfill run's own output contained a full extra bucket-performance
// report it never asked for). This file has no runnable entry point, ever -
// just the shared pure logic both callers need.
export type GradedRow = {
  id: string;
  favTeam: string | null;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  gameDate: Date;
};

// Answers "did the favorite in THIS specific graded game actually win" -
// deliberately independent of resolveGameObservations (which excludes the
// game being evaluated via the asOf boundary, so it can never answer this
// question about the game itself). Mirrors observations.ts's own favWon
// derivation exactly: favIsHome/favIsAway guard against a favTeam that
// doesn't byte-match either side, and a tied-score guard - same two defensive
// checks, applied here to the one other place a plain boolean can't honestly
// represent what happened.
export function actualFavWon(row: GradedRow): boolean | null {
  if (row.favTeam === null) return null;
  const favIsHome = row.favTeam === row.homeTeam;
  const favIsAway = row.favTeam === row.awayTeam;
  if (!favIsHome && !favIsAway) return null;
  if (row.homeScore === row.awayScore) return null;
  return favIsHome ? row.homeScore > row.awayScore : row.awayScore > row.homeScore;
}
