// Drops "phantom" cards from the Live board: an Odds API event for a game the
// schedule feed doesn't actually have. 2026-10-01: Phillies @ Braves showed
// twice (1:00 PM and 7:11 PM CDT) though the MLB schedule had one 7:00 PM game;
// both cards carried the same 16 picks (see pickNearestGame in picks.ts).
//
// Rule - deliberately narrow, never a time-gap heuristic:
//   A card is dropped only when (a) it has NO schedule-feed game assigned to it
//   AND (b) a sibling card - same teams, same Eastern date - DOES. Two cards
//   that both have a schedule game (a real doubleheader) are both kept; a lone
//   card is never dropped; and when no schedule game exists for the group at
//   all (feed empty/failed, off-season gate, a date past the feed's
//   yesterday..tomorrow window, a sport with no score feed, a team-name
//   spelling mismatch) nothing is dropped - missing beats wrong.
//
// "Assigned" is a one-to-one matching, NOT matchScoreToGame: that function
// returns the nearest same-teams game for any card, so the phantom and the real
// card would both resolve to the one real game and neither would look
// unmatched. Here each schedule game is claimed by at most one card, nearest
// first (greedy by |commenceTime delta|), restricted to the card's own Eastern
// date so a neighbouring day's game in the same series can't be claimed either.
//
// Pure and client-safe (type-only import from odds.ts) so it is tsx-testable.
import { easternDateKey } from "@/lib/dates";
import type { ScoreGame } from "@/server/data/odds";

type BoardCard = { homeTeam: string; awayTeam: string; commenceTime: string };

export type DedupedBoard<T> = {
  games: T[];
  // Aligned with `games` (not the input): the schedule game each kept card was
  // assigned, or undefined if it has none. Lets callers read MLB's gameNumber.
  scheduleGames: (ScoreGame | undefined)[];
};

export function dropPhantomCards<T extends BoardCard>(games: T[], scores: ScoreGame[]): DedupedBoard<T> {
  const groupKey = (teams: { homeTeam: string; awayTeam: string }, iso: string) =>
    teams.homeTeam + "|" + teams.awayTeam + "|" + easternDateKey(new Date(iso));

  const cardsByGroup = new Map<string, number[]>();
  games.forEach((g, i) => {
    const key = groupKey(g, g.commenceTime);
    cardsByGroup.set(key, [...(cardsByGroup.get(key) ?? []), i]);
  });
  const scoresByGroup = new Map<string, ScoreGame[]>();
  for (const s of scores) {
    const key = groupKey(s, s.commenceTime);
    scoresByGroup.set(key, [...(scoresByGroup.get(key) ?? []), s]);
  }

  const assigned: (ScoreGame | undefined)[] = games.map(() => undefined);
  const dropped = new Set<number>();

  for (const [key, cardIdxs] of cardsByGroup) {
    const candidates = scoresByGroup.get(key) ?? [];
    if (candidates.length === 0) continue;

    // Greedy nearest-first one-to-one assignment. Ties break on card order then
    // schedule order, so the result is deterministic.
    const pairs: { card: number; sched: number; delta: number }[] = [];
    for (const card of cardIdxs) {
      const cardTime = new Date(games[card].commenceTime).getTime();
      candidates.forEach((s, sched) => {
        pairs.push({ card, sched, delta: Math.abs(new Date(s.commenceTime).getTime() - cardTime) });
      });
    }
    pairs.sort((a, b) => a.delta - b.delta || a.card - b.card || a.sched - b.sched);
    const usedSched = new Set<number>();
    for (const p of pairs) {
      if (assigned[p.card] || usedSched.has(p.sched)) continue;
      assigned[p.card] = candidates[p.sched];
      usedSched.add(p.sched);
    }

    // Drop only an unassigned card that has an assigned sibling.
    if (cardIdxs.some((c) => assigned[c])) {
      for (const c of cardIdxs) if (!assigned[c]) dropped.add(c);
    }
  }

  const kept = games.map((_, i) => i).filter((i) => !dropped.has(i));
  return { games: kept.map((i) => games[i]), scheduleGames: kept.map((i) => assigned[i]) };
}
