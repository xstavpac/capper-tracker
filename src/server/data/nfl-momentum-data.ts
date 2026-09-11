// I/O orchestration for the NFL Momentum panel - every prisma query and
// live fetch this feature needs lives here; src/server/data/nfl-momentum.ts
// stays pure so its rate-of-change math and factor logic can be
// unit-tested without a database or a live ESPN response. Mirrors
// mlb-momentum-data.ts's split, kept as an independent file per
// nfl-momentum.ts's own header (not imported from the MLB version).
//
// Point-in-time discipline: the one historical input (recent scoring) is
// resolved as of startOfEasternDay(gameDate) - the same cutoff convention
// team-record.ts / mlb-momentum-data.ts use - so nothing from the game's
// own day can leak into a "recent" figure.
import { prisma } from "@/lib/prisma";
import { startOfEasternDay } from "@/lib/dates";
import { getNflLiveGameState } from "@/server/data/nfl-live-game-state";
import {
  computeNflMomentumTrend,
  recentScoringFactor,
  driveSuccessFactor,
  possessionFactor,
  yardsPerDriveFactor,
  turnoversFactor,
  thirdDownFactor,
  redZoneFactor,
  type NflMomentumFactor,
  type NflMomentumTrend,
  type NflRecentScoringInput,
} from "@/server/data/nfl-momentum";

const NFL_SPORT_KEY = "americanfootball_nfl";
// Same window as MLB's recent-scoring factor - short enough to read as
// "recent" rather than season-long.
const RECENT_SCORING_GAME_COUNT = 5;

export type NflMomentumPayload = {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  trend: NflMomentumTrend;
  factors: NflMomentumFactor[];
  playsSoFar: number;
  fetchedAt: string; // ISO
};

// Nothing existing computes a rolling "recent points scored" figure for NFL
// either (NflTeamStatSnapshot has per-game points but no rolling-average
// reader, and TeamRecordSnapshot/SituationalRateSnapshot are win/loss and
// situational-question splits, not scoring - confirmed by inspection before
// writing this), so this reads GameResult directly, same shape as MLB's
// equivalent. `before` is an exclusive upper bound.
async function recentPointsForTeam(teamName: string, before: Date): Promise<NflRecentScoringInput> {
  const games = await prisma.gameResult.findMany({
    where: {
      sportKey: NFL_SPORT_KEY,
      isPreseason: false,
      gameDate: { lt: before },
      OR: [{ homeTeam: teamName }, { awayTeam: teamName }],
    },
    orderBy: { gameDate: "desc" },
    take: RECENT_SCORING_GAME_COUNT,
    select: { homeTeam: true, awayTeam: true, homeScore: true, awayScore: true },
  });
  if (games.length === 0) return { teamName, avgPointsLastN: null, gamesConsidered: 0 };
  const totalPoints = games.reduce((sum, g) => sum + (g.homeTeam === teamName ? g.homeScore : g.awayScore), 0);
  return { teamName, avgPointsLastN: totalPoints / games.length, gamesConsidered: games.length };
}

// The game detail page's data entry point for NFL Momentum. `eventId` is
// the ESPN event id - the same value getNflLiveScores puts on ScoreGame.id
// (see odds.ts's getEspnScores), so it's exactly what the page already has
// in hand once a game is matched to a live score.
export async function getNflMomentum(params: {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  gameDate: Date;
}): Promise<NflMomentumPayload> {
  const recentScoringCutoff = startOfEasternDay(params.gameDate);

  const [state, homeScoring, awayScoring] = await Promise.all([
    getNflLiveGameState(params.eventId),
    recentPointsForTeam(params.homeTeam, recentScoringCutoff),
    recentPointsForTeam(params.awayTeam, recentScoringCutoff),
  ]);

  // *100: ESPN's homeWinPercentage is a 0..1 fraction; every threshold and
  // every consumer of computeNflMomentumTrend works in 0-100 percentage
  // points (see nfl-momentum.ts's header) - this is the one place that
  // conversion happens.
  const wpPoints = state.wp.map((p) => ({ homeWinPercentage: p.homeWinPercentage * 100 }));
  const trend = computeNflMomentumTrend(wpPoints);

  const possessingTeam =
    state.possessionTeamAbbreviation === state.homeAbbreviation
      ? params.homeTeam
      : state.possessionTeamAbbreviation === state.awayAbbreviation
        ? params.awayTeam
        : null;

  const factors: NflMomentumFactor[] = [
    recentScoringFactor(homeScoring, awayScoring),
    driveSuccessFactor(params.homeTeam, params.awayTeam, state.homeAbbreviation, state.awayAbbreviation, state.previousDrives),
    possessionFactor(
      params.homeTeam,
      params.awayTeam,
      state.homeAbbreviation,
      state.awayAbbreviation,
      state.possessionTeamAbbreviation,
      state.homeBoxscore?.possessionSeconds ?? null,
      state.awayBoxscore?.possessionSeconds ?? null,
      state.situation
    ),
    yardsPerDriveFactor(
      params.homeTeam,
      params.awayTeam,
      state.homeBoxscore?.totalYards ?? null,
      state.homeBoxscore?.totalDrives ?? null,
      state.awayBoxscore?.totalYards ?? null,
      state.awayBoxscore?.totalDrives ?? null
    ),
    turnoversFactor(params.homeTeam, params.awayTeam, state.homeBoxscore?.turnovers ?? null, state.awayBoxscore?.turnovers ?? null),
    thirdDownFactor(
      params.homeTeam,
      params.awayTeam,
      state.homeBoxscore?.thirdDownMade ?? null,
      state.homeBoxscore?.thirdDownAttempted ?? null,
      state.awayBoxscore?.thirdDownMade ?? null,
      state.awayBoxscore?.thirdDownAttempted ?? null
    ),
    redZoneFactor(
      params.homeTeam,
      params.awayTeam,
      state.homeBoxscore?.redZoneScores ?? null,
      state.homeBoxscore?.redZoneAttempts ?? null,
      state.awayBoxscore?.redZoneScores ?? null,
      state.awayBoxscore?.redZoneAttempts ?? null,
      state.situation?.isRedZone === true,
      possessingTeam
    ),
  ];

  return {
    eventId: params.eventId,
    homeTeam: params.homeTeam,
    awayTeam: params.awayTeam,
    trend,
    factors,
    playsSoFar: state.wp.length,
    fetchedAt: state.fetchedAt.toISOString(),
  };
}

