// Pure rules behind the Live tab's "today and live only" game list and its single "See more"
// toggle (components/live/live-list-scope.tsx holds the React state; the filter itself is
// orderBoardGames' `todayOnly` option). Kept React-free so the server page and the tests use
// the very same functions the client does.
import { orderBoardGames } from "@/components/live/live-scoreboard-ordering";

// The toggle remembers which league it was set for. A different league always reads as
// collapsed, so a league switch resets it without any effect or explicit reset call.
export type ListScopeState = { sportKey: string; showAll: boolean };

export function resolveShowAll(state: ListScopeState, sportKey: string): boolean {
  return state.sportKey === sportKey && state.showAll;
}

type ScopedGame = { game: { id: string; commenceTime: string }; score?: { status: "preview" | "live" | "final" | "postponed" | "cancelled" | string } };

// The first render's scope for a request, resolved on the server from the same inputs the
// client uses. Collapsed by default; but a deep link (?gameId=) to a game the default scope
// hides - a later-day game inside the lookahead window - opens expanded instead of falling
// back to some other game. `gameIds` is the ordered list the initial selection resolves
// against, so the selection and the first client render agree.
export function resolveInitialScope<T extends ScopedGame>(
  games: T[],
  todayKey: string,
  requestedGameId: string | null,
  now: Date = new Date()
): { showAll: boolean; gameIds: string[] } {
  const scoped = orderBoardGames(games as never[], todayKey, now, { todayOnly: true }) as T[];
  const full = orderBoardGames(games as never[], todayKey, now) as T[];
  const hidden = requestedGameId !== null && full.some((g) => g.game.id === requestedGameId) && !scoped.some((g) => g.game.id === requestedGameId);
  return { showAll: hidden, gameIds: (hidden ? full : scoped).map((g) => g.game.id) };
}

// Whether selecting `gameId` needs the list expanded first: the game is on the full board but
// not in what the collapsed list shows. Used by every jump/click path so a hidden game is
// revealed, never silently ignored.
export function needsExpandToShow<T extends ScopedGame>(games: T[], todayKey: string, gameId: string, now: Date = new Date()): boolean {
  const scoped = orderBoardGames(games as never[], todayKey, now, { todayOnly: true }) as T[];
  if (scoped.some((g) => g.game.id === gameId)) return false;
  return (orderBoardGames(games as never[], todayKey, now) as T[]).some((g) => g.game.id === gameId);
}
