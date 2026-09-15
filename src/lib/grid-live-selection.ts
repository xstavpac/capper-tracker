// Pure selection/fallback resolver for Grid Live's "which game is
// selected" state. Exists as its own pure function (no React, no query-param
// parsing) so the SAME rule can be applied from two different call sites -
// the server-rendered initial page load (live/page.tsx) and the client-side
// re-check that runs on every score poll tick (grid-live-board.tsx) -
// without duplicating the rule itself. See the investigation/spec: "one rule
// covers both cases" (initial load with nothing selected, and the selected
// game dropping off the board because it went Final or a sport switch
// invalidated it).
//
// The rule needs no separate "did the sport change" flag: switching sport
// produces a `sortedGameIds` list that simply doesn't contain the old
// requestedGameId, so the same "not found -> fall back to the first game"
// branch handles it identically to a game finishing mid-view. Callers must
// still explicitly OMIT the old gameId from a sport-switch link's query
// string (a fresh nav without it), rather than relying on this function to
// detect the switch itself - see live/page.tsx's sport tabs.
export type GridLiveSelection = {
  // null only when there is no game to select at all (empty slate).
  gameId: string | null;
};

export function resolveGridLiveSelection(sortedGameIds: string[], requestedGameId: string | null): GridLiveSelection {
  const gameIdIsValid = requestedGameId !== null && sortedGameIds.includes(requestedGameId);

  if (sortedGameIds.length === 0) {
    return { gameId: null };
  }

  return { gameId: gameIdIsValid ? requestedGameId : sortedGameIds[0] };
}
