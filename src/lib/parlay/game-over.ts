// The one place that decides whether a game can still be on a Parlay slip.
// A game that has kicked off is LIVE, not gone: its picks stay pickable and
// priceable (at their posted price) until the game is over. Over means the
// feed says final / postponed / cancelled - or, with no feed status at all, the
// game kicked off long enough ago that it must be.
//
// Every "has this game started / is it done" test in the Parlay code goes
// through here (game-over-acceptance-test.ts fails on a stray comparison).
//
// Pure and client-safe.

export type GameFeedStatus = "preview" | "live" | "final" | "postponed" | "cancelled";

// With no feed status, a game this long past its kickoff counts as over. Longer
// than any game plus a long delay; it only matters when the score feed has no
// row for the game.
export const LIVE_WINDOW_MS = 6 * 60 * 60 * 1000;

// The id prefix of a slip pick the Live board has no game for (parlay-slip-picks.ts
// offBoardSlipPick). Its gameTime is the import time, not a kickoff, so once that
// has passed nothing says the game is live: it counts as over.
export const OFF_BOARD_GAME_PREFIX = "pick:";

export type GameClock = { gameTime: string; gameStatus?: GameFeedStatus | null; gameId?: string };

function kickoffMs(gameTime: string): number {
  return new Date(gameTime).getTime();
}

// The scheduled start has passed (the same clock the Live tab shows, never the
// feed's live flag). A missing or unparseable start counts as passed.
export function hasKickedOff(gameTime: string, now: Date): boolean {
  const start = kickoffMs(gameTime);
  return !Number.isFinite(start) || start <= now.getTime();
}

// Final, postponed or cancelled - or, with no status, past the live window.
// "preview" after kickoff is a delayed start / warmup: not over.
export function isGameOver(game: GameClock, now: Date): boolean {
  const start = kickoffMs(game.gameTime);
  if (!Number.isFinite(start)) return true;
  if (game.gameId?.startsWith(OFF_BOARD_GAME_PREFIX)) return hasKickedOff(game.gameTime, now);
  const status = game.gameStatus ?? null;
  if (status === "final" || status === "postponed" || status === "cancelled") return true;
  if (status === "live" || status === "preview") return false;
  return now.getTime() - start > LIVE_WINDOW_MS;
}

// Kicked off and not over.
export function isGameLive(game: GameClock, now: Date): boolean {
  return hasKickedOff(game.gameTime, now) && !isGameOver(game, now);
}

export const LIVE_NOTE = "Live — odds may have moved; check FanDuel.";
