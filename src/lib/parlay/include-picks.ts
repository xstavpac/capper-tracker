// The Parlay Generator's "Include Picks" filter (All Picks, or any of
// Moneyline / Spread / Totals / Props) and its Pick Mix (each selected
// category's share of the parlay). The selection rules and the share
// arithmetic live here so the controls and the engine can't disagree.
// betCategory (bet-category.ts) says which category a pick is in. Pure and
// client-safe.
//
// (pick-mix.ts is the old All / Game Lines / Props filter, still read by the
// retired auto-generate.ts / alternates.ts only.)
import { BET_CATEGORIES, BET_CATEGORY_LABELS, betCategory, type BetCategory, type BetCategoryInput } from "@/lib/parlay/bet-category";

// ---------------------------------------------------------------------------
// Include Picks
// ---------------------------------------------------------------------------
// "ALL" keeps every pick, unclassified ones included. Otherwise one to three
// categories in BET_CATEGORIES order - never none (that is All again) and
// never all four (that collapses to All).
export type IncludeSelection = "ALL" | BetCategory[];

function normalize(keys: readonly string[]): IncludeSelection {
  const picked = BET_CATEGORIES.filter((c) => keys.includes(c));
  return picked.length === 0 || picked.length === BET_CATEGORIES.length ? "ALL" : picked;
}

// What the request carried, made safe. A tab still showing the old filter
// sends "GAME_LINES" / "PROPS"; those keep meaning what they meant.
export function toIncludeSelection(value: unknown): IncludeSelection {
  if (Array.isArray(value)) return normalize(value.filter((v): v is string => typeof v === "string"));
  if (value === "GAME_LINES") return ["MONEYLINE", "SPREAD", "TOTALS"];
  if (value === "PROPS") return ["PROPS"];
  return "ALL";
}

// A chip tap. All Picks selects all; a category tapped while All is on is the
// only one selected; otherwise it toggles - and the last one off, or all four
// on, is All again.
export function toggleInclude(current: IncludeSelection, key: "ALL" | BetCategory): IncludeSelection {
  if (key === "ALL") return "ALL";
  if (current === "ALL") return [key];
  return normalize(current.includes(key) ? current.filter((c) => c !== key) : [...current, key]);
}

export function selectedCategories(selection: IncludeSelection): BetCategory[] {
  return selection === "ALL" ? [...BET_CATEGORIES] : selection;
}

export function keepsPick(selection: IncludeSelection, pick: BetCategoryInput): boolean {
  if (selection === "ALL") return true;
  const category = betCategory(pick);
  return category !== "UNCLASSIFIED" && selection.includes(category);
}

// ---------------------------------------------------------------------------
// Pick Mix
// ---------------------------------------------------------------------------
// A whole percentage per selected category. The shares needn't add up to 100:
// they are scaled to the leg count when the parlay is built (mixCounts). A
// mix needs two or more categories to mean anything.
export type PickMix = Partial<Record<BetCategory, number>>;

export const PICK_MIX_STEP = 5;

export function clampPct(n: number): number {
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0;
}

// The stepper: to the next multiple of 5 down or up (12 -> 10 / 15).
export function stepPct(pct: number, dir: 1 | -1): number {
  const rest = pct % PICK_MIX_STEP;
  return clampPct(dir === 1 ? pct - rest + PICK_MIX_STEP : rest > 0 ? pct - rest : pct - PICK_MIX_STEP);
}

// Largest remainder: `total` split in proportion to `weights` as whole numbers
// that always add up to `total`. Ties go to the earlier entry. All-zero
// weights split evenly.
export function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  const w = sum > 0 ? weights : weights.map(() => 1);
  const wSum = sum > 0 ? sum : weights.length;
  const exact = w.map((x) => (total * x) / wSum);
  const out = exact.map(Math.floor);
  let left = total - out.reduce((s, x) => s + x, 0);
  const order = exact.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i]++;
    left--;
  }
  return out;
}

export function evenMix(categories: readonly BetCategory[]): PickMix {
  const shares = apportion(100, categories.map(() => 1));
  return Object.fromEntries(categories.map((c, i) => [c, shares[i]]));
}

export function mixTotal(mix: PickMix, categories: readonly BetCategory[]): number {
  return categories.reduce((s, c) => s + (mix[c] ?? 0), 0);
}

// The mix after the selection changed: a category taken off gives its share
// to the rest, in proportion to their shares; a category put on takes an even
// share (total / n) from the rest, in proportion too. The total is kept. Fewer
// than two categories, or nothing left to share, is no mix.
export function reconcileMix(mix: PickMix, categories: readonly BetCategory[]): PickMix | null {
  if (categories.length < 2) return null;
  const total = Object.values(mix).reduce((s: number, x) => s + (x ?? 0), 0);
  if (total <= 0) return null;
  const kept = categories.filter((c) => mix[c] !== undefined);
  const keptSum = kept.reduce((s, c) => s + mix[c]!, 0);
  const evenShare = total / categories.length;
  const keptRoom = total - evenShare * (categories.length - kept.length);
  const weights = categories.map((c) =>
    mix[c] === undefined ? evenShare : keptSum > 0 ? (mix[c]! / keptSum) * keptRoom : keptRoom / kept.length
  );
  const shares = apportion(total, weights);
  return Object.fromEntries(categories.map((c, i) => [c, shares[i]]));
}

// What the request carried, made safe: whole 0-100 shares for the selected
// categories only, or null (no mix) when fewer than two are selected or every
// share is 0.
export function toPickMix(value: unknown, categories: readonly BetCategory[]): PickMix | null {
  if (typeof value !== "object" || value === null || categories.length < 2) return null;
  const raw = value as Record<string, unknown>;
  const mix: PickMix = {};
  for (const c of categories) mix[c] = typeof raw[c] === "number" ? clampPct(raw[c] as number) : 0;
  return mixTotal(mix, categories) > 0 ? mix : null;
}

// Legs per category for a parlay of `legs`: the shares scaled to 100 and
// rounded by largest remainder, so the counts always add up to `legs`.
export function mixCounts(legs: number, mix: PickMix, categories: readonly BetCategory[]): Record<BetCategory, number> {
  const counts = apportion(legs, categories.map((c) => mix[c] ?? 0));
  const out: Record<BetCategory, number> = { MONEYLINE: 0, SPREAD: 0, TOTALS: 0, PROPS: 0 };
  categories.forEach((c, i) => (out[c] = counts[i]));
  return out;
}

const SHORT_LABELS: Record<BetCategory, string> = { MONEYLINE: "ML", SPREAD: "Spread", TOTALS: "Totals", PROPS: "Props" };

// The active-mix chip: "ML 40 · Totals 60".
export function mixChipText(mix: PickMix, categories: readonly BetCategory[]): string {
  return categories.map((c) => `${SHORT_LABELS[c]} ${mix[c] ?? 0}`).join(" · ");
}

// "→ 3 Moneyline · 2 Spread · 2 Totals"
export function mixCountsText(legs: number, mix: PickMix, categories: readonly BetCategory[]): string {
  const counts = mixCounts(legs, mix, categories);
  return "→ " + categories.map((c) => `${counts[c]} ${BET_CATEGORY_LABELS[c]}`).join(" · ");
}

// A category that couldn't fill its share: "Only 3 Props legs qualified (mix asked for 4)."
export function mixShortNote(category: BetCategory, got: number, wanted: number): string {
  return `Only ${got} ${BET_CATEGORY_LABELS[category]} leg${got === 1 ? "" : "s"} qualified (mix asked for ${wanted}).`;
}
