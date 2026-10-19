// Frozen copy of getLiveBoardData (live-board-picks.ts) as it was before the board
// started reading the projected odds (getBoardOddsForSport): identical except that
// it reads the FULL snapshot through getOddsForSport. Kept only as the parity
// reference for board-odds-projection-parity-acceptance-test.ts.
//
// NO production code may import this file (legacy-reference-import-guard-
// acceptance-test.ts enforces it).
import {
  getOddsForSport,
  getYesterdayOddsForSport,
  getClientScoresForSport,
} from "@/server/data/odds";
import { getPicksForGames } from "@/server/data/picks";
import { toExpanderPick } from "@/server/data/expander-pick";
import type { ExpanderPick } from "@/components/live/game-picks-expander";
import { slateCutoffKey } from "@/components/live/live-scoreboard-ordering";
import { easternDateKey } from "@/lib/dates";
import { dropPhantomCards } from "@/lib/live-board-dedup";
import type { LiveBoardData } from "@/server/data/live-board-picks";

export async function getLiveBoardDataFullOdds(userId: string, activeSport: string, sportLabel: string): Promise<LiveBoardData> {
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

  const matchedPicksByGame = await getPicksForGames(
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
