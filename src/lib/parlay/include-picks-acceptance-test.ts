// Proof for include-picks.ts: the Include Picks chip rules, the request
// guards, and the Pick Mix arithmetic (largest remainder, scaling, the
// stepper, a category taken off or put on). Pure - no DB. Run with:
//   npx tsx src/lib/parlay/include-picks-acceptance-test.ts
import {
  apportion,
  evenMix,
  keepsPick,
  mixChipText,
  mixCounts,
  mixCountsText,
  mixShortNote,
  mixTotal,
  reconcileMix,
  selectedCategories,
  stepPct,
  toIncludeSelection,
  toPickMix,
  toggleInclude,
} from "@/lib/parlay/include-picks";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

// ---- Chips --------------------------------------------------------------------
check("default All; All tapped again stays All", toggleInclude("ALL", "ALL"), "ALL");
check("a category tapped while All is on: only it", toggleInclude("ALL", "PROPS"), ["PROPS"]);
check("a second category adds (display order kept)", toggleInclude(["PROPS"], "MONEYLINE"), ["MONEYLINE", "PROPS"]);
check("tapping a selected category removes it", toggleInclude(["MONEYLINE", "PROPS"], "PROPS"), ["MONEYLINE"]);
check("the last one off is All again (never empty)", toggleInclude(["TOTALS"], "TOTALS"), "ALL");
check("all four on collapses to All", toggleInclude(["MONEYLINE", "SPREAD", "TOTALS"], "PROPS"), "ALL");
check("All Picks tapped with a subset on: All", toggleInclude(["SPREAD"], "ALL"), "ALL");
check("All = all four categories", selectedCategories("ALL"), ["MONEYLINE", "SPREAD", "TOTALS", "PROPS"]);

// ---- Request guard -------------------------------------------------------------
check("an array is validated and ordered", toIncludeSelection(["PROPS", "bogus", "SPREAD", "PROPS"]), ["SPREAD", "PROPS"]);
check("an empty / junk array is All", [toIncludeSelection([]), toIncludeSelection([1, "x"])], ["ALL", "ALL"]);
check("all four in a request is All", toIncludeSelection(["TOTALS", "PROPS", "SPREAD", "MONEYLINE"]), "ALL");
check("an old tab's GAME_LINES / PROPS keep their meaning", [toIncludeSelection("GAME_LINES"), toIncludeSelection("PROPS")], [["MONEYLINE", "SPREAD", "TOTALS"], ["PROPS"]]);
check("anything else is All", [toIncludeSelection(undefined), toIncludeSelection("ALL"), toIncludeSelection({})], ["ALL", "ALL", "ALL"]);

// ---- Filter -----------------------------------------------------------------------
check("All keeps an unclassified pick", keepsPick("ALL", { betType: "WINNING_MARGIN" }), true);
check("no category keeps an unclassified pick", keepsPick(["MONEYLINE", "SPREAD", "TOTALS"], { betType: "WINNING_MARGIN" }), false);
check("Totals keeps NRFI and team totals, not moneylines", [keepsPick(["TOTALS"], { betType: "NRFI" }), keepsPick(["TOTALS"], { betType: "TEAM_TOTAL" }), keepsPick(["TOTALS"], { betType: "MONEYLINE" })], [true, true, false]);

