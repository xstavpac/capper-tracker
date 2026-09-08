// buildSnapshotSeries - assembling SnapshotComparisonChart's small-multiple
// inputs from Team Comparison's plotted state. Pure, no DB, no DOM.
// Run with:  npx tsx src/lib/snapshot-chart-acceptance-test.ts
//
// Covers the "multiple snapshot metrics plotted together for the same two
// teams" case: several metrics selected -> one series each, selection order
// preserved, each with its own two team bars and its own unit; a not-yet-
// loaded metric still appears (null bars) rather than vanishing.
//
// Exits non-zero if any assertion fails.
import { buildSnapshotSeries, type SnapshotResultLike, type SnapshotVariableInput } from "@/lib/snapshot-chart";
import type { VariableUnit } from "@/lib/model-builder";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` - expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}
function expectTrue(label: string, actual: boolean) {
  expect(label, actual, true);
}

const A = "#2563eb";
const B = "#dc2626";

function snapResult(value: number | null, unit: VariableUnit = "decimal", periodLabel = "2026 Season"): SnapshotResultLike {
  return { unit, periodLabel, points: [{ value }] };
}

function input(variableId: string, label: string, aVal: number | null, bVal: number | null, opts?: { unit?: VariableUnit; aResult?: SnapshotResultLike; bResult?: SnapshotResultLike }): SnapshotVariableInput {
  return {
    variableId,
    label,
    slotA: { team: "Arizona Diamondbacks", color: A, result: opts?.aResult !== undefined ? opts.aResult : snapResult(aVal, opts?.unit) },
    slotB: { team: "Athletics", color: B, result: opts?.bResult !== undefined ? opts.bResult : snapResult(bVal, opts?.unit) },
  };
}

// ---------------------------------------------------------------------------
// 1. Multiple metrics -> one series each, order preserved
// ---------------------------------------------------------------------------

const series = buildSnapshotSeries([
  input("v_exit", "avg_exit_velocity", 89.1, 87.4),
  input("v_hh", "hard_hit_pct", 38.2, 44.0),
  input("v_bb", "batted_balls", 1420, 1310),
]);

expect("one series per selected metric", series.length, 3);
expect("selection order preserved", series.map((s) => s.variableId), ["v_exit", "v_hh", "v_bb"]);
expect(
  "each series has exactly two team bars, slot order A then B",
  series.map((s) => s.bars.map((b) => b.team)),
  [
    ["Arizona Diamondbacks", "Athletics"],
    ["Arizona Diamondbacks", "Athletics"],
    ["Arizona Diamondbacks", "Athletics"],
  ]
);
expect("values land on the right bar", [series[0].bars[0].value, series[0].bars[1].value], [89.1, 87.4]);
expect("bar colors are the team-slot colors", [series[1].bars[0].color, series[1].bars[1].color], [A, B]);
expect("label carried through", series[2].label, "batted_balls");
expect("periodLabel carried through", series[0].periodLabel, "2026 Season");

// different metrics keep their own units (the whole reason for small
// multiples rather than one shared axis)
const mixedUnits = buildSnapshotSeries([
  input("v_xwoba", "xwoba", 0.324, 0.301, { unit: "decimal" }),
  input("v_pct", "hard_hit_pct", 38, 44, { unit: "percent" }),
]);
expect("per-metric unit preserved", mixedUnits.map((s) => s.unit), ["decimal", "percent"]);

// ---------------------------------------------------------------------------
// 2. Not-yet-loaded / missing results
// ---------------------------------------------------------------------------

const pending = buildSnapshotSeries([
  input("v1", "loaded", 10, 20),
  input("v2", "still loading", null, null, { aResult: null, bResult: null }),
]);
expect("a metric with no results yet still produces a series", pending.length, 2);
expect("...with null bars (chart shows its placeholder, metric doesn't vanish)", pending[1].bars.map((b) => b.value), [null, null]);
expect("...and falls back to a default unit", pending[1].unit, "decimal");

// one team resolved, the other not
const halfLoaded = buildSnapshotSeries([
  input("v", "half", 55, null, { bResult: null }),
]);
expect("half-loaded: known side has its value", halfLoaded[0].bars[0].value, 55);
expect("half-loaded: pending side is null", halfLoaded[0].bars[1].value, null);
expect("half-loaded: unit/period taken from whichever slot resolved", halfLoaded[0].periodLabel, "2026 Season");

// ---------------------------------------------------------------------------
// 3. Empty selection
// ---------------------------------------------------------------------------

expect("no snapshot metrics selected -> empty series list", buildSnapshotSeries([]), []);

// ---------------------------------------------------------------------------
// 4. Single metric still works (unchanged single-metric path)
// ---------------------------------------------------------------------------

const one = buildSnapshotSeries([input("v", "avg_exit_velocity", 89.1, 87.4)]);
expectTrue("single metric -> single series with two bars", one.length === 1 && one[0].bars.length === 2);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
if (failures > 0) process.exit(1);
