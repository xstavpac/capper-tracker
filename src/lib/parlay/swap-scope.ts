// Which legs the whole-parlay Hedge and Contrarian (generator.ts buildSwap,
// GeneratedParlay.hedge / .contrarian - read by the run log) may swap. Every
// scope is built with each parlay. No screen chooses one any more: the result
// card swaps one leg at a time in its Swap modal.
//   SUGGESTED  - the generator-added legs only
//   YOUR_PICKS - the legs from your slip only
//   ALL        - any leg
// Client-safe and import-free.
export type SwapScope = "SUGGESTED" | "YOUR_PICKS" | "ALL";

export const SWAP_SCOPES: readonly SwapScope[] = ["SUGGESTED", "YOUR_PICKS", "ALL"];

// Whether a leg from the slip (or one the generator added) is swapped under `scope`.
export function inSwapScope(scope: SwapScope, source: "SLIP" | "GENERATED"): boolean {
  return scope === "ALL" || (scope === "YOUR_PICKS") === (source === "SLIP");
}
