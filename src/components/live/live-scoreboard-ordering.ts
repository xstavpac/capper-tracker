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
//
//  3. Forward window - the board shows the next slate only, not every future
//     game a sportsbook has posted a line for. getOddsForSport has no upper
//     date bound and the Odds API posts NFL/NCAAF lines a full week (and the
//     odd marquee matchup months) ahead, so without this the board ran to
//     late November. "Next slate" is the earliest still-upcoming game's
//     Eastern day plus SLATE_LOOKAHEAD_DAYS - wide enough to keep a
//     Thursday-through-Monday football week, or a full college weekend,
//     together on one board, and to still show *something* on an off-day
//     (the anchor is the next game day, not today).
import { easternDateKey, addDaysToDateKey } from "@/lib/dates";
import type { ScoreGame } from "@/server/data/odds";

type OrderableGame = { game: { commenceTime: string }; score?: Pick<ScoreGame, "status"> };

export const SLATE_LOOKAHEAD_DAYS = 4;

function statusRank(status: ScoreGame["status"] | undefined): number {
  return status === "live" ? 0 : status === "final" ? 2 : 1;
}

// The last Eastern calendar day (inclusive, "YYYY-MM-DD") the board should
// show: the earliest game starting on or after `todayKey`, plus
// `lookaheadDays`. With no upcoming games it anchors on `todayKey` itself, so
// callers still get a sane bound rather than everything. Pure - exported so
// the server page can pre-scope its game list (and its pick-matching) to the
// same window the client renders.
export function slateCutoffKey(
  commenceTimes: string[],
  todayKey: string,
  lookaheadDays: number = SLATE_LOOKAHEAD_DAYS
): string {
  const anchorKey = commenceTimes
    .map((t) => easternDateKey(new Date(t)))
    .filter((k) => k >= todayKey)
    .sort()[0];
  return addDaysToDateKey(anchorKey ?? todayKey, lookaheadDays);
}

// `todayKey` is passed in (not read from the clock here) so the caller
// controls it - the component passes easternDateKey(new Date()) fresh on
// every render, tests pass a fixed day.
export function orderBoardGames<T extends OrderableGame>(games: T[], todayKey: string): T[] {
  const cutoffKey = slateCutoffKey(
    games.map(({ game }) => game.commenceTime),
    todayKey
  );

  const visible = games.filter(({ game, score }) => {
    const key = easternDateKey(new Date(game.commenceTime));
    if (key > cutoffKey) return false; // a later slate the book merely has early lines for
    return key >= todayKey || score?.status === "live"; // today onward, or a still-live carry-over
  });

  return [...visible].sort((a, b) => {
    const rankDiff = statusRank(a.score?.status) - statusRank(b.score?.status);
    if (rankDiff !== 0) return rankDiff;
    return new Date(a.game.commenceTime).getTime() - new Date(b.game.commenceTime).getTime();
  });
}
