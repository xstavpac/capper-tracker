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

// Same restriction as ChartsWorkspace, same reason.
const CHART_CATEGORIES: VariableCategory[] = ["team_tendencies", "team_stats", "custom_metric"];

const PALETTE = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#65a30d"];

type TeamSlot = "A" | "B";

// One entry per (team slot, variable) - deliberately keyed by slot ("A"/"B")
// rather than by team name directly, so changing which team occupies a slot
// (see setTeam below) can find and refetch that slot's existing entries
// without needing to also know its previous team name.
type PlottedEntry = {
  slot: TeamSlot;
  variableId: string;
  color: string;
  result: VariableTimeSeriesResult | null;
  loading: boolean;
  error: string | null;
};

function defaultDateRange(): DateRange {
  const end = easternDateKey(new Date());
  const start = easternDateKey(new Date(Date.now() - 30 * 86400000));
  return { start, end };
}

type ViewMode = "overlay" | "split";

export function TeamComparisonWorkspace({
  sportKey,
  teamNames,
  variables,
}: {
  sportKey: string;
  teamNames: string[];
  variables: ModelVariableDef[];
}) {
  const [teamA, setTeamA] = useState(teamNames[0] ?? "");
  const [teamB, setTeamB] = useState(teamNames[1] ?? teamNames[0] ?? "");
  // Order of selection - the source of truth for "what's being compared".
  // Each variableId here always has exactly one PlottedEntry per slot (both
  // added/removed/refetched together, see addVariable/removeVariable below),
  // so entries never exist for a variable the user didn't explicitly pick.
  const [variableIds, setVariableIds] = useState<string[]>([]);
  const [entries, setEntries] = useState<PlottedEntry[]>([]);
  const [dateRange, setDateRange] = useState<DateRange>(defaultDateRange);
  const [view, setView] = useState<ViewMode>("overlay");

  async function fetchOne(entityId: string, variableId: string, range: DateRange): Promise<VariableTimeSeriesResult> {
    return getVariableSeriesAction(sportKey, variableId, entityId, undefined, range);
  }

  function fetchIntoSlot(slot: TeamSlot, teamId: string, variableId: string, range: DateRange) {
    fetchOne(teamId, variableId, range)
      .then((result) => {
        setEntries((prev) => prev.map((e) => (e.slot === slot && e.variableId === variableId ? { ...e, result, loading: false } : e)));
      })
      .catch(() => {
        setEntries((prev) =>
          prev.map((e) => (e.slot === slot && e.variableId === variableId ? { ...e, loading: false, error: "Couldn't load this variable." } : e))
        );
      });
  }

  // Adds one variable for BOTH teams at once - the whole point of this tool
  // is comparing the same variable across two teams, so there's no "add for
  // just one side" the way ChartsWorkspace's single-entity addSeries works.
  function addVariable(variableId: string) {
    if (!teamA || !teamB || variableIds.includes(variableId)) return;

    const color = PALETTE[variableIds.length % PALETTE.length];
    setVariableIds((prev) => [...prev, variableId]);
    setEntries((prev) => [
      ...prev,
      { slot: "A", variableId, color, result: null, loading: true, error: null },
      { slot: "B", variableId, color, result: null, loading: true, error: null },
    ]);

    fetchIntoSlot("A", teamA, variableId, dateRange);
    fetchIntoSlot("B", teamB, variableId, dateRange);
  }

  function removeVariable(variableId: string) {
    setVariableIds((prev) => prev.filter((v) => v !== variableId));
    setEntries((prev) => prev.filter((e) => e.variableId !== variableId));
  }

  // Changing which team occupies a slot re-fetches every already-selected
  // variable for the new team on that side - the other slot's entries are
  // untouched. Unlike ChartsWorkspace's single "Team" selector (which only
  // ever affects what gets added NEXT), team A/B here are a persistent
  // identity for the whole comparison: changing one shouldn't leave stale
  // series from the old team sitting next to the new one.
  function setTeam(slot: TeamSlot, teamId: string) {
    if (slot === "A") setTeamA(teamId);
    else setTeamB(teamId);
    if (!teamId) return;

    setEntries((prev) => prev.map((e) => (e.slot === slot ? { ...e, loading: true, error: null, result: null } : e)));
    for (const variableId of variableIds) {
      fetchIntoSlot(slot, teamId, variableId, dateRange);
    }
  }

  function handleDateRangeChange(next: DateRange) {
    setDateRange(next);
    setEntries((prev) => prev.map((e) => ({ ...e, loading: true, error: null })));
    for (const variableId of variableIds) {
      fetchIntoSlot("A", teamA, variableId, next);
      fetchIntoSlot("B", teamB, variableId, next);
    }
  }

  function toChartSeries(slotEntries: PlottedEntry[], teamId: string): ChartSeries[] {
    return slotEntries
      .filter((e) => e.result && e.result.supported)
      .map((e) => ({
        id: e.slot + "::" + e.variableId,
        label: `${teamId} · ${e.result!.variableLabel}`,
        unit: e.result!.unit,
        color: e.color,
        points: e.result!.points,
      }));
  }

  const entriesA = entries.filter((e) => e.slot === "A");
  const entriesB = entries.filter((e) => e.slot === "B");
  const overlaySeries = [...toChartSeries(entriesA, teamA), ...toChartSeries(entriesB, teamB)];

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr]">
      <div className="space-y-4">
        <div className="rounded-card bg-card p-4 shadow-soft">
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Team A</div>
          <select
            value={teamA}
            onChange={(e) => setTeam("A", e.target.value)}
            className="w-full rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-foreground"
          >
            {teamNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>

          <div className="mb-1.5 mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Team B</div>
          <select
            value={teamB}
            onChange={(e) => setTeam("B", e.target.value)}
            className="w-full rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-foreground"
          >
            {teamNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-xs text-muted-foreground">Pick a variable below to plot it for both teams.</p>
        </div>

        <VariableLibrary variables={variables} onAdd={addVariable} categories={CHART_CATEGORIES} />
      </div>

      <div className="space-y-4">
        <div className="rounded-card bg-card p-4 shadow-soft">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <DateRangePicker value={dateRange} onChange={handleDateRangeChange} />
            <div className="flex gap-1 rounded-full bg-muted p-1">
              {(["overlay", "split"] as ViewMode[]).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setView(mode)}
                  className={
                    "rounded-full px-3 py-1 text-xs font-medium capitalize transition " +
                    (view === mode ? "bg-card text-foreground shadow-soft" : "text-muted-foreground hover:text-foreground")
                  }
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          {variableIds.length === 0 ? (
            <div className="flex h-[320px] items-center justify-center rounded-card border border-dashed border-border text-sm text-muted-foreground">
              Pick two teams and a variable to start comparing.
            </div>
          ) : view === "overlay" ? (
            <HistoricalVariableChart series={overlaySeries} />
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <div className="mb-2 text-xs font-semibold text-foreground">{teamA || "Team A"}</div>
                <HistoricalVariableChart series={toChartSeries(entriesA, teamA)} height={280} />
              </div>
              <div>
                <div className="mb-2 text-xs font-semibold text-foreground">{teamB || "Team B"}</div>
                <HistoricalVariableChart series={toChartSeries(entriesB, teamB)} height={280} />
              </div>
            </div>
          )}
        </div>

        {variableIds.length > 0 && (
          <div className="rounded-card bg-card p-4 shadow-soft">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Plotted variables</div>
            <div className="space-y-3">
              {variableIds.map((variableId) => {
                const variable = variables.find((v) => v.id === variableId);
                const a = entriesA.find((e) => e.variableId === variableId);
                const b = entriesB.find((e) => e.variableId === variableId);
                return (
                  <div key={variableId} className="rounded-lg bg-muted px-3 py-2 text-sm">
                    <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: a?.color ?? "#999" }} />
                        <span className="font-medium text-foreground">{variable?.label ?? variableId}</span>
                      </div>
                      <button
                        onClick={() => removeVariable(variableId)}
                        aria-label="Remove"
                        className="rounded-md p-1 text-muted-foreground transition hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                      >
                        ✕
                      </button>
                    </div>
                    <div className="space-y-1 pl-[18px] text-xs">
                      {[
                        { teamId: teamA, entry: a },
                        { teamId: teamB, entry: b },
                      ].map(({ teamId, entry }) => (
                        <div key={teamId} className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
                          <span className="font-medium text-foreground">{teamId}</span>
                          {entry?.loading && <span>Loading…</span>}
                          {entry?.error && <span className="text-red-500 dark:text-red-400">{entry.error}</span>}
                          {entry?.result && !entry.loading && <HistoryNote result={entry.result} />}
                        </div>
                      ))}
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
