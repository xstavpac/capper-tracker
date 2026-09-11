// I/O orchestration for the NFL Pace panel - every prisma query and live
// fetch this feature needs lives here; src/server/data/nfl-pace.ts stays
// pure so its trajectory math can be unit-tested without a database or a
// live ESPN response. Same split as nfl-momentum-data.ts / nfl-momentum.ts,
// kept independent per that file's own file-independence rationale.
//
// Live state reuse: getNflLiveGameState (nfl-live-game-state.ts) already
// fetches ESPN's summary endpoint for Momentum's win-probability/drives/
// boxscore data. That same fetch's clockPlays field (added alongside this
// PR, see that file's header) carries every play's period/clock/score - so
// Pace reads it directly rather than fetching ESPN a second time.
//
// NFL matchups will mostly show "not enough data" for a while: baseline
// eligibility needs one completed REGULAR-SEASON game per team, and most of
// a 17-week season's matchups won't have that until Sunday's slate starts
// finishing - expected and correct, not a bug (see PR description).
import { prisma } from "@/lib/prisma";
import { startOfEasternDay } from "@/lib/dates";
import { SPORT_SEASON_CONFIG } from "@/lib/sport-seasons";
import { getNflLiveGameState } from "@/server/data/nfl-live-game-state";
import { computeTeamBaseline, isPaceEligible, type BaselineGameRow } from "@/server/data/pace";
import { computeNflPaceTrend, type NflGameProgress } from "@/server/data/nfl-pace";
import type { PaceTrend } from "@/server/data/pace";

const NFL_SPORT_KEY = "americanfootball_nfl";

export type NflPacePayload =
  | { eligible: false }
  | {
      eligible: true;
      eventId: string;
      homeTeam: string;
      awayTeam: string;
      trend: PaceTrend;
      homeBaselinePointsPerGame: number;
      awayBaselinePointsPerGame: number;
      homeGamesConsidered: number;
      awayGamesConsidered: number;
      fetchedAt: string; // ISO
    };

// "This season" for Pace's baseline means real REGULAR-SEASON games -
// regularSeasonStart, not SPORT_SEASON_CONFIG's widened seasonStart (which
// deliberately reaches back to cover preseason for the odds/scores/grading
// pipeline, see sport-seasons.ts). A rolling scoring average built from
// preseason score lines (backups playing, shortened game plans) would not
// represent a team's real regular-season pace. isPreseason: false at the
// query level is the same belt-and-suspenders scoping nfl-momentum-data.ts
// already uses.
async function seasonGamesForTeam(teamName: string, seasonStart: Date, before: Date): Promise<BaselineGameRow[]> {
  return prisma.gameResult.findMany({
    where: {
      sportKey: NFL_SPORT_KEY,
      isPreseason: false,
      gameDate: { gte: seasonStart, lt: before },
      OR: [{ homeTeam: teamName }, { awayTeam: teamName }],
    },
    select: { homeTeam: true, awayTeam: true, homeScore: true, awayScore: true, gameDate: true },
  });
}

function latestProgress(plays: { period: number; clockSeconds: number | null; homeScore: number; awayScore: number }[]) {
  if (plays.length === 0) return null;
  return plays[plays.length - 1];
}

// The game detail page's data entry point for NFL Pace. `eventId` is the
// ESPN event id, same as getNflMomentum's param.
export async function getNflPace(params: { eventId: string; homeTeam: string; awayTeam: string; gameDate: Date }): Promise<NflPacePayload> {
  const before = startOfEasternDay(params.gameDate);
  const regularSeasonStart = SPORT_SEASON_CONFIG[NFL_SPORT_KEY].regularSeasonStart;
  const seasonStart = new Date((regularSeasonStart ?? SPORT_SEASON_CONFIG[NFL_SPORT_KEY].seasonStart) + "T00:00:00.000Z");

  const [homeGames, awayGames, state] = await Promise.all([
    seasonGamesForTeam(params.homeTeam, seasonStart, before),
    seasonGamesForTeam(params.awayTeam, seasonStart, before),
    getNflLiveGameState(params.eventId),
  ]);

  const homeBaseline = computeTeamBaseline(homeGames, params.homeTeam, { seasonStart, before });
  const awayBaseline = computeTeamBaseline(awayGames, params.awayTeam, { seasonStart, before });
  if (!isPaceEligible(homeBaseline, awayBaseline)) return { eligible: false };

  const latest = latestProgress(state.clockPlays);
  const progress: NflGameProgress | null = latest ? { period: latest.period, clockSeconds: latest.clockSeconds } : null;
  const trend = computeNflPaceTrend({
    homeBaselinePointsPerGame: homeBaseline.avgPerGame!,
    awayBaselinePointsPerGame: awayBaseline.avgPerGame!,
    progress,
    actualHomeScore: latest?.homeScore ?? 0,
    actualAwayScore: latest?.awayScore ?? 0,
  });

  return {
    eligible: true,
    eventId: params.eventId,
    homeTeam: params.homeTeam,
    awayTeam: params.awayTeam,
    trend,
    homeBaselinePointsPerGame: homeBaseline.avgPerGame!,
    awayBaselinePointsPerGame: awayBaseline.avgPerGame!,
    homeGamesConsidered: homeBaseline.gamesConsidered,
    awayGamesConsidered: awayBaseline.gamesConsidered,
    fetchedAt: state.fetchedAt.toISOString(),
  };
}
