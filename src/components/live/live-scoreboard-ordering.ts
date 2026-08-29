// Pure filter + sort for the Live tab's game list, split out of
// live-scoreboard.tsx so it can be exercised directly
// (live-scoreboard-ordering-acceptance-test.ts) without rendering React or
// mocking the two external score APIs.
//
// Two rules, in order:
//
//  1. Visibility - a game carried onto today's board from last night's odds
//     snapshot (its start date is before `todayKey`) is kept only while its
//     score status is "live". Once it goes Final it drops off; today's board
//     is not where you look for last night's finished games. A game that
//     starts today is always kept, Final or not.
//
//  2. Order - status is the primary key: "live" (0) at the top, not-yet-
//     started (1) in the middle, "final" (2) grouped at the bottom. Within a
//     tier, soonest start time first. This is what stops a completed early
//     game (1 PM Final) from sorting in among still-upcoming later ones.
import { easternDateKey } from "@/lib/dates";
import type { ScoreGame } from "@/server/data/odds";

type OrderableGame = { game: { commenceTime: string }; score?: Pick<ScoreGame, "status"> };

function statusRank(status: ScoreGame["status"] | undefined): number {
  return status === "live" ? 0 : status === "final" ? 2 : 1;
}

// `todayKey` is passed in (not read from the clock here) so the caller
// controls it - the component passes easternDateKey(new Date()) fresh on
// every render, tests pass a fixed day.
export function orderBoardGames<T extends OrderableGame>(games: T[], todayKey: string): T[] {
  const visible = games.filter(
    ({ game, score }) => easternDateKey(new Date(game.commenceTime)) >= todayKey || score?.status === "live"
  );

  return [...visible].sort((a, b) => {
    const rankDiff = statusRank(a.score?.status) - statusRank(b.score?.status);
    if (rankDiff !== 0) return rankDiff;
    return new Date(a.game.commenceTime).getTime() - new Date(b.game.commenceTime).getTime();
  });
}
