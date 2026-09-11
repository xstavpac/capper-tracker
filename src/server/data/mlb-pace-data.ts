// I/O orchestration for the MLB Pace panel - every prisma query and live
// fetch this feature needs lives here; src/server/data/mlb-pace.ts stays
// pure so its trajectory math can be unit-tested without a database. Same
// split as mlb-momentum-data.ts / mlb-momentum.ts.
//
// Live state reuse: this deliberately does NOT add a second per-game live
// fetch. getMlbLiveGameState (live-game-state.ts) already polls the MLB
// Stats API winProbability feed for Momentum, and every play it returns
// already carries inning/isTopInning/outs/homeScore/awayScore - exactly
// what Pace's trajectory math needs. Pace and Momentum for the same game
// therefore share one cached live fetch (see live-game-state.ts's own
// caching layer), not two independent polls.
import { prisma } from "@/lib/prisma";
import { startOfEasternDay } from "@/lib/dates";
import { SPORT_SEASON_CONFIG } from "@/lib/sport-seasons";
import { getMlbLiveGameState } from "@/server/data/live-game-state";
import { computeTeamBaseline, isPaceEligible, type BaselineGameRow } from "@/server/data/pace";
import { computeMlbPaceTrend, type MlbGameProgress } from "@/server/data/mlb-pace";
import type { PaceTrend } from "@/server/data/pace";

const MLB_SPORT_KEY = "baseball_mlb";

export type MlbPacePayload =
  | { eligible: false }
  | {
      eligible: true;
      gamePk: string;
      homeTeam: string;
      awayTeam: string;
      trend: PaceTrend;
      homeBaselineRunsPerGame: number;
      awayBaselineRunsPerGame: number;
      homeGamesConsidered: number;
      awayGamesConsidered: number;
      fetchedAt: string; // ISO
    };

// Scoped by sportKey + season window at the query level (an efficiency
// scope, not the source of truth for the invariant - computeTeamBaseline
// re-checks the exact same window against whatever rows come back, so this
// query could even be loosened without breaking correctness).
async function seasonGamesForTeam(teamName: string, seasonStart: Date, before: Date): Promise<BaselineGameRow[]> {
  return prisma.gameResult.findMany({
    where: {
      sportKey: MLB_SPORT_KEY,
      gameDate: { gte: seasonStart, lt: before },
      OR: [{ homeTeam: teamName }, { awayTeam: teamName }],
    },
    select: { homeTeam: true, awayTeam: true, homeScore: true, awayScore: true, gameDate: true },
  });
}

function latestProgress(plays: { inning: number; isTopInning: boolean; outs: number; homeScore: number; awayScore: number }[]) {
  if (plays.length === 0) return null;
  return plays[plays.length - 1];
}

// The game detail page's data entry point for MLB Pace. `gamePk` is the MLB
// Stats API game id, same as getMlbMomentum's param - the two functions are
// called independently (see api/live/pace/route.ts and
// api/live/momentum/route.ts) but resolve to the same cached live-state
// fetch under the hood.
export async function getMlbPace(params: { gamePk: string; homeTeam: string; awayTeam: string; gameDate: Date }): Promise<MlbPacePayload> {
  const before = startOfEasternDay(params.gameDate);
  const seasonStart = new Date(SPORT_SEASON_CONFIG[MLB_SPORT_KEY].seasonStart + "T00:00:00.000Z");

  const [homeGames, awayGames, state] = await Promise.all([
    seasonGamesForTeam(params.homeTeam, seasonStart, before),
    seasonGamesForTeam(params.awayTeam, seasonStart, before),
    getMlbLiveGameState(params.gamePk),
  ]);

  const homeBaseline = computeTeamBaseline(homeGames, params.homeTeam, { seasonStart, before });
  const awayBaseline = computeTeamBaseline(awayGames, params.awayTeam, { seasonStart, before });
  if (!isPaceEligible(homeBaseline, awayBaseline)) return { eligible: false };

  const latest = latestProgress(state.plays);
  const progress: MlbGameProgress | null = latest ? { inning: latest.inning, isTopInning: latest.isTopInning, outs: latest.outs } : null;
  const trend = computeMlbPaceTrend({
    homeBaselineRunsPerGame: homeBaseline.avgPerGame!,
    awayBaselineRunsPerGame: awayBaseline.avgPerGame!,
    progress,
    actualHomeScore: latest?.homeScore ?? 0,
    actualAwayScore: latest?.awayScore ?? 0,
  });

  return {
    eligible: true,
    gamePk: params.gamePk,
    homeTeam: params.homeTeam,
    awayTeam: params.awayTeam,
    trend,
    homeBaselineRunsPerGame: homeBaseline.avgPerGame!,
    awayBaselineRunsPerGame: awayBaseline.avgPerGame!,
    homeGamesConsidered: homeBaseline.gamesConsidered,
    awayGamesConsidered: awayBaseline.gamesConsidered,
    fetchedAt: state.fetchedAt.toISOString(),
  };
}