// ---- Mix arithmetic -----------------------------------------------------------------
check("7 legs at 33/33/34: largest remainder sums to 7", mixCounts(7, { MONEYLINE: 33, SPREAD: 33, TOTALS: 34 }, ["MONEYLINE", "SPREAD", "TOTALS"]), { MONEYLINE: 2, SPREAD: 2, TOTALS: 3, PROPS: 0 });
for (let legs = 1; legs <= 25; legs++) {
  const c = mixCounts(legs, { MONEYLINE: 33, SPREAD: 33, TOTALS: 34 }, ["MONEYLINE", "SPREAD", "TOTALS"]);
  if (c.MONEYLINE + c.SPREAD + c.TOTALS !== legs) check(`${legs} legs at 33/33/34 sum`, c, legs);
}
check("shares over 100 are scaled, not refused (80/60 of 7 -> 4/3)", mixCounts(7, { MONEYLINE: 80, PROPS: 60 }, ["MONEYLINE", "PROPS"]), { MONEYLINE: 4, SPREAD: 0, TOTALS: 0, PROPS: 3 });
check("shares under 100 are scaled too (20/20 of 4 -> 2/2)", mixCounts(4, { SPREAD: 20, TOTALS: 20 }, ["SPREAD", "TOTALS"]), { MONEYLINE: 0, SPREAD: 2, TOTALS: 2, PROPS: 0 });
check("apportion ties go to the earlier entry", apportion(1, [1, 1]), [1, 0]);
check("even split of 3 / 4", [evenMix(["MONEYLINE", "SPREAD", "TOTALS"]), evenMix(["MONEYLINE", "SPREAD", "TOTALS", "PROPS"])], [{ MONEYLINE: 34, SPREAD: 33, TOTALS: 33 }, { MONEYLINE: 25, SPREAD: 25, TOTALS: 25, PROPS: 25 }]);
check("total", mixTotal({ MONEYLINE: 40, TOTALS: 70 }, ["MONEYLINE", "TOTALS"]), 110);
check("stepper moves by 5 and snaps to a multiple", [stepPct(12, 1), stepPct(12, -1), stepPct(10, -1), stepPct(0, -1), stepPct(98, 1)], [15, 10, 5, 0, 100]);

// ---- Request guard for a mix ------------------------------------------------------------
check("all 0 / empty is no mix (identical to none)", [toPickMix({}, ["MONEYLINE", "PROPS"]), toPickMix({ MONEYLINE: 0, PROPS: 0 }, ["MONEYLINE", "PROPS"])], [null, null]);
check("one category: no mix", toPickMix({ PROPS: 100 }, ["PROPS"]), null);
check("only the selected categories, whole 0-100", toPickMix({ MONEYLINE: 140.4, SPREAD: 30, PROPS: -5, TOTALS: "x" }, ["MONEYLINE", "TOTALS", "PROPS"]), { MONEYLINE: 100, TOTALS: 0, PROPS: 0 });

// ---- The selection changing under a mix -------------------------------------------------
check("a category taken off: its share goes to the rest, in proportion", reconcileMix({ MONEYLINE: 40, SPREAD: 20, TOTALS: 40 }, ["MONEYLINE", "TOTALS"]), { MONEYLINE: 50, TOTALS: 50 });
check("...unequal rest", reconcileMix({ MONEYLINE: 60, SPREAD: 20, TOTALS: 20 }, ["MONEYLINE", "TOTALS"]), { MONEYLINE: 75, TOTALS: 25 });
check("a category put on takes an even share from the rest", reconcileMix({ MONEYLINE: 60, TOTALS: 40 }, ["MONEYLINE", "TOTALS", "PROPS"]), { MONEYLINE: 40, TOTALS: 27, PROPS: 33 });
check("All from two: the two new ones take 25 each", reconcileMix({ MONEYLINE: 50, PROPS: 50 }, ["MONEYLINE", "SPREAD", "TOTALS", "PROPS"]), { MONEYLINE: 25, SPREAD: 25, TOTALS: 25, PROPS: 25 });
check("down to one category: no mix", reconcileMix({ MONEYLINE: 50, PROPS: 50 }, ["PROPS"]), null);
check("a total that isn't 100 is kept", reconcileMix({ MONEYLINE: 30, SPREAD: 30, PROPS: 30 }, ["MONEYLINE", "PROPS"]), { MONEYLINE: 45, PROPS: 45 });

// ---- Text ---------------------------------------------------------------------------------
check("chip", mixChipText({ MONEYLINE: 40, TOTALS: 60 }, ["MONEYLINE", "TOTALS"]), "ML 40 · Totals 60");
check("counts line", mixCountsText(7, { MONEYLINE: 33, SPREAD: 33, TOTALS: 34 }, ["MONEYLINE", "SPREAD", "TOTALS"]), "→ 2 Moneyline · 2 Spread · 3 Totals");
check("short note", [mixShortNote("PROPS", 3, 4), mixShortNote("SPREAD", 1, 2)], ["Only 3 Props legs qualified (mix asked for 4).", "Only 1 Spread leg qualified (mix asked for 2)."]);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
