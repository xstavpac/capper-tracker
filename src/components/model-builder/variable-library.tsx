"use client";

import { useMemo, useState } from "react";
import { VARIABLE_CATEGORY_LABELS, type ModelVariableDef, type VariableCategory } from "@/lib/model-builder";
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
export function VariableLibrary({
  variables,
  onAdd,
  categories = CATEGORY_ORDER,
  onCustomMetricDeleted,
}: {
  variables: ModelVariableDef[];
  onAdd: (variableId: string) => void;
  categories?: VariableCategory[];
  // Called after a custom metric is deleted from the list, so the parent
  // workspace can drop any series it currently has plotted for that metric.
  onCustomMetricDeleted?: (variableId: string) => void;
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
            <div className="space-y-1">
              {group.variables.map((variable) => {
                const label = (
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate">{variable.label}</span>
                    {variable.category === "custom_metric" && (
                      <span className="shrink-0 rounded-full bg-muted px-1.5 py-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Custom
                      </span>
                    )}
                  </span>
                );

                // Custom metrics get an inline delete control alongside the
                // add button - so the row can't be a single <button> (no
                // nested buttons), it becomes a flex row of two controls.
                if (variable.category === "custom_metric") {
                  return (
                    <div
                      key={variable.id}
                      className="flex items-center justify-between rounded-lg pr-1 text-sm text-muted-foreground transition hover:bg-brand-50 dark:hover:bg-brand-500/10"
                    >
                      <button
                        onClick={() => onAdd(variable.id)}
                        title={variable.description}
                        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2.5 py-2 text-left transition hover:text-brand-700 dark:hover:text-brand-400"
                      >
                        {label}
                        <span className="ml-auto shrink-0 text-lg leading-none text-muted-foreground/50">+</span>
                      </button>
                      <CustomMetricDeleteButton
                        metricId={variable.id}
                        label={variable.label}
                        onDeleted={onCustomMetricDeleted}
                      />
                    </div>
                  );
                }

                return (
                  <button
                    key={variable.id}
                    onClick={() => onAdd(variable.id)}
                    title={variable.description}
                    className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm text-muted-foreground transition hover:bg-brand-50 hover:text-brand-700 dark:hover:bg-brand-500/10 dark:hover:text-brand-400"
                  >
                    {label}
                    <span className="text-lg leading-none text-muted-foreground/50">+</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
