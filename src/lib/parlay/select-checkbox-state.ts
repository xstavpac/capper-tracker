// The state of Live's two slip-mode checkboxes (components/live/pick-card.tsx
// and components/parlay/target-game-checkbox.tsx). Both go by isGameOver
// (game-over.ts): a game under way can still be added (its picks are priced as
// posted); one that is final, postponed or cancelled cannot.
//
// Pure and client-safe.
import { isGameLive, isGameOver, type GameClock } from "@/lib/parlay/game-over";

export type SelectCheckboxState = { disabled: boolean; title: string };

// A pick's checkbox writes straight into the slip. A pick already in it can
// always be unchecked (removed); a new one can't be added once its game is over.
export function selectCheckboxState(game: GameClock, inPool: boolean, now: Date): SelectCheckboxState {
  if (inPool) return { disabled: false, title: "In your Parlay slip - uncheck to remove" };
  if (isGameOver(game, now)) return { disabled: true, title: "Game over" };
  if (isGameLive(game, now)) return { disabled: false, title: "Add to Parlay slip (game is live - odds may have moved)" };
  return { disabled: false, title: "Add to Parlay slip" };
}

// A game's "Target game" checkbox. A game one of your picks is on is targeted
// through the pick and can't be unchecked while the pick is in the slip; a
// game that is over can't be targeted (an already-targeted one can still be dropped).
export function targetCheckboxState(game: GameClock, targeted: boolean, viaPicks: boolean, now: Date): SelectCheckboxState & { label: string } {
  if (viaPicks) return { disabled: true, title: "Remove your picks on this game to stop targeting it", label: "Targeted via your picks" };
  if (targeted) return { disabled: false, title: "Stop targeting this game", label: "Target game" };
  if (isGameOver(game, now)) return { disabled: true, title: "Game over", label: "Target game" };
  if (isGameLive(game, now)) return { disabled: false, title: "Build from this live game - odds may have moved", label: "Target game" };
  return { disabled: false, title: "Build from this game", label: "Target game" };
}
