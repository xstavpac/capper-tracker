// Fill from = Combined (generator.ts rule 7): the parlay is two pools in a user-set split -
// Manual Picks (the slip, ranked by the combined win % among themselves, exempt from every
// filter) and Auto Picks (Best available's own candidates). This file holds the pure parts the
// engine and the card share: the split (manualSlots), the Fill from defaults, and the rotation
// that walks Regenerate through every slip pick before any repeats. No engine logic here.
import { MAX_PARLAY_LEGS } from "@/lib/parlay/leg-cap";
import type { FillFrom } from "@/lib/parlay/generator";

// Where the slider starts: half the legs from your picks.
export const COMBINED_DEFAULT_SHARE = 0.5;

// The slider's range: 0..min(Total legs, slip size).
export function maxManualSlots(total: number, slipSize: number): number {
  return Math.max(0, Math.min(Math.floor(total) || 0, Math.floor(slipSize) || 0));
}

export function clampManualSlots(n: number, total: number, slipSize: number): number {
  const max = maxManualSlots(total, slipSize);
  return Number.isFinite(n) ? Math.max(0, Math.min(max, Math.round(n))) : defaultManualSlots(total, slipSize);
}

// round(Total legs x 0.5), capped at the slip size.
export function defaultManualSlots(total: number, slipSize: number): number {
  return Math.min(maxManualSlots(total, slipSize), Math.round(Math.max(0, total) * COMBINED_DEFAULT_SHARE));
}

// Total legs changed: keep roughly the same proportion, re-capped.
export function rescaleManualSlots(oldTotal: number, newTotal: number, manual: number, slipSize: number): number {
  if (!(oldTotal > 0)) return defaultManualSlots(newTotal, slipSize);
  return clampManualSlots(Math.round((newTotal * manual) / oldTotal), newTotal, slipSize);
}

// ---------------------------------------------------------------------------
// Fill from
// ---------------------------------------------------------------------------
// The options that can't be chosen: no picks - only Best available; more picks than the parlay
// cap - not Best available (it would put every pick in).
export function disabledFillFrom(slipSize: number): FillFrom[] {
  if (slipSize === 0) return ["COMBINED", "YOUR_PICKS_ONLY"];
  if (slipSize > MAX_PARLAY_LEGS) return ["BEST_AVAILABLE"];
  return [];
}

// What a choice becomes for this slip: an empty slip is Best available; over the cap, Best
// available becomes Your picks only.
export function effectiveFillFrom(slipSize: number, choice: FillFrom): FillFrom {
  if (slipSize === 0) return "BEST_AVAILABLE";
  if (slipSize > MAX_PARLAY_LEGS && choice === "BEST_AVAILABLE") return "YOUR_PICKS_ONLY";
  return choice;
}

// The default for a slip: Combined with any picks, Best available with none.
export const defaultFillFrom = (slipSize: number): FillFrom => (slipSize > 0 ? "COMBINED" : "BEST_AVAILABLE");

// The stored choice after the slip changes size: the first pick makes Combined the default;
// clearing the slip falls back to Best available. Otherwise the user's choice stays.
export function fillFromAfterSlipChange(prevSize: number, nextSize: number, current: FillFrom): FillFrom {
  if (nextSize === 0) return "BEST_AVAILABLE";
  if (prevSize === 0) return "COMBINED";
  return current;
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------
// What a Regenerate carries (generator-session.ts): the build number of the parlay on screen and
// the slip picks this rotation has used. Generate starts a new one (build 1, none used).
export type CombinedRotation = { build: number; used: string[] };

// The order manual picks are taken in: those not yet used this rotation, best first, then the
// used ones, best first (only reached when the unused run out - the cycle restarting).
export function rotationOrder<T extends { pickId: string }>(ranked: readonly T[], used: ReadonlySet<string>): T[] {
  return [...ranked.filter((p) => !used.has(p.pickId)), ...ranked.filter((p) => used.has(p.pickId))];
}

// The used set after a build took `taken`. Once every eligible pick has been used the cycle
// restarts: the picks this build took from the already-used part (the top of the new cycle) are
// its first used ones, so the next build continues from there.
export function nextRotationUsed(eligible: readonly string[], usedBefore: ReadonlySet<string>, taken: readonly string[]): Set<string> {
  const next = new Set([...Array.from(usedBefore).filter((id) => eligible.includes(id)), ...taken.filter((id) => eligible.includes(id))]);
  if (eligible.length === 0 || !eligible.every((id) => next.has(id))) return next;
  const overflow = new Set(taken.filter((id) => usedBefore.has(id)));
  return overflow.size >= eligible.length ? new Set() : overflow;
}

// The slider's setting as the user left it: `manual` legs of `total`. Total legs changing later keeps
// that proportion, always scaled from this anchor (so stepping down and back never drifts).
export type ManualSplit = { manual: number; total: number };

// The split a build uses: the slider's, scaled to Total legs; half the legs until it is moved.
export function effectiveManualSlots(split: ManualSplit | null, total: number, slipSize: number): number {
  return split ? rescaleManualSlots(split.total, total, split.manual, slipSize) : defaultManualSlots(total, slipSize);
}
