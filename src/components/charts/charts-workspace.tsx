"use client";

import { useState } from "react";
import type { ModelVariableDef, VariableCategory } from "@/lib/model-builder";
import { getVariableSeriesAction } from "@/server/actions/charts";
import type { VariableTimeSeriesResult, DateRange } from "@/server/data/historical-variables";
import { easternDateKey } from "@/lib/dates";
import { VariableLibrary } from "@/components/model-builder/variable-library";
import { HistoricalVariableChart, type ChartSeries } from "@/components/charts/historical-variable-chart";
import { HistoryNote } from "@/components/charts/history-note";
import { DateRangePicker } from "@/components/charts/date-range-picker";

// Team stats/tendencies/custom metrics only - the only entity type with a
// fixed, known selector today (pitchers have no equivalent static catalog,
// and market variables aren't chartable yet - see historical-variables.ts).
const CHART_CATEGORIES: VariableCategory[] = ["team_tendencies", "team_stats", "custom_metric"];

const PALETTE = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#65a30d"];

type PlottedSeries = {
  id: string;
  entityId: string;
  variableId: string;
  color: string;
  result: VariableTimeSeriesResult | null;
  loading: boolean;
  error: string | null;
};

function newSeriesId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

function defaultDateRange(): DateRange {
  const end = easternDateKey(new Date());
  const start = easternDateKey(new Date(Date.now() - 30 * 86400000));
  return { start, end };
}

export function ChartsWorkspace({
  sportKey,
  teamNames,
  variables,
}: {
  sportKey: string;
  teamNames: string[];
  variables: ModelVariableDef[];
}) {
  const [entity, setEntity] = useState(teamNames[0] ?? "");
  const [series, setSeries] = useState<PlottedSeries[]>([]);
  const [dateRange, setDateRange] = useState<DateRange>(defaultDateRange);

  async function fetchSeries(entityId: string, variableId: string, range: DateRange): Promise<VariableTimeSeriesResult> {
    return getVariableSeriesAction(sportKey, variableId, entityId, undefined, range);
  }

  function addSeries(variableId: string) {
    if (!entity) return;
    // Same entity+variable already plotted - no duplicate, just leave the
    // existing one in place rather than silently stacking an identical line.
    if (series.some((s) => s.entityId === entity && s.variableId === variableId)) return;

    const id = newSeriesId();
    const color = PALETTE[series.length % PALETTE.length];
    setSeries((prev) => [...prev, { id, entityId: entity, variableId, color, result: null, loading: true, error: null }]);

    fetchSeries(entity, variableId, dateRange)
      .then((result) => {
        setSeries((prev) => prev.map((s) => (s.id === id ? { ...s, result, loading: false } : s)));
      })
      .catch(() => {
        setSeries((prev) => prev.map((s) => (s.id === id ? { ...s, loading: false, error: "Couldn't load this variable." } : s)));
      });
  }

  function removeSeries(id: string) {
    setSeries((prev) => prev.filter((s) => s.id !== id));
  }

  function handleDateRangeChange(next: DateRange) {
    setDateRange(next);
    setSeries((prev) => prev.map((s) => ({ ...s, loading: true, error: null })));
    for (const s of series) {
      fetchSeries(s.entityId, s.variableId, next)
        .then((result) => {
          setSeries((prev) => prev.map((p) => (p.id === s.id ? { ...p, result, loading: false } : p)));
        })
        .catch(() => {
          setSeries((prev) => prev.map((p) => (p.id === s.id ? { ...p, loading: false, error: "Couldn't reload this variable." } : p)));
        });
    }
  }

  const chartSeries: ChartSeries[] = series
    .filter((s) => s.result && s.result.supported)
    .map((s) => ({
      id: s.id,
      label: `${s.entityId} · ${s.result!.variableLabel}`,
      unit: s.result!.unit,
      color: s.color,
      points: s.result!.points,
    }));

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr]">
      <div className="space-y-4">
        <div className="rounded-card bg-card p-4 shadow-soft">
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Team</div>
          <select
            value={entity}
            onChange={(e) => setEntity(e.target.value)}
            className="w-full rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-foreground"
          >
            {teamNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-xs text-muted-foreground">Pick a variable below to plot it for this team.</p>
        </div>

        <VariableLibrary variables={variables} onAdd={addSeries} categories={CHART_CATEGORIES} />
      </div>

      <div className="space-y-4">
        <div className="rounded-card bg-card p-4 shadow-soft">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <DateRangePicker value={dateRange} onChange={handleDateRangeChange} />
          </div>

          {series.length === 0 ? (
            <div className="flex h-[320px] items-center justify-center rounded-card border border-dashed border-border text-sm text-muted-foreground">
              Pick a team and a variable to start charting.
            </div>
          ) : (
            <HistoricalVariableChart series={chartSeries} />
          )}
        </div>

        {series.length > 0 && (
          <div className="rounded-card bg-card p-4 shadow-soft">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Plotted variables</div>
            <div className="space-y-2">
              {series.map((s) => {
                const variable = variables.find((v) => v.id === s.variableId);
                return (
                  <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted px-3 py-2 text-sm">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
                      <span className="font-medium text-foreground">{s.entityId}</span>
                      <span className="text-muted-foreground">·</span>
                      <span className="text-muted-foreground">{variable?.label ?? s.variableId}</span>
                      {s.loading && <span className="text-xs text-muted-foreground">Loading…</span>}
                      {s.error && <span className="text-xs text-red-500 dark:text-red-400">{s.error}</span>}
                      {s.result && !s.loading && <HistoryNote result={s.result} />}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        onClick={() => removeSeries(s.id)}
                        aria-label="Remove"
                        className="rounded-md p-1 text-muted-foreground transition hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
