"use client";

import { useMemo, useState } from "react";
import { MODEL_VARIABLES, VARIABLE_CATEGORY_LABELS, type VariableCategory } from "@/lib/model-builder";

const CATEGORY_ORDER: VariableCategory[] = ["team_tendencies", "team_stats", "pitcher_stats", "odds_market"];

// `categories` narrows which catalog categories are offered - e.g. Charts'
// entity-first flow only has a team selector today, so it passes just
// ["team_tendencies", "team_stats"] (no pitcher entity picker yet, and
// odds_market isn't chartable - see historical-variables.ts). Defaults to
// every category, matching the model builder's own unfiltered use.
export function VariableLibrary({
  onAdd,
  categories = CATEGORY_ORDER,
}: {
  onAdd: (variableId: string) => void;
  categories?: VariableCategory[];
}) {
  const [query, setQuery] = useState("");

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? MODEL_VARIABLES.filter((v) => v.label.toLowerCase().includes(q) || v.description.toLowerCase().includes(q))
      : MODEL_VARIABLES;

    return categories
      .map((category) => ({
        category,
        variables: filtered.filter((v) => v.category === category),
      }))
      .filter((group) => group.variables.length > 0);
  }, [query, categories]);

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
              {group.variables.map((variable) => (
                <button
                  key={variable.id}
                  onClick={() => onAdd(variable.id)}
                  title={variable.description}
                  className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm text-muted-foreground transition hover:bg-brand-50 hover:text-brand-700 dark:hover:bg-brand-500/10 dark:hover:text-brand-400"
                >
                  <span>{variable.label}</span>
                  <span className="text-lg leading-none text-muted-foreground/50 group-hover:text-brand-500">+</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
