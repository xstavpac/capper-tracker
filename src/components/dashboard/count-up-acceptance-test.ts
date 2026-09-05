// Proof for the dashboard count-up animation's pure logic - run with:
//   npx tsx src/components/dashboard/count-up-acceptance-test.ts
//
// No test framework/DOM environment exists in this repo (see the 7472338
// commit referenced in parse-catalog-acceptance-test.ts), so this covers
// what's actually testable outside a browser: the easing curve and the
// per-frame number formatting CountUp.tsx's RAF loop calls on every tick.
// The RAF loop itself (and the ref-based DOM write it now does instead of
// setState - see count-up.tsx's own header comment for why) needs a real
// browser to verify smoothness in, not a unit test.
import { easeInOutQuad, formatCountUpValue } from "./count-up";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

// ---- easeInOutQuad: eases in at the start AND out at the end, so the
// motion is spread evenly across the whole duration instead of front-loaded
// into the first half (the problem with the easeOutQuad this replaced - see
// count-up.tsx's header comment). Still decelerates into the final number
// rather than snapping to a stop like pure linear would. ----
check("easeInOutQuad(0) starts at 0", easeInOutQuad(0), 0);
check("easeInOutQuad(1) ends at 1", easeInOutQuad(1), 1);
check("easeInOutQuad(0.5) lands exactly at the halfway point (not front-loaded)", easeInOutQuad(0.5), 0.5);
// Evenly spread, not front-loaded: at 20% elapsed the old easeOutQuad was
// already 36% done; this curve is only ~8% done at the same point.
check("only ~8% done at 20% elapsed (the old curve was 36% done here)", +easeInOutQuad(0.2).toFixed(2), 0.08);
check("~92% done at 80% elapsed (symmetric with the 8%-at-20% start)", +easeInOutQuad(0.8).toFixed(2), 0.92);
// Still eases OUT at the end: equal time steps late cover less ground than
// equal time steps in the exact middle (the deceleration this whole family
// of curves is chosen for).
const midStepGain = easeInOutQuad(0.6) - easeInOutQuad(0.5);
const lateStepGain = easeInOutQuad(1.0) - easeInOutQuad(0.9);
check("a step late covers LESS ground than the same-size step through the middle (still decelerating at the end)", lateStepGain < midStepGain, true);
// Still eases IN at the start too - equal-size steps right at the start
// cover less ground than the same-size step through the middle (the actual
// fix for "front-loaded"), unlike easeOutQuad where the very first step is
// the fastest one in the whole curve.
const earlyStepGain = easeInOutQuad(0.1) - easeInOutQuad(0);
check("a step right at the start covers LESS ground than the same-size step through the middle (no longer front-loaded)", earlyStepGain < midStepGain, true);
check("the curve is monotonically increasing (10 sample points)", (() => {
  const samples = Array.from({ length: 11 }, (_, i) => easeInOutQuad(i / 10));
  return samples.every((v, i) => i === 0 || v >= samples[i - 1]);
})(), true);
check("symmetric: distance covered in the first half mirrors the second half", +easeInOutQuad(0.3).toFixed(4), +(1 - easeInOutQuad(0.7)).toFixed(4));

// ---- formatCountUpValue: must format correctly at every intermediate
// frame, not just the final value - commas, decimals, sign, suffix ----
check("plain integer mid-animation frame", formatCountUpValue(1732.4, 0, false, "", true), "1,732");
check("final integer frame matches the real stat shape ('3,064')", formatCountUpValue(3064, 0, false, "", true), "3,064");
check("no commas requested", formatCountUpValue(3064, 0, false, "", false), "3064");
check("decimals preserved mid-animation, not just at the end", formatCountUpValue(-53.128, 2, false, "u", true), "-53.13u");
check("final negative-units frame matches the real stat shape ('-97.27u')", formatCountUpValue(-97.27, 2, false, "u", true), "-97.27u");
check("signed positive shows a leading '+' throughout, including 0", formatCountUpValue(0, 1, true, "%", false), "+0.0%");
check("signed positive mid-animation frame", formatCountUpValue(42.3678, 1, true, "%", false), "+42.4%");
check("negative sign wins over `signed` (never '+-')", formatCountUpValue(-12.5, 1, true, "u", true), "-12.5u");
check("large comma-grouped mid-animation frame rounds instead of truncating", formatCountUpValue(1234567.8, 0, false, "", true), "1,234,568");
check("suffix applies to every frame, not just the committed final one", formatCountUpValue(0.6, 0, false, " picks", false), "1 picks");

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
