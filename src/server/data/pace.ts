// Shared Pace engine/interface - the sport-agnostic half. MLB and NFL each
// derive their OWN expected-trajectory math from their own game state
// (mlb-pace.ts: inning/half-inning/outs; nfl-pace.ts: quarter/clock), per
// Momentum's own established precedent of never sharing sport-tuned
// numbers. What genuinely IS shared here (and isn't sport-tuned): the
// point-in-time rolling-average calculation every sport's baseline needs
// identically, the 5-bucket classification shape, and the "ratio -> trend"
// assembly step every sport's compute function funnels through - one
// PaceTrend shape, one PaceGauge component (pace-gauge.tsx) can render
// either sport's output without knowing which sport produced it.
//
// Point-in-time invariant (hard rule, see PR description): a team's
// baseline is EVERY completed GameResult for that team, this season, with
// gameDate strictly before the current game's own date. Never
// season-to-date-including-current-game. computeTeamBaseline below is the
// one function that enforces this - both mlb-pace-data.ts and
// nfl-pace-data.ts call it rather than each re-implementing the filter, and
// pace-acceptance-test.ts exercises it directly with fixtures (no DB) to
// lock the invariant down, including a same-day-contamination fixture (a
// deliberately huge "current game" row dated on/after the cutoff) proving
// it can't leak into the average.

export type PaceClassification = "MUCH_SLOWER" | "SLOWER" | "NEAR_EXPECTED" | "FASTER" | "MUCH_FASTER";

export type PaceThresholds = {
  muchSlower: number;
  slower: number;
  faster: number;
  muchFaster: number;
};

// ratio = actual scoring so far / expected scoring so far (1.0 = exactly on
// the expected trajectory). Bucketed the same way for every sport - only
// the threshold NUMBERS differ per sport (see MLB_PACE_*/NFL_PACE_* in
// mlb-pace.ts/nfl-pace.ts), same "shared shape, sport-tuned numbers" split
// Momentum's own classifier already established.
export function classifyPaceRatio(ratio: number, thresholds: PaceThresholds): PaceClassification {
  if (ratio <= thresholds.muchSlower) return "MUCH_SLOWER";
  if (ratio <= thresholds.slower) return "SLOWER";
  if (ratio >= thresholds.muchFaster) return "MUCH_FASTER";
  if (ratio >= thresholds.faster) return "FASTER";
  return "NEAR_EXPECTED";
}

// expectedTotal is 0 whenever fractionComplete is 0 (pregame / first instant
// of the game) - actual/expected would be 0/0 or a division by zero, neither
// of which is meaningful. Treated as "exactly on pace" (ratio 1) rather than
// NaN/Infinity; buildPaceTrend's readyForRead gate is what actually keeps
// this instant from being displayed as a real read, same as Momentum's
// early-game protection.
export function paceRatio(actualTotal: number, expectedTotal: number): number {
  if (expectedTotal > 0) return actualTotal / expectedTotal;
  return actualTotal > 0 ? Number.POSITIVE_INFINITY : 1;
}

export type PaceTrend = {
  classification: PaceClassification;
  // actual/expected scoring, see paceRatio.
  ratio: number;
  actualTotal: number;
  expectedTotal: number;
  // 0..~1+ (extra innings/overtime can push this past 1) - how much of the
  // sport's own regulation trajectory has elapsed, per that sport's own
  // state-to-fraction math.
  fractionComplete: number;
  // False before `minFractionForRead` of the game has elapsed - too little
  // game has happened for a ratio to mean anything (a single early run
  // against a near-zero expected-so-far would otherwise swing to
  // MUCH_FASTER). Mirrors Momentum's MIN_DELTAS_FOR_READ gate. The gauge
  // shows "Warming up" while this is false, same UX as Momentum's panel.
  readyForRead: boolean;
};

// The one place fractionComplete -> PaceTrend assembly happens - shared by
// every sport's compute*PaceTrend so a threshold/gating bug can't be fixed
// in one sport and silently left in the other.
export function buildPaceTrend(params: {
  actualTotal: number;
  expectedTotal: number;
  fractionComplete: number;
  minFractionForRead: number;
  thresholds: PaceThresholds;
}): PaceTrend {
  const ratio = paceRatio(params.actualTotal, params.expectedTotal);
  const readyForRead = params.fractionComplete >= params.minFractionForRead;
  const classification = readyForRead ? classifyPaceRatio(ratio, params.thresholds) : "NEAR_EXPECTED";
  return {
    classification,
    ratio,
    actualTotal: params.actualTotal,
    expectedTotal: params.expectedTotal,
    fractionComplete: params.fractionComplete,
    readyForRead,
  };
}

export type PaceBaseline = { teamName: string; avgPerGame: number | null; gamesConsidered: number };

// A completed game row shaped like GameResult - deliberately just the
// fields the baseline math needs, so this stays testable with plain
// fixtures instead of a real Prisma row.
export type BaselineGameRow = {
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  gameDate: Date;
};

// The point-in-time invariant, enforced here and only here:
//   gameDate >= window.seasonStart AND gameDate < window.before
// `before` must be the CURRENT game's own cutoff (its Eastern day start,
// same convention mlb-momentum-data.ts/nfl-momentum-data.ts already use for
// "recent" reads) - never the current game's own row, and never a later
// date that would let a same-day result leak in. Re-filters `games` itself
// (rather than trusting the caller's DB query already scoped this) so a
// fixture array handed to this function directly proves the invariant,
// independent of whatever the Prisma `where` clause happens to say.
export function computeTeamBaseline(games: BaselineGameRow[], teamName: string, window: { seasonStart: Date; before: Date }): PaceBaseline {
  const priorGames = games.filter(
    (g) =>
      (g.homeTeam === teamName || g.awayTeam === teamName) &&
      g.gameDate.getTime() >= window.seasonStart.getTime() &&
      g.gameDate.getTime() < window.before.getTime()
  );
  if (priorGames.length === 0) return { teamName, avgPerGame: null, gamesConsidered: 0 };
  const total = priorGames.reduce((sum, g) => sum + (g.homeTeam === teamName ? g.homeScore : g.awayScore), 0);
  return { teamName, avgPerGame: total / priorGames.length, gamesConsidered: priorGames.length };
}

// Minimum sample: ONE completed prior game for EACH team - not just one
// side. A team with zero prior games means Pace doesn't render for this
// matchup AT ALL, regardless of the opponent's sample size (see PR
// description) - hence the AND, not an OR or an average-with-a-default.
export function isPaceEligible(home: PaceBaseline, away: PaceBaseline): boolean {
  return home.gamesConsidered >= 1 && away.gamesConsidered >= 1;
}
