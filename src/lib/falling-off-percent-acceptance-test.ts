// Falling off's percentage math and the card's own wording (cappers-panels.ts) - run with:
//   npx tsx src/lib/falling-off-percent-acceptance-test.ts
//
// The card shows a capper's decline as a percentage of their OWN normal win rate:
//   (recent win% - baseline win%) / baseline win%
// so 4-6 in the last 10 against a normal 58% is "−31%" (58% → 40%), and 0-10 is "−100%" whatever the
// norm. The chart line ends on that same percentage. Pure: no database. (Who is on the card, and in
// what order, is the SQL's: capper-panels-acceptance-test.ts.)
import {
  FALLING_EMPTY,
  FALLING_MIN_DECIDED,
  FALLING_REQUIREMENT,
  FALLING_SUBLABEL,
  FORM_LOOKBACK,
  TREND_MIN_BASELINE,
  TREND_RECENT,
  declinePct,
  pctLabel,
  rateShift,
  recentRate,
  trendSeries,
} from "./cappers-panels";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// `wins` wins out of 10, losses first (oldest first, like a row's `results`).
const last10 = (wins: number): boolean[] => [...Array(10 - wins).fill(false), ...Array(wins).fill(true)];

function main() {
  // The headline example: a normal 58%, then 4-6.
  check("4-6 against a normal 58%: down 31% (18 points of 58)", Math.round(declinePct(last10(4), 0.58)), -31);
  check("...labelled −31%", pctLabel(Math.round(declinePct(last10(4), 0.58))), "−31%");
  check("...with the two win rates it is made of, norm first", rateShift(last10(4), 0.58), "58% → 40%");
  check("the recent win rate is wins / decided picks", [recentRate(last10(4)), recentRate(last10(0)), recentRate(last10(10)), recentRate([])], [0.4, 0, 1, 0]);

  // 0-10 is a 100% decline from any norm.
  for (const baseline of [0.58, 0.2, 1 / 90, 0.999, 1]) {
    check(`0-10 against a normal ${(baseline * 100).toFixed(1)}%: exactly −100%`, declinePct(last10(0), baseline), -100);
    check(`...and its chart line ends on −100 [${(baseline * 100).toFixed(1)}%]`, near(trendSeries(last10(0), baseline)[10], -100), true);
  }
  check("0-10 is labelled −100%", pctLabel(Math.round(declinePct(last10(0), 0.58))), "−100%");

  // The same gap in points is a different share of a different norm.
  check("−20 points from a normal 40% is −50%; the bigger −25 points from a normal 75% is only −33%", [Math.round(declinePct(last10(2), 0.4)), Math.round(declinePct(last10(5), 0.75))], [-50, -33]);
  check("half the norm is −50% whatever the norm", [declinePct(last10(2), 0.4), declinePct(last10(4), 0.8), declinePct(last10(1), 0.2)].map((v) => Math.round(v * 1e6) / 1e6), [-50, -50, -50]);
  check("level with their norm: 0%", declinePct(last10(5), 0.5), 0);
  check("above their norm: positive", Math.round(declinePct(last10(8), 0.5)), 60);

  // A baseline of 0 has nothing to be a percentage of. No row has one; nothing divides by it either.
  check("a baseline of 0: 0%, never NaN or Infinity", [declinePct(last10(0), 0), declinePct(last10(7), 0)], [0, 0]);
  check("a baseline of 0: a flat line", trendSeries(last10(3), 0), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

  // The chart line: starts on their norm, ends on the labelled percentage.
  check("the line starts at 0, loses 10% of the norm per loss and gains (1 - norm) / norm x 10 per win", trendSeries(last10(4), 0.5), [0, -10, -20, -30, -40, -50, -60, -50, -40, -30, -20]);
  check("a normal 58%, 4-6: the line ends on the −31% of the label", Math.round(trendSeries(last10(4), 0.58)[10]), -31);
  let endsOnDecline = true;
  for (const baseline of [1 / 90, 0.2, 0.3, 0.51, 0.58, 2 / 3, 0.8, 1]) {
    for (let wins = 0; wins <= 10; wins++) {
      const line = trendSeries(last10(wins), baseline);
      if (line.length !== 11 || line[0] !== 0 || !near(line[10], declinePct(last10(wins), baseline))) endsOnDecline = false;
    }
  }
  check("every line has 11 points, starts at 0 and ends on declinePct (every record 0-10 to 10-0, eight norms)", endsOnDecline, true);
  check("the order of the picks moves the line, not where it ends", near(trendSeries(last10(4), 0.58)[10], trendSeries([true, false, true, false, true, false, true, false, false, false], 0.58)[10]), true);

  // What the card says about its own rules.
  check("the minimum is the recent picks plus the smallest baseline", [FALLING_MIN_DECIDED, TREND_RECENT + TREND_MIN_BASELINE], [40, 40]);
  check("the card states the minimum", FALLING_REQUIREMENT, "Needs 40+ decided picks");
  check("the sublabel says the baseline is UP TO the rest of the lookback, not always all of it", [FALLING_SUBLABEL, FORM_LOOKBACK - TREND_RECENT], ["Last 10 vs prior up to 90", 90]);
  check("the empty state speaks only for cappers who qualify", FALLING_EMPTY, "No qualifying capper is below their normal form.");

  console.log(failures === 0 ? "\nAll falling-off-percent checks passed." : `\n${failures} falling-off-percent check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main();
