import { prisma } from "@/lib/prisma";
import type { CustomMetric } from "@prisma/client";
import { USER_UPLOAD, type ModelVariableDef, type VariableSport, type VariableUnit } from "@/lib/model-builder";
import type { ImportRow } from "@/lib/csv-metric-import";

function toModelVariableDef(m: CustomMetric): ModelVariableDef {
  return {
    id: m.id,
    label: m.name,
    category: "custom_metric",
    // A custom metric belongs to the sport it was uploaded under
    // (CustomMetric.sportKey). getCustomMetricVariables already filters by
    // sportKey, so this only ever carries a sport Charts supports.
    sport: m.sportKey as VariableSport,
    // Charts never actually asks a custom metric for a "side" (the
    // favorite/underdog distinction only ever mattered for the now-removed
    // model builder) - "team" is just the closest available VariableScope
    // value, used here purely for type-shape consistency, not read for
    // dispatch.
    scope: "team",
    unit: m.unit as VariableUnit,
    description: m.hasTeamColumn
      ? "Custom metric you uploaded, tracked per team."
      : "Custom metric you uploaded, applies to every team.",
    sourceId: USER_UPLOAD,
    dataScope: "per_user",
  };
}

// Every user-uploaded metric this user owns, shaped as ModelVariableDef -
// the exact same type MODEL_VARIABLES' built-in entries use, so the caller
// (charts/page.tsx) can just concatenate this with MODEL_VARIABLES and hand
// the merged array to VariableLibrary without either of them needing to
// know which entries came from where. id is the CustomMetric's own cuid
// (never collides with a built-in's short hand-picked id string), and
// sourceId is always USER_UPLOAD, which is exactly the key
// customMetricProvider is registered under in historical-variables.ts's
// PROVIDERS map.
export async function getCustomMetricVariables(userId: string, sportKey: string): Promise<ModelVariableDef[]> {
  const metrics = await prisma.customMetric.findMany({ where: { userId, sportKey }, orderBy: { createdAt: "asc" } });
  return metrics.map(toModelVariableDef);
}

// The single-metric counterpart to getCustomMetricVariables above, used by
// getHistoricalVariableSeries (historical-variables.ts) to resolve a
// variableId that getModelVariable's static built-in lookup didn't
// recognize. Ownership-scoped in the query itself (id AND userId, not just
// id) - this is what stops one user from reading another user's custom
// metric data by passing a guessed/observed CustomMetric id as variableId;
// without this check, getHistoricalVariableSeries would happily resolve and
// serve any user's metric to any other logged-in user.
export async function resolveCustomMetricVariable(userId: string, metricId: string): Promise<ModelVariableDef | null> {
  const metric = await prisma.customMetric.findFirst({ where: { id: metricId, userId } });
  return metric ? toModelVariableDef(metric) : null;
}

export type MetricImportSpec = {
  name: string;
  unit?: string;
  hasTeamColumn: boolean;
  rows: ImportRow[];
  valueColumn: string;
};

export type ImportedMetricSummary = { metricId: string; name: string; pointCount: number };

// Persists one or more confirmed metrics (see buildImportRows/
// resolveDuplicates in lib/csv-metric-import.ts for how `rows` gets here -
// already parsed, validated, and de-duplicated by the time this is called).
// Still re-validates uniqueness server-side rather than trusting the
// client's own duplicate pass - see the dedupe below - since this is the
// point real data gets written and client-side validation is never a
// substitute for it. One CustomMetric + its CustomMetricPoint rows per
// spec, in a single transaction per metric (all points for a metric land
// together or not at all).
export async function importCustomMetrics(userId: string, sportKey: string, specs: MetricImportSpec[]): Promise<ImportedMetricSummary[]> {
  const results: ImportedMetricSummary[] = [];

  for (const spec of specs) {
    // Server-side duplicate re-check, independent of whatever the client
    // already resolved - keeps the LAST row for a repeated (date, team) key,
    // same default the client-side "last" strategy uses, so this is only
    // ever a no-op safety net for well-behaved input, not a second policy.
    const byKey = new Map<string, ImportRow>();
    for (const row of spec.rows) {
      const key = row.date + "|" + (row.team ?? "");
      byKey.set(key, row);
    }

    const pointsData = [...byKey.values()]
      .filter((row) => row.values[spec.valueColumn] !== null && row.values[spec.valueColumn] !== undefined)
      .map((row) => ({
        snapshotDate: row.date,
        teamName: spec.hasTeamColumn ? row.team : null,
        value: row.values[spec.valueColumn] as number,
      }));

    const created = await prisma.customMetric.create({
      data: {
        userId,
        sportKey,
        name: spec.name,
        unit: spec.unit ?? "decimal",
        hasTeamColumn: spec.hasTeamColumn,
        points: { createMany: { data: pointsData } },
      },
    });

    results.push({ metricId: created.id, name: created.name, pointCount: pointsData.length });
  }

  return results;
}

export async function deleteCustomMetric(userId: string, metricId: string): Promise<void> {
  // deleteMany (not delete) so id+userId are both in the WHERE clause in one
  // query - CustomMetric has no compound unique on (id, userId) to target
  // with a plain delete(), same ownership-scoping pattern used everywhere
  // else in this app (see deleteCapper in server/data/cappers.ts).
  await prisma.customMetric.deleteMany({ where: { id: metricId, userId } });
}
