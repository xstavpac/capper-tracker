// A slip pick the Live board has no card for (parlay-slip-picks.ts offBoardSlipPick)
// used to get a game id of its own ("pick:<id>"), so the generator's max legs per
// game and same-game rules never counted it against the real game it is on. This
// finds that real game among the board's: the same home and away team (the
// league's alias spellings included) and a start within the drift window of the
// pick's own time - the matching the board itself uses (matchPicksToGame). When
// more than one card qualifies (a doubleheader, a series), the nearest start wins.
// No match is no match: the pick keeps its own game id rather than being keyed to
// a game it might not be on. Pure and client-safe.
import { teamNamesMatch } from "@/lib/team-name-match";

export type BoardGameRef = { id: string; homeTeam: string; awayTeam: string; commenceTime: string };

export function findBoardGameForPick<G extends BoardGameRef>(
  pick: { homeTeam: string; awayTeam: string; gameTime: Date },
  games: G[],
  sportKey: string | undefined,
  driftMs: number
): G | null {
  const t = pick.gameTime.getTime();
  let best: G | null = null;
  let bestDist = Infinity;
  for (const g of games) {
    if (!teamNamesMatch(pick.homeTeam, g.homeTeam, sportKey) || !teamNamesMatch(pick.awayTeam, g.awayTeam, sportKey)) continue;
    const dist = Math.abs(t - new Date(g.commenceTime).getTime());
    if (dist > driftMs) continue;
    if (dist < bestDist || (dist === bestDist && best !== null && g.id < best.id)) {
      best = g;
      bestDist = dist;
    }
  }
  return best;
}
