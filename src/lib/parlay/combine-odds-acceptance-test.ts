// Proof for combine-odds.ts (a built parlay's combined price). Pure: no DB.
// The 20-leg expectations are the values from the parlay-odds investigation.
// Run with:
//   npx tsx src/lib/parlay/combine-odds-acceptance-test.ts
import {
  americanToDecimal,
  combineOdds,
  decimalToAmerican,
  formatAmericanOdds,
  formatDecimalOdds,
  formatPayout,
  hasUsablePrice,
  payoutOn,
  type CombineLeg,
  type CombinedOdds,
} from "@/lib/parlay/combine-odds";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const legs = (n: number, odds: number): CombineLeg[] => Array.from({ length: n }, () => ({ odds }));
type Available = Extract<CombinedOdds, { status: "AVAILABLE" }>;
function available(c: CombinedOdds): Available {
  if (c.status !== "AVAILABLE") throw new Error("expected an available price, got " + JSON.stringify(c));
  return c;
}
// What the UI prints for a parlay: [American, decimal, payout on $1].
const shown = (c: CombinedOdds) => {
  const a = available(c);
  return [formatAmericanOdds(a.american), formatDecimalOdds(a.decimal), formatPayout(payoutOn(a))];
};
const close = (a: number, b: number) => Math.abs(a - b) <= Math.abs(b) * 1e-12;

// ---------------------------------------------------------------------
// 1. Single-leg conversions
// ---------------------------------------------------------------------
check("-110 is decimal 1.909090...", close(americanToDecimal(-110)!, 21 / 11), true);
check("+150 is decimal 2.5", americanToDecimal(150), 2.5);
check("+100 and -100 are both decimal 2", [americanToDecimal(100), americanToDecimal(-100)], [2, 2]);
check("decimal 2.5 is +150", decimalToAmerican(2.5), 150);
check("decimal 1.5 is -200", decimalToAmerican(1.5), -200);
check("decimal 2 is +100 (even money is written +100)", decimalToAmerican(2), 100);
check("decimal 1 or less is not a price", [decimalToAmerican(1), decimalToAmerican(0.5), decimalToAmerican(NaN), decimalToAmerican(Infinity)], [null, null, null, null]);

// ---------------------------------------------------------------------
// 2. The investigation's 20-leg values
// ---------------------------------------------------------------------
const m110 = available(combineOdds(legs(20, -110)));
check("20 x -110: decimal is 413,553.97 (unrounded 413553.9655...)", close(m110.decimal, (21 / 11) ** 20), true);
check("20 x -110: shown as +41,355,297 / 413,553.97 / $413,554", shown(m110), ["+41,355,297", "413,553.97", "$413,554"]);
check("20 x -110: not an estimate, nothing defaulted", [m110.estimated, m110.defaultedLegs, m110.legCount], [false, 0, 20]);

const p100 = available(combineOdds(legs(20, 100)));
check("20 x +100: decimal is exactly 2^20", p100.decimal, 1048576);
check("20 x +100: American is exactly +104,857,500", p100.american, 104857500);
check("20 x +100: shown as +104,857,500 / 1,048,576.00 / $1,048,576", shown(p100), ["+104,857,500", "1,048,576.00", "$1,048,576"]);

const p200 = available(combineOdds(legs(20, 200)));
check("20 x +200: decimal is exactly 3^20", p200.decimal, 3486784401);
check("20 x +200: American is exactly (3^20 - 1) x 100", p200.american, 348678440000);
check("20 x +200: shown in full, every digit real", shown(p200), ["+348,678,440,000", "3,486,784,401.00", "$3,486,784,401"]);

// 6^20 = 3,656,158,440,062,976 is under 2^53, so the decimal and the payout
// are exact. The American odds are 100x that - past 2^53, where a float no
// longer holds every digit - so they are shown to four figures, not with
// invented low digits.
const p500 = available(combineOdds(legs(20, 500)));
check("20 x +500: decimal is exactly 6^20", String(BigInt(p500.decimal)), String(BigInt(6) ** BigInt(20)));
check("20 x +500: American is finite and past 2^53", [Number.isFinite(p500.american), p500.american > Number.MAX_SAFE_INTEGER], [true, true]);
check("20 x +500: shown without false precision", shown(p500), ["+365.6 quadrillion", "3,656,158,440,062,976.00", "$3,656,158,440,062,976"]);
check("20 x +500: nothing shown is Infinity, NaN or exponent notation", /Infinity|NaN|e\+/.test(shown(p500).join(" ")), false);

