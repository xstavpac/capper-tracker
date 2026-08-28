"use server";

import { requireUser } from "@/server/auth";
import { importCustomMetrics, deleteCustomMetric, type MetricImportSpec, type ImportedMetricSummary } from "@/server/data/custom-metrics";

// Thin auth-gated wrapper, same pattern as getVariableSeriesAction
// (server/actions/charts.ts) - the actual write logic lives in
// server/data/custom-metrics.ts, this only adds the session check every
// other server/data/* write in this app goes through.
export async function importCustomMetricsAction(sportKey: string, specs: MetricImportSpec[]): Promise<ImportedMetricSummary[]> {
  const user = await requireUser();
  if (specs.length === 0) throw new Error("Nothing to import.");
  return importCustomMetrics(user.id, sportKey, specs);
}

export async function deleteCustomMetricAction(metricId: string): Promise<void> {
  const user = await requireUser();
  await deleteCustomMetric(user.id, metricId);
}
