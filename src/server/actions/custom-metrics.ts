"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth";
import { importCustomMetrics, deleteCustomMetric, type MetricImportSpec, type ImportedMetricSummary } from "@/server/data/custom-metrics";

export type ActionResult = { success: true } | { success: false; error: string };

// Thin auth-gated wrapper, same pattern as getVariableSeriesAction
// (server/actions/charts.ts) - the actual write logic lives in
// server/data/custom-metrics.ts, this only adds the session check every
// other server/data/* write in this app goes through.
export async function importCustomMetricsAction(sportKey: string, specs: MetricImportSpec[]): Promise<ImportedMetricSummary[]> {
  const user = await requireUser();
  if (specs.length === 0) throw new Error("Nothing to import.");
  return importCustomMetrics(user.id, sportKey, specs);
}

// Same delete-action shape as deletePickAction (server/actions/picks.ts) -
// returns a result object rather than throwing, and revalidates the one page
// that lists custom metrics so router.refresh() drops the deleted row.
// deleteCustomMetric itself is id+userId-scoped and the DB cascades its
// points (see custom-metrics.ts / the CustomMetricPoint FK).
export async function deleteCustomMetricAction(metricId: string): Promise<ActionResult> {
  const user = await requireUser();
  try {
    await deleteCustomMetric(user.id, metricId);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Something went wrong." };
  }
  revalidatePath("/charts");
  return { success: true };
}
