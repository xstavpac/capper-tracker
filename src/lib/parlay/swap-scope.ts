// Which legs Hedge and Contrarian may swap (the "Swap:" control on those two
// tabs). The Primary never changes - it always keeps every slip pick as chosen;
// this only picks which of its legs the alternates are searched for.
//   SUGGESTED  - the generator-added legs only (the behavior before this setting)
//   YOUR_PICKS - the legs from your slip only
//   ALL        - any leg (the default)
// Client-safe and import-free, like gate.ts.
export type SwapScope = "SUGGESTED" | "YOUR_PICKS" | "ALL";

export const SWAP_SCOPES: readonly SwapScope[] = ["SUGGESTED", "YOUR_PICKS", "ALL"];
export const SWAP_SCOPE_DEFAULT: SwapScope = "ALL";

export const SWAP_SCOPE_OPTIONS: readonly { key: SwapScope; label: string }[] = [
  { key: "SUGGESTED", label: "Suggested" },
  { key: "YOUR_PICKS", label: "Your picks" },
  { key: "ALL", label: "All" },
];

export function normalizeSwapScope(x: unknown): SwapScope {
  return SWAP_SCOPES.includes(x as SwapScope) ? (x as SwapScope) : SWAP_SCOPE_DEFAULT;
}

// Whether a leg from the slip (or one the generator added) is swapped under `scope`.
export function inSwapScope(scope: SwapScope, source: "SLIP" | "GENERATED"): boolean {
  return scope === "ALL" || (scope === "YOUR_PICKS") === (source === "SLIP");
}

// Per-user, best-effort, apart from the slip - the same pattern as the gate.
const STORAGE_PREFIX = "parlay-swap-scope:";

export function readStoredSwapScope(userId: string): SwapScope {
  try {
    return normalizeSwapScope(window.localStorage.getItem(STORAGE_PREFIX + userId));
  } catch {
    return SWAP_SCOPE_DEFAULT;
  }
}

export function writeStoredSwapScope(userId: string, value: SwapScope): void {
  try {
    if (value === SWAP_SCOPE_DEFAULT) window.localStorage.removeItem(STORAGE_PREFIX + userId);
    else window.localStorage.setItem(STORAGE_PREFIX + userId, value);
  } catch {
    // Storage full or unavailable - the choice still holds for this visit.
  }
}
