// The Parlay Generator's "Include live games" switch (Standard mode, section 2 Pick Filters). On, the
// default, is the generator as it was: a started game stays in the pool up to its sport's progress cutoff
// (game-progress.ts). Off: no generated leg, Hedge / Contrarian alternate or Swap row comes from a live
// game, and a targeted live game is skipped and named on the card. Slip picks are always in, live or not.
//
// "Live" is the scheduled start time passed and the game not over (isStarted): never the score feed's own
// live flag, which turns on 20+ minutes before the scheduled start.
//
// The engine side is keepsLiveGame in qualifyPick (generator.ts); this file is the copy, the request parser
// and the per-user memory, client-safe.
import { isStarted } from "@/lib/parlay/game-progress";
import type { GameClock } from "@/lib/parlay/game-over";
import type { KeyValueStore } from "@/lib/parlay/selection-mode-store";

export const INCLUDE_LIVE_LABEL = "Include live games";
export const LIVE_TARGET_NOTE = "Started — live games are off — not used.";

// Anything but a literal `false` is on: an old client, a missing field, a bad value.
export function normalizeIncludeLive(x: unknown): boolean {
  return x !== false;
}

// The switch's filter on one game. On keeps every game.
export function keepsLiveGame(includeLive: boolean, game: GameClock, now: Date): boolean {
  return includeLive || !isStarted(game, now);
}

// Per user, best-effort, the way the selection mode is remembered (selection-mode-store.ts): only "off" is
// stored, so a cleared or unreadable store reads as on.
const includeLiveKey = (userId: string) => `parlay-include-live:v1:${userId}`;

const browserStore = (): KeyValueStore | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

export function readStoredIncludeLive(userId: string, store: KeyValueStore | null = browserStore()): boolean {
  try {
    return store?.getItem(includeLiveKey(userId)) !== "0";
  } catch {
    return true;
  }
}

export function writeStoredIncludeLive(userId: string, on: boolean, store: KeyValueStore | null = browserStore()): void {
  try {
    if (on) store?.removeItem(includeLiveKey(userId));
    else store?.setItem(includeLiveKey(userId), "0");
  } catch {
    // Unavailable - the switch still holds for this visit.
  }
}
