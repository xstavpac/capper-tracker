// Which board games are one of two the same teams play on the same Eastern
// day. Auto-Generate's same-game fill (auto-generate.ts) won't pair two legs on
// such a game unless both picks carry their own game number.
//
// A game counts when either source says so: the board has a second card for
// the same teams that day, or the schedule feed has a game for those teams
// that day that it marks as a doubleheader ("Y" traditional, "S" split) or
// lists twice. Either alone is enough - the other game may have left the odds
// board once it started, and the schedule feed only exists for some leagues.
// Pure and client-safe (type-only import).
import { easternDateKey } from "@/lib/dates";
import type { ScoreGame } from "@/server/data/odds";

type Card = { id: string; homeTeam: string; awayTeam: string; commenceTime: string };
type ScheduleGame = Pick<ScoreGame, "homeTeam" | "awayTeam" | "commenceTime" | "doubleHeaderStatus">;

// The two teams in either order: the "home" team can differ between the two
// games of a doubleheader made up from a postponement.
function matchupKey(g: { homeTeam: string; awayTeam: string; commenceTime: string }): string {
  return [g.homeTeam, g.awayTeam].sort().join("|") + "|" + easternDateKey(new Date(g.commenceTime));
}

export function doubleheaderGameIds(cards: Card[], schedule: ScheduleGame[] = []): Set<string> {
  const cardCount = new Map<string, number>();
  for (const c of cards) cardCount.set(matchupKey(c), (cardCount.get(matchupKey(c)) ?? 0) + 1);

  const scheduleCount = new Map<string, number>();
  const flagged = new Set<string>();
  for (const s of schedule) {
    const key = matchupKey(s);
    scheduleCount.set(key, (scheduleCount.get(key) ?? 0) + 1);
    if (s.doubleHeaderStatus === "Y" || s.doubleHeaderStatus === "S") flagged.add(key);
  }

  const ids = new Set<string>();
  for (const c of cards) {
    const key = matchupKey(c);
    if ((cardCount.get(key) ?? 0) > 1 || (scheduleCount.get(key) ?? 0) > 1 || flagged.has(key)) ids.add(c.id);
  }
  return ids;
}
