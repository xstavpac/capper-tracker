// Which of a league's games Auto-Generate builds from, and how that window
// reads in a sentence.
//
// Every league: today's unstarted games (Eastern day). NFL and NCAAF: the
// unstarted games of the current football week - the Live board's own slate
// for those leagues (slateCutoffKey: the next game day plus its lookahead),
// not a second definition of "this week".
//
// Pure and client-safe.
import { easternDateKey } from "@/lib/dates";
import { slateCutoffKey } from "@/components/live/live-scoreboard-ordering";
import { isWeeklySlateLeague } from "@/lib/live-category-picks";
import { hasKickedOff } from "@/lib/parlay/game-over";

// `commenceTimes` is every game the league's board holds - the slate is
// anchored on the earliest one still to come. Returns the test for one game.
export function autoGenerateWindow(leagueName: string, commenceTimes: string[], now: Date): (commenceTime: string) => boolean {
  const todayKey = easternDateKey(now);
  const lastKey = isWeeklySlateLeague(leagueName) ? slateCutoffKey(commenceTimes, todayKey) : todayKey;
  return (commenceTime) => {
    const start = new Date(commenceTime);
    const key = easternDateKey(start);
    return !hasKickedOff(commenceTime, now) && key >= todayKey && key <= lastKey;
  };
}

// "today", "this week", or both when the searched leagues are mixed.
export function autoGenerateWindowText(leagues: string[]): string {
  const weekly = leagues.filter(isWeeklySlateLeague);
  if (weekly.length === 0) return "today";
  if (weekly.length === leagues.length) return "this week";
  return "today (this week for " + weekly.join(", ") + ")";
}
