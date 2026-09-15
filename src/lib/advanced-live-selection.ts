// Pure selection/fallback resolver for Advanced Live's "which game, which
// team" state. Exists as its own pure function (no React, no query-param
// parsing) so the SAME rule can be applied from two different call sites -
// the server-rendered initial page load (live/page.tsx) and the client-side
// re-check that runs on every score poll tick (advanced-live-board.tsx) -
// without duplicating the rule itself. See the investigation/spec: "one rule
// covers all three cases" (initial load with nothing selected, a sport
// switch that invalidates the old gameId, and the selected game dropping off
// the board because it went Final).
//
// The rule needs no separate "did the sport change" flag: switching sport
// produces a `sortedGameIds` list that simply doesn't contain the old
// requestedGameId, so the same "not found -> fall back to the first game"
// branch handles it identically to a game finishing mid-view. Callers must
// still explicitly OMIT the old gameId/team from a sport-switch link's
// query string (a fresh nav without them), rather than relying on this
// function to detect the switch itself - see live/page.tsx's sport tabs.
export type AdvancedLiveTeamSide = "home" | "away";

// Unconditional default - never chosen based on pick availability or any
// other heuristic, per spec.
export const DEFAULT_ADVANCED_LIVE_TEAM: AdvancedLiveTeamSide = "home";

export type AdvancedLiveSelection = {
  // null only when there is no game to select at all (empty slate).
  gameId: string | null;
  team: AdvancedLiveTeamSide;
};

export function resolveAdvancedLiveSelection(
  sortedGameIds: string[],
  requestedGameId: string | null,
  requestedTeam: string | null
): AdvancedLiveSelection {
  const gameIdIsValid = requestedGameId !== null && sortedGameIds.includes(requestedGameId);

  if (sortedGameIds.length === 0) {
    return { gameId: null, team: DEFAULT_ADVANCED_LIVE_TEAM };
  }

  const gameId = gameIdIsValid ? requestedGameId : sortedGameIds[0];

  // The requested team is honored ONLY alongside a still-valid requested
  // gameId - e.g. a compact-list row link that carries the current team
  // forward to a game that's still on the board (a deliberate, explicit
  // request; see advanced-live-game-list.tsx). Once the requested gameId
  // itself doesn't resolve - the selected game finished and dropped off the
  // board, a sport switch invalidated it, or nothing was requested at all -
  // there IS no current selection left to partially preserve: both halves
  // reset together, per "one rule covers all three cases". Without this,
  // the client-side poll-triggered re-check (advanced-live-board.tsx) would
  // carry a stale "away" forward onto the fallback game even though its own
  // game just vanished out from under it.
  const team: AdvancedLiveTeamSide = gameIdIsValid && requestedTeam === "away" ? "away" : DEFAULT_ADVANCED_LIVE_TEAM;

  return { gameId, team };
}
