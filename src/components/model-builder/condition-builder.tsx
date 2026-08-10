"use client";

import {
  COMPARISON_OPERATOR_LABELS,
  getModelVariable,
  type ComparisonOperator,
  type ConditionLeaf,
  type VariableSide,
} from "@/lib/model-builder";

const OPERATORS: ComparisonOperator[] = ["LT", "LTE", "GT", "GTE", "EQ"];

function weightBadgeClass(total: number) {
  if (total === 100) return "bg-emerald-50 text-emerald-600";
  return "bg-amber-50 text-amber-600";
}

export function ConditionBuilder({
  conditions,
  weightTotal,
  onUpdate,
  onDelete,
}: {
  conditions: ConditionLeaf[];
  weightTotal: number;
  onUpdate: (id: string, patch: Partial<ConditionLeaf>) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="rounded-card bg-white p-4 shadow-soft">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-semibold text-gray-900">Model builder</div>
        <span className={"rounded-full px-2.5 py-0.5 text-xs font-medium " + weightBadgeClass(weightTotal)}>
          Total weight: {weightTotal}%{weightTotal !== 100 ? " (should be 100%)" : ""}
        </span>
      </div>

      {conditions.length === 0 ? (
        <p className="py-10 text-center text-sm text-gray-400">
          Add variables from the left panel to start building conditions.
        </p>
      ) : (
        <div className="space-y-2">
          {conditions.map((condition, index) => {
            const variable = getModelVariable(condition.variableId);
            const needsSide = variable?.scope === "team" || variable?.scope === "pitcher";

            return (
              <div key={condition.id} className="rounded-lg border border-gray-200 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-medium text-gray-500">
                    {index + 1}
                  </span>
                  <span className="flex-1 text-sm font-medium text-gray-900">{variable?.label ?? condition.variableId}</span>
                  <button
                    onClick={() => onDelete(condition.id)}
                    aria-label="Remove condition"
                    className="rounded-md p-1 text-gray-400 transition hover:bg-red-50 hover:text-red-600"
                  >
                    ✕
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {needsSide && (
                    <select
                      value={condition.side ?? "favorite"}
                      onChange={(e) => onUpdate(condition.id, { side: e.target.value as VariableSide })}
                      className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
                    >
                      <option value="favorite">Favorite</option>
                      <option value="underdog">Underdog</option>
                    </select>
                  )}

                  <select
                    value={condition.operator}
                    onChange={(e) => onUpdate(condition.id, { operator: e.target.value as ComparisonOperator })}
                    className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
                  >
                    {OPERATORS.map((op) => (
                      <option key={op} value={op}>
                        {COMPARISON_OPERATOR_LABELS[op]}
                      </option>
                    ))}
                  </select>

                  <input
                    type="number"
                    value={condition.threshold}
                    onChange={(e) => onUpdate(condition.id, { threshold: parseFloat(e.target.value) || 0 })}
                    placeholder="Threshold"
                    className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
                  />

                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={condition.weight}
                      onChange={(e) => onUpdate(condition.id, { weight: Math.max(0, Math.min(100, parseFloat(e.target.value) || 0)) })}
                      className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
                    />
                    <span className="text-xs text-gray-400">%</span>
                  </div>
                </div>

                {index < conditions.length - 1 && (
                  <div className="mt-2 text-center text-xs font-medium uppercase tracking-wide text-gray-300">and</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
