// The words and numbers the Parlay Generator's UI takes from a GeneratedParlay
// when Fill from = Your picks only builds a subset of the slip (generator.ts
// rule 6): the Total legs range and note, the result's summary line, the
// unused-picks line, and what Regenerate says and whether it is offered.
// Pure and client-safe - no engine logic here, only reading its fields.
import { MAX_PARLAY_LEGS } from "@/lib/parlay/leg-cap";
import type { DroppedSlipPick, GeneratedParlay } from "@/lib/parlay/generator";

export type NoAlternativeReason = NonNullable<GeneratedParlay["noAlternativeReason"]>;

export const ALL_PICKS_IN = "All your picks are already in this parlay";
export const NO_COMPARABLE = "No other parlays of comparable strength";
export const ANOTHER_PARLAY = "Another parlay of comparable strength";

const plural = (n: number) => (n === 1 ? "" : "s");

// The Total legs stepper. Best available: never fewer than the slip's floor (every pick goes in).
// Your picks only: from 1 - the parlay is that many of the picks. Either way never more than the
// engine says the pool can supply (`capacity`, the cap itself before a build has said).
export function legRange({ yourPicksOnly, slipFloor, capacity }: { yourPicksOnly: boolean; slipFloor: number; capacity: number }) {
  const min = yourPicksOnly ? 1 : Math.min(MAX_PARLAY_LEGS, Math.max(1, slipFloor));
  const max = Math.max(min, Math.min(MAX_PARLAY_LEGS, capacity));
  return { min, max };
}

// The note under Total legs. Your picks only: "7 of your 20 picks" (all of them when the legs
// reach the picks). Best available: the split between the picks and the cappers.
export function legsNote({
  yourPicksOnly,
  legCount,
  slipFloor,
  generatedLegs,
  usable,
  total,
}: {
  yourPicksOnly: boolean;
  legCount: number;
  slipFloor: number;
  generatedLegs: number;
  // Picks that can all be legs (engine capacity once built) and picks on the slip.
  usable: number;
  total: number;
}): string {
  const head = `Up to ${MAX_PARLAY_LEGS} · `;
  if (!yourPicksOnly) return `${head}${slipFloor} from your picks, ${generatedLegs} from your cappers.`;
  const used = Math.min(legCount, usable);
  return used >= total ? `${head}all ${total} of your pick${plural(total)}.` : `${head}${used} of your ${total} picks.`;
}

// Picks left out because Total legs is below what they could make (not_selected).
export function unusedPicks(parlay: Pick<GeneratedParlay, "dropped">): DroppedSlipPick[] {
  return parlay.dropped.filter((d) => d.reason === "not_selected");
}

export function unusedLine(n: number): string {
  return `${n} pick${plural(n)} not used this time`;
}

// "7 of your 20 picks used" when some picks were left out for Total legs; otherwise the split.
export function pickSummary(parlay: Pick<GeneratedParlay, "dropped" | "slipUsed" | "slipTotal" | "fromSlip" | "generated">): string {
  if (unusedPicks(parlay).length > 0) return `${parlay.slipUsed} of your ${parlay.slipTotal} picks used`;
  return `${parlay.fromSlip} from your picks, ${parlay.generated} generated`;
}

// Nothing to vary: every leg is one of the picks and none was left out for Total legs.
export function nothingToVary(parlay: Pick<GeneratedParlay, "legs" | "dropped">): boolean {
  return parlay.legs.length > 0 && parlay.legs.every((l) => l.source === "SLIP") && unusedPicks(parlay).length === 0;
}

// The header Regenerate's tooltip/label, and whether it is offered at all.
export function regenerateState(parlay: Pick<GeneratedParlay, "legs" | "dropped">, noAlternative: NoAlternativeReason | null): { disabled: boolean; hint: string } {
  if (nothingToVary(parlay)) return { disabled: true, hint: ALL_PICKS_IN };
  return { disabled: false, hint: noAlternative === "ALL_PICKS_USED" ? ALL_PICKS_IN : noAlternative === "NO_COMPARABLE" ? NO_COMPARABLE : ANOTHER_PARLAY };
}

// The banner after a Regenerate that couldn't vary.
export function noAlternativeText(reason: NoAlternativeReason): string {
  return reason === "ALL_PICKS_USED" ? ALL_PICKS_IN : NO_COMPARABLE;
}
