// The state of Live's two slip-mode checkboxes (components/live/pick-card.tsx
// and components/parlay/target-game-checkbox.tsx). Both read the game's
// scheduled start - now >= its commenceTime, the same one the Live tab shows,
// never the feed's live flag; a missing or unparseable start counts as started
// (hasStarted).
//
// Pure and client-safe.
import { hasStarted } from "@/lib/parlay/fanduel-link";

export type SelectCheckboxState = { disabled: boolean; title: string };

// A pick's checkbox writes straight into the slip. A pick already in it can
// always be unchecked (removed); a new one can't be added once its game started.
export function selectCheckboxState(gameTime: string, inPool: boolean, now: Date): SelectCheckboxState {
  if (inPool) return { disabled: false, title: "In your Parlay slip - uncheck to remove" };
  if (hasStarted(gameTime, now)) return { disabled: true, title: "Game started" };
  return { disabled: false, title: "Add to Parlay slip" };
}

// A game's "Target game" checkbox. A game one of your picks is on is targeted
// through the pick and can't be unchecked while the pick is in the slip; a
// started game can't be targeted (an already-targeted one can still be dropped).
export function targetCheckboxState(gameTime: string, targeted: boolean, viaPicks: boolean, now: Date): SelectCheckboxState & { label: string } {
  if (viaPicks) return { disabled: true, title: "Remove your picks on this game to stop targeting it", label: "Targeted via your picks" };
  if (targeted) return { disabled: false, title: "Stop targeting this game", label: "Target game" };
  if (hasStarted(gameTime, now)) return { disabled: true, title: "Game started", label: "Target game" };
  return { disabled: false, title: "Build from this game", label: "Target game" };
}
