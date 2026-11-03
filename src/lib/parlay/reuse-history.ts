// What the Parlay Generator remembers between page loads, in localStorage and nowhere else:
//   - reuse history: the legs (betKeys) of the last parlays shown, so a Regenerate after a reload still
//     weighs them down (selection.ts reuse penalty). The last 10 parlays within 24 hours.
//   - the last-used selection mode (Best / Diversified / Explore).
//
// Best-effort: every read and write is in try/catch. Storage that throws, is empty, or holds something
// that isn't ours reads as nothing, and the session's in-memory history still works. Client-safe, no React;
// the storage is passed in so a test needs no window.
import { DEFAULT_SELECTION_MODE, SELECTION_MODES, type RecentLeg, type SelectionMode } from "@/lib/parlay/selection";

export type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type StoredParlay = { at: number; legs: string[] };

export const HISTORY_MAX_PARLAYS = 10;
export const HISTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_LEGS_PER_PARLAY = 40;

const historyKey = (userId: string) => `parlay-reuse:v1:${userId}`;
const modeKey = (userId: string) => `parlay-mode:v1:${userId}`;

const browserStore = (): KeyValueStore | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

// Newest first, within 24h, at most 10; anything malformed dropped.
export function trimHistory(entries: readonly StoredParlay[], nowMs: number): StoredParlay[] {
  return entries
    .filter((e) => Number.isFinite(e.at) && nowMs - e.at < HISTORY_MAX_AGE_MS && e.at <= nowMs + 60_000 && e.legs.length > 0)
    .sort((a, b) => b.at - a.at)
    .slice(0, HISTORY_MAX_PARLAYS);
}

export function readReuseHistory(userId: string, nowMs: number, store: KeyValueStore | null = browserStore()): StoredParlay[] {
  try {
    if (!store) return [];
    const raw = store.getItem(historyKey(userId));
    if (!raw) return [];
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null || (data as { v?: unknown }).v !== 1) return [];
    const list = (data as { parlays?: unknown }).parlays;
    if (!Array.isArray(list)) return [];
    const clean: StoredParlay[] = [];
    for (const e of list) {
      if (typeof e !== "object" || e === null) continue;
      const { at, legs } = e as { at?: unknown; legs?: unknown };
      if (typeof at !== "number" || !Array.isArray(legs)) continue;
      const keys = legs.filter((k): k is string => typeof k === "string" && k.length > 0 && k.length < 200).slice(0, MAX_LEGS_PER_PARLAY);
      clean.push({ at, legs: keys });
    }
    return trimHistory(clean, nowMs);
  } catch {
    return [];
  }
}

// Adds one parlay's legs at the front and writes the trimmed list back. Returns what is now stored (or, if
// the write failed, what would have been).
export function recordReuseHistory(userId: string, betKeys: readonly string[], nowMs: number, store: KeyValueStore | null = browserStore()): StoredParlay[] {
  const before = readReuseHistory(userId, nowMs, store);
  const legs = betKeys.slice(0, MAX_LEGS_PER_PARLAY);
  // The same parlay rebuilt (a setting changed and Generate reran) is one entry, not a second.
  const again = before[0] && before[0].legs.join("|") === legs.join("|");
  const next = trimHistory([{ at: nowMs, legs }, ...(again ? before.slice(1) : before)], nowMs);
  try {
    store?.setItem(historyKey(userId), JSON.stringify({ v: 1, parlays: next }));
  } catch {
    // Storage full or unavailable - the in-memory history still holds for this visit.
  }
  return next;
}

// The stored history as the engine's recentLegs, merged with the session's own: one entry per betKey, the
// latest time kept, so a leg in both is weighed down once.
export function mergeRecentLegs(session: readonly RecentLeg[], stored: readonly StoredParlay[]): RecentLeg[] {
  const latest = new Map<string, number>();
  const add = (betKey: string, at: number) => latest.set(betKey, Math.max(latest.get(betKey) ?? -Infinity, at));
  for (const l of session) add(l.betKey, l.at);
  for (const p of stored) for (const k of p.legs) add(k, p.at);
  return Array.from(latest, ([betKey, at]) => ({ betKey, at }));
}

export function readStoredMode(userId: string, store: KeyValueStore | null = browserStore()): SelectionMode {
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
