// The Add to Parlay checkbox's state for one pick card (components/live/
// pick-card.tsx). A pick whose game has started - now >= its scheduled start,
// the same commenceTime the Live tab shows, never the feed's live flag - can't
// be ticked; a missing or unparseable start counts as started (hasStarted).
// Picks already on the slip keep the slip's own prune (slip-reconcile.ts).
//
// Pure and client-safe.
import { hasStarted } from "@/lib/parlay/fanduel-link";

export type SelectCheckboxState = { disabled: boolean; title: string };

export function selectCheckboxState(gameTime: string, inPool: boolean, now: Date): SelectCheckboxState {
  if (inPool) return { disabled: true, title: "Already in your Parlay slip" };
  if (hasStarted(gameTime, now)) return { disabled: true, title: "Game started" };
  return { disabled: false, title: "Add to Parlay slip" };
}
