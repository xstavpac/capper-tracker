// Which legs a Regenerate changed: the legs of the new parlay that were not on the card before it.
// Display only (the result card's arrival highlight); never part of selection.
//
// A leg is unchanged when the previous parlay had the same pick, or the same bet from another capper
// (betKeyOf, selection.ts): the card shows the same bet, so it isn't new to the user.
import type { EngineLeg } from "@/lib/parlay/generator";
import { betKeyOf } from "@/lib/parlay/selection";

const safeBetKey = (leg: EngineLeg): string | null => {
  try {
    return betKeyOf(leg.pick);
  } catch {
    return null;
  }
};

// The pickIds of `next`'s legs that differ from `previous` (the parlay the card showed, hand swaps included).
export function changedLegPickIds(previous: readonly EngineLeg[], next: readonly EngineLeg[]): Set<string> {
  const prevIds = new Set(previous.map((l) => l.pick.pickId));
  const prevKeys = new Set(previous.map(safeBetKey).filter((k): k is string => k !== null));
  const changed = new Set<string>();
  for (const leg of next) {
    if (prevIds.has(leg.pick.pickId)) continue;
    const key = safeBetKey(leg);
    if (key !== null && prevKeys.has(key)) continue;
    changed.add(leg.pick.pickId);
  }
  return changed;
}
