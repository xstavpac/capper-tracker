// I/O orchestration for the MLB Momentum panel - every prisma query and live
// fetch this feature needs lives here; src/server/data/mlb-momentum.ts stays
// pure so its rate-of-change math and factor logic can be unit-tested
// without a database. Mirrors game-pulse.ts's split (buildGamePulsePanelRows
// pure / getGamePulsePanelRows I/O).
//
// Point-in-time discipline: every historical input (recent form, recent
// scoring, starting pitcher) is resolved as of dayBefore(gameDate) or
// startOfEasternDay(gameDate) - the same cutoff convention as
// getHistoricalStartingMatchup, getTeamRecordAsOf, and the model-engine
// resolver - so nothing from the game's own day (let alone the game itself)
// can leak into a "historical" input.
import { prisma } from "@/lib/prisma";
import { startOfEasternDay } from "@/lib/dates";
import { dayBefore } from "@/server/data/providers/snapshot-utils";
import { resolveVariable } from "@/server/data/model-engine/resolver";
import { getHistoricalStartingMatchup } from "@/server/data/mlb-pitcher-history";
import { getMlbLiveGameState, type MlbWinProbabilityPlay } from "@/server/data/live-game-state";
import {
  computeMomentumTrend,
  currentPitcherForTeam,
  recentFormFactor,
  recentScoringFactor,
  inGameScoringFactor,
  baseOutFactor,
  startingPitcherFactor,
  bullpenUsageFactor,
  MOMENTUM_WINDOW_PLAYS,
  type MomentumFactor,
  type MomentumTrend,
  type RecentScoringInput,
  type TeamFormInput,
} from "@/server/data/mlb-momentum";

const MLB_SPORT_KEY = "baseball_mlb";
// How many of a team's own most recent finished games "recent scoring"
// averages over - short enough to read as "recent" rather than season-long.
const RECENT_SCORING_GAME_COUNT = 5;

export type MlbMomentumPayload = {
  gamePk: string;
  homeTeam: string;
  awayTeam: string;
  trend: MomentumTrend;
  factors: MomentumFactor[];
  playsSoFar: number;
  fetchedAt: string; // ISO
};

async function teamFormInput(teamName: string, asOf: Date): Promise<TeamFormInput> {
  const [last10, streak] = await Promise.all([
    resolveVariable("team_last10_win_pct", { type: "team", teamName }, asOf, { sportKey: MLB_SPORT_KEY }),
    resolveVariable("team_streak", { type: "team", teamName }, asOf, { sportKey: MLB_SPORT_KEY }),
  ]);
  return {
    teamName,
    last10WinPct: last10.found ? last10.value : null,
    streak: streak.found ? streak.value : null,
  };
}

// Nothing existing computes a rolling "recent runs scored" figure
// (TeamStatSnapshot only has season-cumulative run differential - see
// mlb-momentum.ts's header on recentScoringFactor), so this reads GameResult
// directly rather than through a snapshot table. `before` is an exclusive
// upper bound - pass startOfEasternDay(gameDate) so today's own game (and
// anything else dated today) can never be one of the "recent" games.
async function recentRunsForTeam(teamName: string, before: Date): Promise<RecentScoringInput> {
  const games = await prisma.gameResult.findMany({
    where: {
      sportKey: MLB_SPORT_KEY,
      isPreseason: false,
      gameDate: { lt: before },
      OR: [{ homeTeam: teamName }, { awayTeam: teamName }],
    },
    orderBy: { gameDate: "desc" },
    take: RECENT_SCORING_GAME_COUNT,
    select: { homeTeam: true, awayTeam: true, homeScore: true, awayScore: true },
  });
  if (games.length === 0) return { teamName, avgRunsLastN: null, gamesConsidered: 0 };
  const totalRuns = games.reduce((sum, g) => sum + (g.homeTeam === teamName ? g.homeScore : g.awayScore), 0);
  return { teamName, avgRunsLastN: totalRuns / games.length, gamesConsidered: games.length };
}

function latestPlayState(plays: MlbWinProbabilityPlay[]) {
  if (plays.length === 0) return null;
  const latest = plays[plays.length - 1];
  return { isTopInning: latest.isTopInning, outs: latest.outs, runnersOnBase: latest.runnersOnBase, inning: latest.inning };
}

// The game detail page's data entry point for MLB Momentum. `gamePk` is the
// MLB Stats API game id - the same value getMlbLiveScores puts on
// ScoreGame.id and persistFinalScores stores as GameResult.externalId /
// GameStarters.externalId, so it joins directly against both without a
// separate id-mapping step.
export async function getMlbMomentum(params: {
  gamePk: string;
  homeTeam: string;
  awayTeam: string;
  gameDate: Date;
}): Promise<MlbMomentumPayload> {
  const asOf = dayBefore(params.gameDate);
  const recentScoringCutoff = startOfEasternDay(params.gameDate);

  const [state, homeForm, awayForm, homeScoring, awayScoring, matchup] = await Promise.all([
    getMlbLiveGameState(params.gamePk),
    teamFormInput(params.homeTeam, asOf),
    teamFormInput(params.awayTeam, asOf),
    recentRunsForTeam(params.homeTeam, recentScoringCutoff),
    recentRunsForTeam(params.awayTeam, recentScoringCutoff),
    getHistoricalStartingMatchup(MLB_SPORT_KEY, params.gamePk),
  ]);

  const plays = state.plays;
  const trend = computeMomentumTrend(plays);
  const windowPlays = plays.slice(-MOMENTUM_WINDOW_PLAYS);

  const homeStarter = matchup?.home.starter ?? null;
  const awayStarter = matchup?.away.starter ?? null;
  const homeCurrentPitcherId = currentPitcherForTeam(plays, "home");
  const awayCurrentPitcherId = currentPitcherForTeam(plays, "away");

  const factors: MomentumFactor[] = [
    recentFormFactor(homeForm, awayForm),
    recentScoringFactor(homeScoring, awayScoring),
    inGameScoringFactor(params.homeTeam, params.awayTeam, windowPlays),
    baseOutFactor(params.homeTeam, params.awayTeam, latestPlayState(plays)),
    startingPitcherFactor(
      params.homeTeam,
      params.awayTeam,
      homeStarter ? { pitcherName: homeStarter.pitcherName, era: matchup?.home.line?.era ?? null } : null,
      awayStarter ? { pitcherName: awayStarter.pitcherName, era: matchup?.away.line?.era ?? null } : null
    ),
    bullpenUsageFactor(
      params.homeTeam,
      params.awayTeam,
      { starterPitcherId: homeStarter?.pitcherId ?? null, currentPitcherId: homeCurrentPitcherId },
      { starterPitcherId: awayStarter?.pitcherId ?? null, currentPitcherId: awayCurrentPitcherId }
    ),
  ];

  return {
    gamePk: params.gamePk,
    homeTeam: params.homeTeam,
    awayTeam: params.awayTeam,
    trend,
    factors,
    playsSoFar: plays.length,
    fetchedAt: state.fetchedAt.toISOString(),
  };
}
