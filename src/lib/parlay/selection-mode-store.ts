// What the Parlay Generator remembers between page loads, in localStorage and nowhere else: the
// last-used selection mode (Best / Diversified / Explore). Nothing about parlays shown is kept - the
// exposure penalty is the result card's own, in memory (generator-session.ts).
//
// Best-effort: every read and write is in try/catch. Storage that throws, is empty, or holds something
// that isn't ours reads as the default. Client-safe, no React; the storage is passed in so a test needs
// no window.
import { DEFAULT_SELECTION_MODE, SELECTION_MODES, type SelectionMode } from "@/lib/parlay/selection";

export type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const modeKey = (userId: string) => `parlay-mode:v1:${userId}`;
// The browser-kept reuse history this module used to hold (the last 10 parlays' legs, 24h). No longer read:
// readStoredMode removes it, so it doesn't sit in a user's storage forever.
export const LEGACY_REUSE_HISTORY_KEY = (userId: string) => `parlay-reuse:v1:${userId}`;

const browserStore = (): KeyValueStore | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

export function readStoredMode(userId: string, store: KeyValueStore | null = browserStore()): SelectionMode {
  try {
    store?.removeItem(LEGACY_REUSE_HISTORY_KEY(userId));
  } catch {
    // Unavailable - nothing to clean up.
  }
  try {
    const raw = store?.getItem(modeKey(userId));
    return SELECTION_MODES.find((m) => m === raw) ?? DEFAULT_SELECTION_MODE;
  } catch {
    return DEFAULT_SELECTION_MODE;
  }
}

export function writeStoredMode(userId: string, mode: SelectionMode, store: KeyValueStore | null = browserStore()): void {
  try {
    if (mode === DEFAULT_SELECTION_MODE) store?.removeItem(modeKey(userId));
    else store?.setItem(modeKey(userId), mode);
  } catch {
    // Unavailable - the mode still holds for this visit.
  }
}
