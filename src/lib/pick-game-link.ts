// Which /live game page a pick's game is, if today's odds slate carries it. A pick stores no game
// id: it is matched the way the Live board matches picks to its cards (matchPicksToGame's exact
// branch) - both team names (through the league's aliases) and a start time within the drift a
// rescheduled start allows; the closest start wins, since a series repeats a matchup day after day.
// Client-safe (no prisma import).
import { teamNamesMatch } from "@/lib/team-name-match";

export type PickGame = { homeTeam: string; awayTeam: string; gameTime: Date };
export type SlateGame = { id: string; homeTeam: string; awayTeam: string; commenceTime: string };

// Same bound as grading's MAX_GAME_TIME_DRIFT_MS (server-only, so restated here).
export const GAME_LINK_MAX_DRIFT_MS = 6 * 3600000;

export function liveGameHref(slate: SlateGame[], pick: PickGame, sportKey: string): string | null {
  let best: SlateGame | null = null;
  let bestDrift = Infinity;
  for (const g of slate) {
    if (!teamNamesMatch(pick.homeTeam, g.homeTeam, sportKey) || !teamNamesMatch(pick.awayTeam, g.awayTeam, sportKey)) continue;
    const drift = Math.abs(new Date(g.commenceTime).getTime() - pick.gameTime.getTime());
    if (drift <= GAME_LINK_MAX_DRIFT_MS && drift < bestDrift) {
      best = g;
      bestDrift = drift;
    }
  }
  return best ? "/live/" + encodeURIComponent(best.id) + "?sport=" + sportKey : null;
}
