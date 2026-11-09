// "Send to FanDuel": the Worse line chip, its "harder to win" suffix and the banner are for a link carrying two or more
// SENT legs. A one-leg bet (a 1-leg slip, or a 2-leg slip that only sent one) gets none of them; the neutral
// "Sent as X · pick Y" line stays. Pure - no DB. Run with:
//   npx tsx src/lib/parlay/fanduel-single-leg-worse-acceptance-test.ts
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type * as SendToFanDuel from "@/components/parlay/send-to-fanduel";
import type { FanDuelLegResult } from "@/lib/parlay/fanduel-link";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

const worseLeg: FanDuelLegResult = {
  pickId: "p1",
  status: "adjusted",
  reason: null,
  pickOdds: -110,
  fanDuelOdds: -110,
  sentLine: { pick: 33.5, fanDuel: 32.5, side: null, worse: true },
  warning: null,
};

async function main() {
// The component uses the classic JSX runtime, so React must be global before it loads.
(globalThis as { React?: unknown }).React = React;
const { LegLine, warnsWorseLine } = (await import("@/components/parlay/send-to-fanduel")) as typeof SendToFanDuel;
const render = (warnWorse?: boolean) => renderToStaticMarkup(React.createElement(LegLine, { leg: worseLeg, betDetail: "Team +33.5", warnWorse }));

check("1 sent leg: no warning", warnsWorseLine(1), false);
check("2 sent legs: warning", warnsWorseLine(2), true);
check("0 sent legs: nothing to warn about", warnsWorseLine(0), false);

const multi = render(true);
check("multi-leg: Worse line chip shown", multi.includes("Worse line"), true);
check("multi-leg: harder-to-win suffix shown", multi.includes("harder to win than your pick"), true);

const single = render(false);
check("single-leg: no Worse line chip", single.includes("Worse line"), false);
check("single-leg: no harder-to-win suffix", single.includes("harder to win"), false);
check("single-leg: still says what was sent", single.includes("Sent as +32.5") && single.includes("pick +33.5"), true);

check("default (prop omitted) keeps the multi-leg behaviour", render().includes("Worse line"), true);

if (failures > 0) {
  console.log(failures + " check(s) failed");
  process.exit(1);
}
console.log("all checks passed");
}
main();
