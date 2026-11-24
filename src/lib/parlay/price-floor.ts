// The Standard Parlay Generator's leg price floor: a generated pick priced shorter than
// GENERATED_LEG_PRICE_FLOOR (-251, -300, -500 ...) is excluded from the generator entirely:
// never a leg, never a Hedge / Contrarian alternate, never a Swap modal row in any tab (Primary,
// Hedge, Contrarian, Other games, "Below your gate"). No note. Exactly -250 is allowed.
//
//   - Your own slip picks are never capped, as they are never gated.
//   - The price judged is the pick's CURRENT one: its live price (live-price.ts, FanDuel in-play) when its
//     game has started and the listing prices it, else its posted price. A pick with a live price is capped
//     on it even when its posted price is no real price.
//   - A pick with no real price (scoring.ts priceOf: DEFAULTED, odds that aren't a price, an
//     unsourced -110 placeholder) is not capped: there is no price to judge.
//   - Record model only (generator.ts scoreModel RECORD, the default). The edge model prices
//     long favorites itself and its frozen diffs are kept as they were. Consensus Hybrid keeps
//     its own -600 floor (hybrid.ts) and doesn't read this.
// Odds don't gate or rank under the record model; this keeps very short favorites, which a win %
// favors, out of parlays (backtest: scripts/t2-harness/record-score-backtest.sql).
import { priceOf } from "@/lib/parlay/scoring";
import type { ExpanderPick } from "@/components/live/game-picks-expander";

export const GENERATED_LEG_PRICE_FLOOR = -250;

// True: the pick has a real price shorter than the floor, so the generator never offers it.
export function belowPriceFloor(pick: Pick<ExpanderPick, "betType" | "odds" | "oddsSource" | "liveOdds">, floor: number = GENERATED_LEG_PRICE_FLOOR): boolean {
  if (pick.liveOdds != null) return pick.liveOdds < floor;
  if (priceOf(pick).status === "UNKNOWN") return false;
  return pick.odds < floor;
}
