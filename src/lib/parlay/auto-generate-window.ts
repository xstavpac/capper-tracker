// Which of a league's games Auto-Generate builds from, and how that window
// reads in a sentence.
//
// Every league: today's games (Eastern day). NFL and NCAAF: the games of the
// current football week - the Live board's own slate for those leagues
// (slateCutoffKey: the next game day plus its lookahead), not a second
// definition of "this week".
//
// A game that has kicked off stays in the window while it is within its sport's
// progress cutoff (game-progress.ts poolEligible: through Q3 / 1H / P2 / the 6th
// inning); past it, or with no progress known, it is out. A started game is never
// out for its date alone (one that tipped off last night and is still early is
// on today's board).
//
// Pure and client-safe.
import { easternDateKey } from "@/lib/dates";
import { slateCutoffKey } from "@/components/live/live-scoreboard-ordering";
import { isWeeklySlateLeague } from "@/lib/live-category-picks";
import { hasKickedOff, type GameFeedStatus } from "@/lib/parlay/game-over";
import { poolEligible, type GameLiveState } from "@/lib/parlay/game-progress";

export type WindowLive = { gameStatus?: GameFeedStatus | null; liveState?: GameLiveState | null };

// `commenceTimes` is every game the league's board holds - the slate is
// anchored on the earliest one still to come. Returns the test for one game;
// `live` is the game's feed status and progress (none: a started game is out).
export function autoGenerateWindow(leagueName: string, commenceTimes: string[], now: Date): (commenceTime: string, live?: WindowLive) => boolean {
  const todayKey = easternDateKey(now);
  const lastKey = isWeeklySlateLeague(leagueName) ? slateCutoffKey(commenceTimes, todayKey) : todayKey;
  return (commenceTime, live) => {
    if (hasKickedOff(commenceTime, now)) {
      return poolEligible({ gameTime: commenceTime, leagueName, gameStatus: live?.gameStatus ?? null, liveState: live?.liveState ?? null }, now);
    }
    const key = easternDateKey(new Date(commenceTime));
    return key >= todayKey && key <= lastKey;
  };
}

// "today", "this week", or both when the searched leagues are mixed.
export function autoGenerateWindowText(leagues: string[]): string {
  const weekly = leagues.filter(isWeeklySlateLeague);
  if (weekly.length === 0) return "today";
  if (weekly.length === leagues.length) return "this week";
  return "today (this week for " + weekly.join(", ") + ")";
}
