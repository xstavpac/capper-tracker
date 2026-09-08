"use client";

import { useMemo, useState } from "react";
import { VARIABLE_CATEGORY_LABELS, type ModelVariableDef, type VariableCategory } from "@/lib/model-builder";
import { groupCustomMetrics, CUSTOM_METRIC_GROUP_LABELS, type PickerDisabled } from "@/lib/custom-metric-picker";
import { CustomMetricDeleteButton } from "@/components/charts/custom-metric-delete-button";

const CATEGORY_ORDER: VariableCategory[] = ["team_tendencies", "team_stats", "pitcher_stats", "odds_market", "custom_metric"];

// `variables` is the full catalog to search/list - built-ins
// (MODEL_VARIABLES) merged with the requesting user's own custom metrics,
// assembled by the Server Component that renders this (see
// getCustomMetricVariables in server/data/custom-metrics.ts). Deliberately
// a prop, not a module-level import of MODEL_VARIABLES the way this
// component used to work - a plain constant import can never reflect one
// user's own uploaded metrics without every user's browser bundle somehow
// containing every user's data, so the merge has to happen server-side,
// per request, and flow down as a prop instead.
//
// `categories` narrows which catalog categories are offered - e.g. Charts'
// entity-first flow only has a team selector today, so it passes
// ["team_tendencies", "team_stats", "custom_metric"] (no pitcher entity
// picker yet, and odds_market isn't chartable - see historical-variables.ts).
//
// `disabledReason` lets the host workspace mark a variable un-addable in the
// current context without removing it from the list - Charts uses this so a
// season-snapshot metric shows up but can't be dropped into a line-chart
// context, and vice versa. It returns { tooltip, badge }: the row is greyed,
// the `badge` shows inline (always visible, for touch/no-hover), and the
// `tooltip` is the hover title. See custom-metric-picker.ts.
export function VariableLibrary({
  variables,
  onAdd,
  categories = CATEGORY_ORDER,
  onCustomMetricDeleted,
  disabledReason,
}: {
  variables: ModelVariableDef[];
  onAdd: (variableId: string) => void;
  categories?: VariableCategory[];
  // Called after a custom metric is deleted from the list, so the parent
  // workspace can drop any series it currently has plotted for that metric.
  onCustomMetricDeleted?: (variableId: string) => void;
  disabledReason?: (variable: ModelVariableDef) => PickerDisabled | null;
}) {
  const [query, setQuery] = useState("");

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? variables.filter((v) => v.label.toLowerCase().includes(q) || v.description.toLowerCase().includes(q))
      : variables;

    return categories
      .map((category) => ({
        category,
        variables: filtered.filter((v) => v.category === category),
      }))
      .filter((group) => group.variables.length > 0);
  }, [query, categories, variables]);

  function renderRow(variable: ModelVariableDef) {
    const disabled = disabledReason?.(variable) ?? null;
    const label = (
      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <span className="truncate">{variable.label}</span>
        {variable.category === "custom_metric" && (
          <span className="shrink-0 rounded-full bg-muted px-1.5 py-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Custom
          </span>
        )}
        {disabled && (
          <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">
            {disabled.badge}
          </span>
        )}
      </span>
    );

    // Custom metrics get an inline delete control alongside the add button -
    // so the row can't be a single <button> (no nested buttons), it becomes
    // a flex row of two controls. The delete control stays usable even when
    // the add side is disabled for the current chart context.
    if (variable.category === "custom_metric") {
      return (
        <div
          key={variable.id}
          className={
            "flex items-center justify-between rounded-lg pr-1 text-sm text-muted-foreground transition " +
            (disabled ? "opacity-50" : "hover:bg-brand-50 dark:hover:bg-brand-500/10")
          }
        >
          <button
            onClick={() => !disabled && onAdd(variable.id)}
            disabled={!!disabled}
            title={disabled?.tooltip ?? variable.description}
            className={
              "flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2.5 py-2 text-left transition " +
              (disabled ? "cursor-not-allowed" : "hover:text-brand-700 dark:hover:text-brand-400")
            }
          >
            {label}
            <span className="ml-auto shrink-0 text-lg leading-none text-muted-foreground/50">+</span>
          </button>
          <CustomMetricDeleteButton metricId={variable.id} label={variable.label} onDeleted={onCustomMetricDeleted} />
        </div>
      );
    }

    return (
      <button
        key={variable.id}
        onClick={() => !disabled && onAdd(variable.id)}
        disabled={!!disabled}
        title={disabled?.tooltip ?? variable.description}
        className={
          "flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm text-muted-foreground transition " +
          (disabled
            ? "cursor-not-allowed opacity-50"
            : "hover:bg-brand-50 hover:text-brand-700 dark:hover:bg-brand-500/10 dark:hover:text-brand-400")
        }
      >
        {label}
        <span className="text-lg leading-none text-muted-foreground/50">+</span>
      </button>
    );
  }

  function renderGroupBody(category: VariableCategory, groupVariables: ModelVariableDef[]) {
    // Custom metrics split into "Daily metrics" vs "Season snapshots" so a
    // user can't confuse the two kinds - shown only when both kinds are
    // present, otherwise the single sub-header would be noise.
    if (category === "custom_metric") {
      const { daily, snapshot } = groupCustomMetrics(groupVariables);
      if (daily.length > 0 && snapshot.length > 0) {
        return (
          <div className="space-y-3">
            {(["daily", "snapshot"] as const).map((kind) => {
              const list = kind === "daily" ? daily : snapshot;
              return (
                <div key={kind}>
                  <div className="mb-1 text-[11px] font-medium text-muted-foreground/80">{CUSTOM_METRIC_GROUP_LABELS[kind]}</div>
                  <div className="space-y-1">{list.map(renderRow)}</div>
                </div>
              );
            })}
          </div>
        );
      }
    }
    return <div className="space-y-1">{groupVariables.map(renderRow)}</div>;
  }

  return (
    <div className="rounded-card bg-card p-4 shadow-soft">
      <div className="mb-3 text-sm font-semibold text-foreground">Variables</div>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search variables..."
        className="mb-3 w-full rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-foreground outline-none focus:border-brand-400"
      />

      <div className="max-h-[640px] space-y-4 overflow-y-auto pr-1">
        {grouped.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No variables match &ldquo;{query}&rdquo;.</p>}

        {grouped.map((group) => (
          <div key={group.category}>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {VARIABLE_CATEGORY_LABELS[group.category]}
            </div>
            {renderGroupBody(group.category, group.variables)}
          </div>
        ))}
      </div>
    </div>
  );
}
