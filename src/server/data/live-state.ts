// Live progress and score for the Parlay code's started games, read from the
// score feed's shared cache (getLiveScoresForSport: ESPN / MLB Stats API behind
// the Next Data Cache plus a per-instance memo - the same entry the board itself
// just read). No database read. The full ScoreGame is used, not the browser-bound
// projection, because only it says when a score is missing (scoreMissing), which
// must read as "changed", never as 0-0.
import type { GameLiveState } from "@/lib/parlay/game-progress";
import { inningNumber } from "@/lib/parlay/game-progress";
import { matchScoreToGame, teamScore } from "@/components/live/live-scoreboard-ordering";
import { getLiveScoresForSport, type OddsGame, type ScoreGame } from "@/server/data/odds";
import { readFreshLiveScores, type FreshLiveScoreDeps, type LiveFeedRead } from "@/server/data/fresh-live-scores";

function scoreNumber(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// One game's state off its matched feed row; null unless the feed has it live.
export function liveStateOf(score: ScoreGame | undefined, game: { homeTeam: string; awayTeam: string }, sportKey: string): GameLiveState | null {
  if (!score || score.status !== "live") return null;
  const away = scoreNumber(teamScore(score, game.awayTeam, sportKey));
  const home = scoreNumber(teamScore(score, game.homeTeam, sportKey));
  return {
    period: typeof score.period === "number" ? score.period : null,
    clock: score.clock ?? null,
    inningHalf: score.inningHalf ?? null,
    inning: inningNumber(score.inningOrdinal),
    away,
    home,
    scoreMissing: score.scoreMissing === true || away === null || home === null,
  };
}

// Every live game on these boards, by board game id. A league whose feed can't
// be read just has no states (its started games then read as unknown progress).
export async function liveStatesForBoards(boards: { key: string; board: { odds: OddsGame[] } }[]): Promise<Map<string, GameLiveState>> {
  const out = new Map<string, GameLiveState>();
  for (const { key, board } of boards) {
    const scores = await getLiveScoresForSport(key).catch(() => [] as ScoreGame[]);
    if (scores.length === 0) continue;
    for (const game of board.odds) {
      const state = liveStateOf(matchScoreToGame(scores, game, key), game, key);
      if (state) out.set(game.id, state);
    }
  }
  return out;
}

// The Parlay Generator's read: each board's league feed no older than the max age
// (fresh-live-scores.ts), all leagues at once so the wait is one timeout at most.
export async function freshLiveFeedsForBoards(boards: { key: string }[], now: Date, deps?: FreshLiveScoreDeps): Promise<Map<string, LiveFeedRead>> {
  const keys = Array.from(new Set(boards.map((b) => b.key)));
  const reads = await Promise.all(keys.map((key) => readFreshLiveScores(key, now, deps)));
  return new Map(keys.map((key, i) => [key, reads[i]]));
}

// Every live game's state off those reads, by board game id. An UNAVAILABLE league has none.
export function liveStatesFromFeeds(boards: { key: string; board: { odds: OddsGame[] } }[], feeds: Map<string, LiveFeedRead>): Map<string, GameLiveState> {
  const out = new Map<string, GameLiveState>();
  for (const { key, board } of boards) {
    const feed = feeds.get(key);
    if (!feed || feed.kind === "UNAVAILABLE" || feed.scores.length === 0) continue;
    for (const game of board.odds) {
      const state = liveStateOf(matchScoreToGame(feed.scores, game, key), game, key);
      if (state) out.set(game.id, state);
    }
  }
  return out;
}