// ---------------------------------------------------------------------
// 3. One leg is that leg
// ---------------------------------------------------------------------
for (const odds of [-110, -105, -250, 100, 135, 500, -1000, 2500]) {
  const one = available(combineOdds([{ odds }]));
  check(`1 leg at ${odds}: combined American odds are the leg's own`, [close(one.american, odds), formatAmericanOdds(one.american)], [true, (odds > 0 ? "+" : "") + odds.toLocaleString("en-US")]);
}
check("1 leg at -100: the same price, written +100", formatAmericanOdds(available(combineOdds([{ odds: -100 }])).american), "+100");
check("1 leg at -110: decimal 1.91, $1.91 on $1", shown(combineOdds([{ odds: -110 }])).slice(1), ["1.91", "$1.91"]);

// ---------------------------------------------------------------------
// 4. Mixed favorites and underdogs
// ---------------------------------------------------------------------
// -150 (5/3) x +200 (3) x -110 (21/11) = 105/11 = 9.5454... -> +854.5454...
const mixed = available(combineOdds([{ odds: -150 }, { odds: 200 }, { odds: -110 }]));
check("-150, +200, -110: decimal is 105/11", close(mixed.decimal, 105 / 11), true);
check("-150, +200, -110: shown as +855 / 9.55 / $9.55", shown(mixed), ["+855", "9.55", "$9.55"]);
check("leg order does not change the price", close(available(combineOdds([{ odds: -110 }, { odds: -150 }, { odds: 200 }])).decimal, mixed.decimal), true);
// Two heavy favorites combine to a price that is still a favorite.
// -400 (1.25) x -500 (1.2) = 1.5 -> -200.
const favs = available(combineOdds([{ odds: -400 }, { odds: -500 }]));
check("-400, -500: combined is still odds-on, -200 / 1.50 / $1.50", shown(favs), ["-200", "1.50", "$1.50"]);
// No per-leg rounding: rounding each -110 leg to 1.91 first would give 5 legs
// = 25.42 / +2,442. The real product is 25.36 / +2,436.
check("5 x -110: legs are not rounded before multiplying", shown(combineOdds(legs(5, -110))), ["+2,436", "25.36", "$25.36"]);

// ---------------------------------------------------------------------
// 5. A leg with no price
// ---------------------------------------------------------------------
check("odds 0 is not a usable price", hasUsablePrice(0), false);
check("odds 0 has no decimal", americanToDecimal(0), null);
check("one leg at 0: the parlay's price is unavailable", combineOdds([{ odds: -110 }, { odds: 0 }, { odds: 150 }]), { status: "UNAVAILABLE", legCount: 3, unavailableLegs: 1 });
check("every leg at 0: unavailable", combineOdds(legs(4, 0)), { status: "UNAVAILABLE", legCount: 4, unavailableLegs: 4 });
check("a single leg at 0: unavailable", combineOdds([{ odds: 0 }]), { status: "UNAVAILABLE", legCount: 1, unavailableLegs: 1 });
check("NaN, Infinity and sub-100 numbers are not prices either", [NaN, Infinity, -Infinity, 50, -99, 1].map(hasUsablePrice), [false, false, false, false, false, false]);
check("a NaN leg: unavailable, not NaN", combineOdds([{ odds: 120 }, { odds: NaN }]), { status: "UNAVAILABLE", legCount: 2, unavailableLegs: 1 });
check("no legs: unavailable", combineOdds([]), { status: "UNAVAILABLE", legCount: 0, unavailableLegs: 0 });
check("an unavailable price carries no number at all", Object.keys(combineOdds([{ odds: 0 }])).sort(), ["legCount", "status", "unavailableLegs"]);
// A product too big for a float is unavailable rather than Infinity.
check("overflow is unavailable, not Infinity", combineOdds(legs(400, 1000000)).status, "UNAVAILABLE");

// ---------------------------------------------------------------------
// 6. A DEFAULTED leg makes the price an estimate
// ---------------------------------------------------------------------
const withDefault = available(combineOdds([{ odds: -110, oddsSource: "DEFAULTED" }, { odds: 150, oddsSource: "STATED" }, { odds: -120, oddsSource: "MARKET" }]));
check("one DEFAULTED leg: still priced, marked an estimate", [withDefault.estimated, withDefault.defaultedLegs, withDefault.legCount], [true, 1, 3]);
check("one DEFAULTED leg: the number itself is the plain product", close(withDefault.decimal, (21 / 11) * 2.5 * (11 / 6)), true);
check("STATED and MARKET legs: not an estimate", available(combineOdds([{ odds: -110, oddsSource: "STATED" }, { odds: -110, oddsSource: "MARKET" }])).estimated, false);
check("unknown source (null or missing) is not called an estimate", available(combineOdds([{ odds: -110, oddsSource: null }, { odds: -110 }])).estimated, false);
check("a real -110 is not mistaken for the placeholder", available(combineOdds([{ odds: -110, oddsSource: "STATED" }])).estimated, false);
check("no price beats estimate: a 0 leg next to a DEFAULTED leg is unavailable", combineOdds([{ odds: 0 }, { odds: -110, oddsSource: "DEFAULTED" }]).status, "UNAVAILABLE");

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
