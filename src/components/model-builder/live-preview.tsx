"use client";

import { formatEastern } from "@/lib/dates";
import { getModelVariable } from "@/lib/model-builder";
import type { ModelPreview, ModelTarget } from "@/server/data/model-evaluation";

type GameOption = { id: string; homeTeam: string; awayTeam: string; commenceTime: string };

const TARGET_LABELS: Record<ModelTarget, string> = {
  FAVORITE_ML: "Favorite (moneyline)",
  UNDERDOG_ML: "Underdog (moneyline)",
  OVER: "Over",
  UNDER: "Under",
};

function formatValue(variableId: string, value: number | null): string {
  if (value === null) return "—";
  const variable = getModelVariable(variableId);
  switch (variable?.unit) {
    case "percent":
      return (value * 100).toFixed(1) + "%";
    case "odds":
      return value > 0 ? "+" + value : String(value);
    case "decimal":
      return value.toFixed(3);
    case "runs":
      return (value > 0 ? "+" : "") + value.toFixed(1);
    default:
      return String(value);
  }
}

function formatPct(value: number): string {
  return (value * 100).toFixed(1) + "%";
}

export function LivePreview({
  games,
  selectedGameId,
  onSelectGame,
  onRunPreview,
  previewing,
  result,
  error,
  target,
  conditionCount,
  weightTotal,
}: {
  games: GameOption[];
  selectedGameId: string;
  onSelectGame: (id: string) => void;
  onRunPreview: () => void;
  previewing: boolean;
  result: { game: { homeTeam: string; awayTeam: string; commenceTime: string }; preview: ModelPreview } | null;
  error: string | null;
  target: ModelTarget;
  conditionCount: number;
  weightTotal: number;
}) {
  return (
    <div className="rounded-card bg-white p-4 shadow-soft">
      <div className="mb-3 text-sm font-semibold text-gray-900">Live preview</div>

      <div className="mb-3 flex gap-2">
        <select
          value={selectedGameId}
          onChange={(e) => onSelectGame(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
        >
          {games.length === 0 && <option value="">No upcoming games</option>}
          {games.map((g) => (
            <option key={g.id} value={g.id}>
              {g.awayTeam} @ {g.homeTeam} · {formatEastern(new Date(g.commenceTime), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
            </option>
          ))}
        </select>
        <button
          onClick={onRunPreview}
          disabled={previewing || conditionCount === 0 || !selectedGameId}
          className="shrink-0 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {previewing ? "Running..." : "Run"}
        </button>
      </div>

      {error && <div className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-600">{error}</div>}

      {!result && !error && (
        <p className="py-8 text-center text-sm text-gray-400">
          {conditionCount === 0 ? "Add conditions, then run a preview." : "Select a game and click Run."}
        </p>
      )}

      {result && (
        <div className="space-y-4">
          <div>
            <div className="text-sm font-medium text-gray-900">
              {result.game.awayTeam} @ {result.game.homeTeam}
            </div>
            <div className="text-xs text-gray-400">
              {formatEastern(new Date(result.game.commenceTime), { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
            </div>
          </div>

          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">Conditions</div>
            <div className="space-y-1">
              {result.preview.conditionResults.map((r) => (
                <div key={r.conditionId} className="flex items-center justify-between text-sm">
                  <span className="text-gray-600">{r.variableLabel}</span>
                  <span className={"font-medium " + (r.actual === null ? "text-gray-300" : r.passed ? "text-emerald-600" : "text-red-500")}>
                    {r.actual === null ? "no data" : formatValue(r.variableId, r.actual)}
                  </span>
                </div>
              ))}
            </div>
            {!result.preview.allConditionsMet && (
              <p className="mt-1.5 text-xs text-amber-600">Not all conditions are met for this game.</p>
            )}
          </div>

          {result.preview.edge && (
            <div className="rounded-lg bg-brand-50 p-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-600">Your model</span>
                <span className="font-semibold text-gray-900">{formatPct(result.preview.edge.modelWinRate)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-600">Market odds ({TARGET_LABELS[target]})</span>
                <span className="font-semibold text-gray-900">{formatPct(result.preview.edge.marketImpliedProbability)}</span>
              </div>
              <div className="mt-1 flex items-center justify-between border-t border-brand-100 pt-1.5 text-sm">
                <span className="font-medium text-gray-700">Edge</span>
                <span className={"font-semibold " + (result.preview.edge.edge >= 0 ? "text-emerald-600" : "text-red-500")}>
                  {result.preview.edge.edge >= 0 ? "+" : ""}
                  {(result.preview.edge.edge * 100).toFixed(1)}%
                </span>
              </div>
            </div>
          )}

          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">Model summary</div>
            <div className="grid grid-cols-3 gap-2 text-center text-sm">
              <div className="rounded-lg bg-gray-50 p-2">
                <div className="font-semibold text-gray-900">{conditionCount}</div>
                <div className="text-xs text-gray-400">Variables</div>
              </div>
              <div className="rounded-lg bg-gray-50 p-2">
                <div className="font-semibold text-gray-900">{weightTotal}%</div>
                <div className="text-xs text-gray-400">Total weight</div>
              </div>
              <div className="rounded-lg bg-gray-50 p-2">
                <div className="font-semibold text-gray-900">{conditionCount}</div>
                <div className="text-xs text-gray-400">Conditions</div>
              </div>
            </div>
          </div>

          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">Model health</div>
            <ModelHealthPanel health={result.preview.health} />
          </div>
        </div>
      )}
    </div>
  );
}

function ModelHealthPanel({ health }: { health: ModelPreview["health"] }) {
  if (health.status === "ready") {
    return (
      <div className="rounded-lg bg-gray-50 p-3 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-gray-600">Sample size</span>
          <span className="font-medium text-gray-900">{health.sampleSize} games</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-gray-600">Est. win rate</span>
          <span className="font-medium text-gray-900">{formatPct(health.historicalWinRate)}</span>
        </div>
      </div>
    );
  }

  if (health.status === "insufficient_sample") {
    return (
      <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-700">
        Not enough historical data yet ({health.sampleSize} matching game{health.sampleSize === 1 ? "" : "s"} found,
        10 needed).
      </div>
    );
  }

  return <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-700">{health.reason}</div>;
}
