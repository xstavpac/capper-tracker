// Pure filter + sort for the Live tab's game list, split out of
// live-scoreboard.tsx so it can be exercised directly
// (live-scoreboard-ordering-acceptance-test.ts) without rendering React or
// mocking the two external score APIs.
//
// RENDER-ONLY. This intentionally drops finished games (rule 1 below), so its
// output must never be the source for Board Pulse or any other "full day's
// slate" calculation. Feeding orderBoardGames' result to Board Pulse made
// "expected upsets today" shrink through the day as games finalized - it
// regressed once already ("Drop finished games from the Live board entirely")
// and was fixed by sourcing the pulse from a fixed today-scoped slate built off
// the odds snapshot in live/page.tsx (boardPulseOdds). If you need every game
// for the day regardless of status, start from that, not from sortedGames.
//
// Three rules, in order:
//
//  1. Visibility - once a game goes Final it drops off the board entirely,
//     whether it started today or was carried over from last night's odds
//     snapshot. The Live tab is for games you can still watch or bet; final
//     scores are already carried separately by the live score ticker, and a
//     full slate of finished games grouped at the bottom was just clutter. A
//     game carried onto today's board from a past odds snapshot (its start
//     date is before `todayKey`) is kept only while its score status is
//     "live"; a game that starts today is kept until it goes Final.
//
//  2. Order - live games (0) sort above not-yet-started games (1). Within a
//     tier, soonest start time first. This is what keeps a still-live early
//     game above a later game that hasn't started, rather than ordering
//     purely by start time.
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
import { easternDateKey, addDaysToDateKey, closestByTime } from "@/lib/dates";
import type { ScoreGame } from "@/server/data/odds";

type OrderableGame = { game: { commenceTime: string }; score?: Pick<ScoreGame, "status"> };

// Client-safe duplicate of server/data/odds.ts's matchScoreToGame - that
// module has a module-level prisma import, which a "use client" component
// must never pull in even transitively (odds.ts itself is fine server-side;
// the risk is only in crossing into the client bundle). Shared here (a pure,
// client-safe module already) rather than re-duplicated per client component
// - both live-scoreboard.tsx and the Advanced Live board import this same
// copy instead of each carrying their own.
export function matchScoreToGame(
  scores: ScoreGame[],
  game: { homeTeam: string; awayTeam: string; commenceTime: string }
): ScoreGame | undefined {
  const candidates = scores.filter((s) => s.homeTeam === game.homeTeam && s.awayTeam === game.awayTeam);
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  const gameStart = new Date(game.commenceTime).getTime();
  return closestByTime(candidates, (s) => new Date(s.commenceTime).getTime(), gameStart);
}

export const SLATE_LOOKAHEAD_DAYS = 4;

// Only two tiers now that Final games are filtered out entirely (rule 1):
// live on top, everything not-yet-started below.
function statusRank(status: ScoreGame["status"] | undefined): number {
  return status === "live" ? 0 : 1;
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
    if (score?.status === "final") return false; // finished - off the board entirely; the score ticker still carries the final
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
