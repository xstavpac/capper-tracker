// Pure grouping + eligibility rules for custom metrics in the Charts variable
// picker. No prisma, no React - the same client-safety convention as
// lib/model-builder.ts and lib/csv-metric-import.ts, so VariableLibrary and
// both workspaces can share one source of truth for "which bucket does this
// metric go in" and "can it be added in this context".
//
// Why this exists as its own module: daily and snapshot custom metrics must
// never end up plotted on the same chart (a line series and a bar comparison
// can't share axes), and a snapshot can't be plotted in the single-team
// "Team Stats" mode at all (it's a two-team comparison by construction). The
// picker enforces both by DISABLING the ineligible rows with an explanatory
// tooltip rather than hiding them, so the metric a user just uploaded never
// silently vanishes from the list.
import type { ModelVariableDef } from "@/lib/model-builder";

export type MetricKind = "daily" | "snapshot";

// A custom metric's kind, treating "not set" as daily (every built-in, and
// every custom metric imported before the snapshot kind existed).
export function metricKindOf(variable: Pick<ModelVariableDef, "metricKind">): MetricKind {
  return variable.metricKind === "snapshot" ? "snapshot" : "daily";
}

export type CustomMetricGroups = {
  daily: ModelVariableDef[];
  snapshot: ModelVariableDef[];
};

// Splits a list of custom_metric variables into the two picker sub-groups,
// each preserving the input order. Callers pass only the custom_metric slice
// (VariableLibrary already groups by category first).
export function groupCustomMetrics(variables: ModelVariableDef[]): CustomMetricGroups {
  const daily: ModelVariableDef[] = [];
  const snapshot: ModelVariableDef[] = [];
  for (const v of variables) {
    if (metricKindOf(v) === "snapshot") snapshot.push(v);
    else daily.push(v);
  }
  return { daily, snapshot };
}

export const CUSTOM_METRIC_GROUP_LABELS: Record<MetricKind, string> = {
  daily: "Daily metrics",
  snapshot: "Season snapshots",
};

export type PickerContext = {
  // Which Charts tool the picker is rendered inside.
  mode: "single" | "compare";
  // Kinds of the variables currently plotted in that tool.
  plottedKinds: MetricKind[];
  // The variable ids currently plotted - so "another snapshot is already
  // plotted" doesn't also disable the one that IS plotted (it must stay
  // clickable to toggle off).
  plottedVariableIds: string[];
};

// Returns a human tooltip reason the variable can't be added in this context,
// or null when it's fine. Only ever restricts custom metrics - a built-in
// (metricKind undefined -> "daily") in a daily-only context always returns
// null, so built-in behavior is completely unchanged.
export function pickerDisabledReason(variable: ModelVariableDef, ctx: PickerContext): string | null {
  const kind = metricKindOf(variable);
  const alreadyPlotted = ctx.plottedVariableIds.includes(variable.id);
  if (alreadyPlotted) return null;

  if (kind === "snapshot" && ctx.mode === "single") {
    return "Season snapshots compare two teams — switch to Team Comparison to plot this.";
  }

  const hasDaily = ctx.plottedKinds.includes("daily");
  const hasSnapshot = ctx.plottedKinds.includes("snapshot");

  if (kind === "snapshot" && hasDaily) {
    return "Remove the daily metric first — a season snapshot renders as its own bar comparison.";
  }
  if (kind === "daily" && hasSnapshot) {
    return "Remove the season snapshot first — it can't share a chart with a time-series line.";
  }
  if (kind === "snapshot" && hasSnapshot) {
    return "Only one season snapshot can be compared at a time.";
  }
  return null;
}
