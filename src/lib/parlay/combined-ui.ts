// The words the Parlay Generator's UI shows for Fill from - above all Combined (combined-fill.ts,
// generator.ts rule 7): the Fill from helper, the mix box, the stat tiles, the Total legs note and
// the result card's rotation strip. Pure and client-safe: it only reads numbers it is given.
import { MAX_PARLAY_LEGS } from "@/lib/parlay/leg-cap";
import type { CombinedResult, FillFrom } from "@/lib/parlay/generator";

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

export const FILL_FROM_LABELS: Record<FillFrom, string> = { BEST_AVAILABLE: "Best available", COMBINED: "Combined", YOUR_PICKS_ONLY: "Your picks only" };
// Display order: Combined between the other two.
export const FILL_FROM_ORDER: readonly FillFrom[] = ["BEST_AVAILABLE", "COMBINED", "YOUR_PICKS_ONLY"];
// The hover title on Combined / Your picks only with an empty slip.
export const NEEDS_PICKS_TITLE = "Add picks from Live first";

// The helper beside Fill from. None with an empty slip (section 1 already says why).
export function fillFromHelp(fillFrom: FillFrom, slipSize: number): string | null {
  if (slipSize === 0) return null;
  if (fillFrom === "COMBINED") return "Mix your picks with the generator's best.";
  if (fillFrom === "YOUR_PICKS_ONLY") return "Builds only from your picks.";
  return "Generator picks every leg from your cappers.";
}

// Section 1's subtitle.
export const slipSubtitle = (slipSize: number): string => (slipSize === 0 ? "No picks in your slip yet" : `${plural(slipSize, "pick")} in your slip`);

// The "Your picks" stat tile's subline.
export function yourPicksSub(fillFrom: FillFrom, slipSize: number, manualSlots: number): string {
  if (slipSize === 0) return "add picks from Live";
  if (fillFrom === "COMBINED") return `${manualSlots} used per parlay · rotates`;
  if (fillFrom === "YOUR_PICKS_ONLY") return "Total legs drawn from these";
  return "not used in Best available";
}

// The "Legs" stat tile's subline.
export const legsSplitSub = (fromSlip: number, generated: number): string => `${fromSlip} from your picks · ${generated} generated`;

// The Total legs note under Combined.
export const combinedLegsNote = (manual: number, auto: number, favoritesOnly = false): string =>
  `Up to ${MAX_PARLAY_LEGS} · ${manual} from your picks, ${auto} from your ${favoritesOnly ? "favorite cappers" : "cappers"}.`;

// The mix box's pill: "30% manual · 70% auto" (whole percents that add to 100).
export function splitPercents(manual: number, total: number): { manual: number; auto: number; text: string } {
  const m = total > 0 ? Math.round((manual / total) * 100) : 0;
  return { manual: m, auto: 100 - m, text: `${m}% manual · ${100 - m}% auto` };
}

// The mix box's bottom line.
export const rotationFooter = (slipSize: number): string => `Regenerate rotates through all ${slipSize} of your picks.`;

// The result card's strip under the header.
export function rotationStrip(r: CombinedResult["rotation"]): string {
  if (r.slipSize === 0) return `Build ${r.build} of your rotation`;
  if (r.unusedLeft === 0) return `Build ${r.build} of your rotation · every pick used — next Regenerate starts the rotation again`;
  return `Build ${r.build} of your rotation · next Regenerate uses ${plural(r.nextUses, "pick")} you haven't used yet (${r.unusedLeft} left)`;
}

// The result card's header split: "3 your picks · 7 generator".
export const headerSplit = (manual: number, auto: number) => ({ manual: `${manual} your picks`, auto: `${auto} generator` });
