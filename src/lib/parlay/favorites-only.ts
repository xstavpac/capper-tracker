// The Parlay Generator's "Favorites only" star (Standard mode only): generated
// legs and Hedge / Contrarian alternates come only from picks by cappers the
// user has favorited on the Cappers tab. Slip picks are always in, whatever the
// star says. The engine side is keepsFavorite in generator.ts; this file is the
// copy, the request parser and the per-user memory, client-safe and import-free.

// Anything but `true` is off: an old client, a missing field, a bad value.
export function normalizeFavoritesOnly(x: unknown): boolean {
  return x === true;
}

export const FAVORITES_STAR_LABEL = "Only use picks from my favorite cappers";
export const FAVORITES_SUBTITLE = "Only picks from your favorite cappers.";
export const NO_FAVORITES_SUBTITLE = "You haven't favorited any cappers yet.";
export const FAVORITES_EMPTY =
  "None of your favorite cappers have picks that clear these filters right now. Turn off the star, add leagues or bet types, or lower the minimum win rate.";

// Per-user, best-effort, the same way the win-rate gate is remembered (gate.ts).
const STORAGE_PREFIX = "parlay-favorites-only:";

export function readStoredFavoritesOnly(userId: string): boolean {
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + userId) === "1";
  } catch {
    return false;
  }
}

export function writeStoredFavoritesOnly(userId: string, on: boolean): void {
  try {
    if (on) window.localStorage.setItem(STORAGE_PREFIX + userId, "1");
    else window.localStorage.removeItem(STORAGE_PREFIX + userId);
  } catch {
    // Storage full or unavailable - the value still holds for this visit.
  }
}
