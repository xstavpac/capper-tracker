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
import { easeOutQuad, formatCountUpValue } from "./count-up";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

// ---- easeOutQuad: fast start, decelerating into the end - the actual
// shape that reads as "professional" rather than linear/robotic ----
check("easeOutQuad(0) starts at 0", easeOutQuad(0), 0);
check("easeOutQuad(1) ends at 1", easeOutQuad(1), 1);
check("easeOutQuad(0.5) is past the halfway point (front-loaded)", easeOutQuad(0.5) > 0.5, true);
check("easeOutQuad(0.5) exact value", easeOutQuad(0.5), 0.75);
// Deceleration: equal time steps near the end cover less ground than equal
// time steps near the start - the actual "decelerating" behavior, not just
// "greater than linear at the midpoint".
const earlyStepGain = easeOutQuad(0.2) - easeOutQuad(0.1);
const lateStepGain = easeOutQuad(1.0) - easeOutQuad(0.9);
check("a 0.1 step covers MORE ground early than the same-size step late (decelerating)", earlyStepGain > lateStepGain, true);
check("the curve is monotonically increasing (10 sample points)", (() => {
  const samples = Array.from({ length: 11 }, (_, i) => easeOutQuad(i / 10));
  return samples.every((v, i) => i === 0 || v >= samples[i - 1]);
})(), true);

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
