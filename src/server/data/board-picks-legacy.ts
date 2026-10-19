// Frozen copy of the board / game-detail pick reads as they were before the
// egress window change: getPicksForGame / getPicksForGames read every column
// plus the full capper row over +-2 days of the games, with no orderBy, and
// getLiveBoardData is the unchanged assembly calling them. Kept (not deleted)
// because it is the parity reference board-picks-window-parity-acceptance-test.ts
// compares the production versions (picks.ts, live-board-picks.ts) against.
//
// NO production code calls anything in this file. Deliberately unchanged from
// the original (origin/main 52a3260) apart from the function names and imports -
// a diff against it is a diff against exactly what production used to run. It
// reuses the production matchPicksToGame / assignPicksToNearestGame /
// toExpanderPick, which this change does not touch.
import { prisma } from "@/lib/prisma";
import { matchPicksToGame, assignPicksToNearestGame } from "@/server/data/picks";
import { getOddsForSport, getYesterdayOddsForSport, getClientScoresForSport } from "@/server/data/odds";
import { toExpanderPick } from "@/server/data/expander-pick";
import type { ExpanderPick } from "@/components/live/game-picks-expander";
import { slateCutoffKey } from "@/components/live/live-scoreboard-ordering";
import { easternDateKey } from "@/lib/dates";
import { dropPhantomCards } from "@/lib/live-board-dedup";
import type { LiveBoardData } from "@/server/data/live-board-picks";

export async function getPicksForGameLegacy(
  userId: string,
  params: { sportName: string; homeTeam: string; awayTeam: string; commenceTime: Date }
) {
  const sport = await prisma.sport.findFirst({
    where: { name: { equals: params.sportName, mode: "insensitive" } },
  });
  if (!sport) return [];

  const windowStart = new Date(params.commenceTime.getTime() - 2 * 86400000);
  const windowEnd = new Date(params.commenceTime.getTime() + 2 * 86400000);

  const candidates = await prisma.pick.findMany({
    where: { userId, sportId: sport.id, gameTime: { gte: windowStart, lt: windowEnd } },
    include: { capper: true },
  });
  if (candidates.length === 0) return [];

  return matchPicksToGame(candidates, params, params.sportName);
}

export async function getPicksForGamesLegacy(
  userId: string,
  sportName: string,
  games: { homeTeam: string; awayTeam: string; commenceTime: Date; gameNumber?: number | null }[]
) {
  if (games.length === 0) return [];

  const sport = await prisma.sport.findFirst({
    where: { name: { equals: sportName, mode: "insensitive" } },
  });
  if (!sport) return games.map(() => []);

  const times = games.map((g) => g.commenceTime.getTime());
  const windowStart = new Date(Math.min(...times) - 2 * 86400000);
  const windowEnd = new Date(Math.max(...times) + 2 * 86400000);

  const allPicks = await prisma.pick.findMany({
    where: { userId, sportId: sport.id, gameTime: { gte: windowStart, lt: windowEnd } },
    include: { capper: true },
  });
  if (allPicks.length === 0) return games.map(() => []);

  const matchedPerGame = games.map((game) => {
    const gameWindowStart = new Date(game.commenceTime.getTime() - 2 * 86400000);
    const gameWindowEnd = new Date(game.commenceTime.getTime() + 2 * 86400000);
    const candidates = allPicks.filter((p) => p.gameTime >= gameWindowStart && p.gameTime < gameWindowEnd);
    return matchPicksToGame(candidates, game, sportName);
  });
  return assignPicksToNearestGame(matchedPerGame, games);
}

export async function getLiveBoardDataLegacy(userId: string, activeSport: string, sportLabel: string): Promise<LiveBoardData> {
  const [allOdds, yesterdayOdds, scores] = await Promise.all([
    getOddsForSport(activeSport),
    getYesterdayOddsForSport(activeSport),
    getClientScoresForSport(activeSport),
  ]);

  const todayKey = easternDateKey(new Date());
  const cutoffKey = slateCutoffKey(
    allOdds.map((g) => g.commenceTime),
    todayKey
  );
  const boardOdds = allOdds.filter((g) => easternDateKey(new Date(g.commenceTime)) <= cutoffKey);
  const boardGameIds = new Set(boardOdds.map((g) => g.id));
  const { games: odds, scheduleGames } = dropPhantomCards(
    [...boardOdds, ...yesterdayOdds.filter((g) => !boardGameIds.has(g.id))],
    scores
  );

  const matchedPicksByGame = await getPicksForGamesLegacy(
    userId,
    sportLabel,
    odds.map((game, i) => ({
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      commenceTime: new Date(game.commenceTime),
      gameNumber: scheduleGames[i]?.doubleHeaderStatus === "N" ? null : (scheduleGames[i]?.gameNumber ?? null),
    }))
  );

  const expanderPicksByGame: ExpanderPick[][] = matchedPicksByGame.map((matchedPicks, gameIndex) =>
    matchedPicks.map((p) => toExpanderPick(p, odds[gameIndex], activeSport, sportLabel))
  );

  return { odds, scores, expanderPicksByGame };
}
