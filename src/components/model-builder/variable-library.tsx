"use client";

import { useMemo, useState } from "react";
import { MODEL_VARIABLES, VARIABLE_CATEGORY_LABELS, type VariableCategory } from "@/lib/model-builder";

const CATEGORY_ORDER: VariableCategory[] = ["team_tendencies", "team_stats", "pitcher_stats", "odds_market"];

export function VariableLibrary({ onAdd }: { onAdd: (variableId: string) => void }) {
  const [query, setQuery] = useState("");

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? MODEL_VARIABLES.filter((v) => v.label.toLowerCase().includes(q) || v.description.toLowerCase().includes(q))
      : MODEL_VARIABLES;

    return CATEGORY_ORDER.map((category) => ({
      category,
      variables: filtered.filter((v) => v.category === category),
    })).filter((group) => group.variables.length > 0);
  }, [query]);

  return (
    <div className="rounded-card bg-white p-4 shadow-soft">
      <div className="mb-3 text-sm font-semibold text-gray-900">Variables</div>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search variables..."
        className="mb-3 w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-brand-400"
      />

      <div className="max-h-[640px] space-y-4 overflow-y-auto pr-1">
        {grouped.length === 0 && <p className="py-6 text-center text-sm text-gray-400">No variables match &ldquo;{query}&rdquo;.</p>}

        {grouped.map((group) => (
          <div key={group.category}>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">
              {VARIABLE_CATEGORY_LABELS[group.category]}
            </div>
            <div className="space-y-1">
              {group.variables.map((variable) => (
                <button
                  key={variable.id}
                  onClick={() => onAdd(variable.id)}
                  title={variable.description}
                  className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm text-gray-700 transition hover:bg-brand-50 hover:text-brand-700"
                >
                  <span>{variable.label}</span>
                  <span className="text-lg leading-none text-gray-300 group-hover:text-brand-500">+</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
