// The combined price of a built parlay: every leg's American odds turned into
// a decimal multiplier, multiplied together, and turned back into American
// odds at the end. Pure, client-safe, display only.
//
// - Nothing is rounded here. The product and the American odds derived from it
//   are plain floats; the format* functions below round once, when the number
//   is put on screen. Rounding each leg first compounds across 20 legs.
// - The combined American odds are never an Int: 20 legs at -110 is already
//   +41,355,297 and 20 legs at +500 is past 2^53. Pick.odds is an Int column
//   for one leg's price - this number must not be stored in one like it.
// - A leg with no usable price (odds 0 - such rows exist - or anything that
//   isn't a real American price) makes the whole parlay UNAVAILABLE. There is
//   no number to show, so none is: never Infinity, never NaN.
// - A leg whose price is the importer's -110 placeholder (oddsSource
//   DEFAULTED, lib/odds-source.ts) still combines, but the result is marked
//   `estimated`: it is a real calculation from a price nobody quoted. A leg
//   with no oddsSource at all (a pick from before that column, or a slip leg
//   saved before it was sent to the client) is unknown, not defaulted, and is
//   not marked.
import type { PickOddsSource } from "@/lib/odds-source";

export type CombineLeg = { odds: number; oddsSource?: PickOddsSource | null };

export type CombinedOdds =
  | {
      status: "AVAILABLE";
      legCount: number;
      // The product of the legs' decimal odds: what 1 unit staked returns,
      // stake included.
      decimal: number;
      // `decimal` as American odds. A float - round only to display.
      american: number;
      // True when at least one leg's price is the DEFAULTED placeholder.
      estimated: boolean;
      defaultedLegs: number;
    }
  | { status: "UNAVAILABLE"; legCount: number; unavailableLegs: number };

// American odds are at or beyond +/-100. 0 is how a missing price was stored;
// anything strictly between -100 and +100 is not a price either.
export function hasUsablePrice(odds: number): boolean {
  return Number.isFinite(odds) && Math.abs(odds) >= 100;
}

// null when the leg has no usable price.
export function americanToDecimal(odds: number): number | null {
  if (!hasUsablePrice(odds)) return null;
  return odds > 0 ? 1 + odds / 100 : 1 + 100 / -odds;
}

// Even money (decimal 2) is +100. null for anything that isn't a winning
// price (decimal must be above 1).
export function decimalToAmerican(decimal: number): number | null {
  if (!Number.isFinite(decimal) || decimal <= 1) return null;
  return decimal >= 2 ? (decimal - 1) * 100 : -100 / (decimal - 1);
}

export function combineOdds(legs: CombineLeg[]): CombinedOdds {
  const legCount = legs.length;
  const unavailableLegs = legs.filter((l) => !hasUsablePrice(l.odds)).length;
  if (legCount === 0 || unavailableLegs > 0) return { status: "UNAVAILABLE", legCount, unavailableLegs };

  let decimal = 1;
  for (const leg of legs) decimal *= americanToDecimal(leg.odds)!;
  const american = decimalToAmerican(decimal);
  // Unreachable at the 20-leg cap, but a long enough list of long enough
  // prices overflows a float - that is "unavailable", not Infinity.
  if (american === null || !Number.isFinite(american)) return { status: "UNAVAILABLE", legCount, unavailableLegs: 0 };

  const defaultedLegs = legs.filter((l) => l.oddsSource === "DEFAULTED").length;
  return { status: "AVAILABLE", legCount, decimal, american, estimated: defaultedLegs > 0, defaultedLegs };
}

// What a stake returns at these odds, stake included.
export function payoutOn(combined: Extract<CombinedOdds, { status: "AVAILABLE" }>, stake = 1): number {
  return combined.decimal * stake;
}

// ---- Display. The only rounding in this file. ----

const SCALE_WORDS = ["quadrillion", "quintillion", "sextillion", "septillion", "octillion", "nonillion", "decillion"];

// A non-negative number, readably. Up to 2^53 every whole number is exact in
// a float, so it is written out in full with separators. Past that the low
// digits are not real, so they are not printed: four significant figures and
// the scale in words ("365.6 quadrillion").
function formatMagnitude(value: number, fractionDigits: number): string {
  if (value <= Number.MAX_SAFE_INTEGER) {
    return value.toLocaleString("en-US", { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits });
  }
  const group = Math.floor(Math.log10(value) / 3);
  const word = SCALE_WORDS[group - 5];
  if (!word) return value.toExponential(3).replace("e+", " × 10^");
  return (value / 10 ** (group * 3)).toLocaleString("en-US", { maximumSignificantDigits: 4 }) + " " + word;
}

// "+41,355,297", "-110".
export function formatAmericanOdds(american: number): string {
  const rounded = Math.round(american);
  return (rounded > 0 ? "+" : "-") + formatMagnitude(Math.abs(rounded), 0);
}

// "413,553.97", "1.91".
export function formatDecimalOdds(decimal: number): string {
  return formatMagnitude(decimal, 2);
}

// "$413,554" - whole dollars once the cents stop mattering, "$1.91" below that.
export function formatPayout(payout: number): string {
  return "$" + formatMagnitude(payout, payout >= 1000 ? 0 : 2);
}
