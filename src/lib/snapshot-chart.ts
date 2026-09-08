// Pure assembly of SnapshotComparisonChart's inputs from Team Comparison's
// plotted state. No React, no prisma - so the "which metrics, which bars,
// which colors, in what order" logic is unit-testable without a DOM, the
// same client-safety convention as lib/custom-metric-picker.ts.

import type { VariableUnit } from "@/lib/model-builder";

// One team's bar in a snapshot comparison - value null while the fetch is in
// flight or the team has no row for the metric.
export type SnapshotBar = { team: string; value: number | null; color: string };

// One selected snapshot metric, ready to render as a small-multiple bar
// chart: `bars` is one per team in slot order (A, B). Consumed by
// SnapshotComparisonChart.
export type SnapshotMetricSeries = {
  variableId: string;
  label: string;
  unit: VariableUnit;
  periodLabel?: string;
  bars: SnapshotBar[];
};

// The minimal slice of a resolved VariableTimeSeriesResult this needs. A
// snapshot result carries exactly one point per team (points[0]); its value
// is null / the result is absent while the fetch is in flight or the team
// has no row.
export type SnapshotResultLike = {
  unit: VariableUnit;
  periodLabel?: string;
  points: { value: number | null }[];
} | null;

export type SnapshotSlotInput = {
  team: string;
  color: string;
  // result for this (team, variable) pair
  result: SnapshotResultLike;
};

// One selected snapshot variable + its per-slot results.
export type SnapshotVariableInput = {
  variableId: string;
  label: string;
  slotA: SnapshotSlotInput;
  slotB: SnapshotSlotInput;
};

function firstValue(result: SnapshotResultLike): number | null {
  return result?.points[0]?.value ?? null;
}

// Builds one SnapshotMetricSeries per selected snapshot variable, preserving
// selection order. unit/periodLabel come from whichever slot has a result
// (they're a property of the metric, identical across teams); when neither
// slot has resolved yet the metric still appears, with null bars, so the
// chart shows its "no value" placeholder rather than the variable silently
// vanishing.
export function buildSnapshotSeries(inputs: SnapshotVariableInput[]): SnapshotMetricSeries[] {
  return inputs.map((input) => {
    const known = input.slotA.result ?? input.slotB.result;
    return {
      variableId: input.variableId,
      label: input.label,
      unit: known?.unit ?? "decimal",
      periodLabel: known?.periodLabel,
      bars: [
        { team: input.slotA.team, value: firstValue(input.slotA.result), color: input.slotA.color },
        { team: input.slotB.team, value: firstValue(input.slotB.result), color: input.slotB.color },
      ],
    };
  });
}
