"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { SavedModel } from "@/server/data/models";
import type { ModelPreview, ModelTarget } from "@/server/data/model-evaluation";
import { getModelVariable, totalConditionWeight, flattenToLeaves, type ConditionLeaf, type VariableSide } from "@/lib/model-builder";
import type { ModelBuilderPrefill } from "@/lib/model-builder-links";
import { saveModelAction, deleteModelAction, previewModelAction } from "@/server/actions/models";
import { VariableLibrary } from "./variable-library";
import { ConditionBuilder } from "./condition-builder";
import { LivePreview } from "./live-preview";

type GameOption = { id: string; homeTeam: string; awayTeam: string; commenceTime: string };

const TARGET_OPTIONS: { value: ModelTarget; label: string }[] = [
  { value: "FAVORITE_ML", label: "Favorite (moneyline)" },
  { value: "UNDERDOG_ML", label: "Underdog (moneyline)" },
  { value: "OVER", label: "Over" },
  { value: "UNDER", label: "Under" },
];

function newConditionId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

const EMPTY_MODEL = { id: null as string | null, name: "Untitled model", target: "FAVORITE_ML" as ModelTarget, conditions: [] as ConditionLeaf[] };

export function ModelBuilderClient({
  sportKey,
  savedModels,
  games,
  prefillCondition,
}: {
  sportKey: string;
  savedModels: SavedModel[];
  games: GameOption[];
  prefillCondition?: ModelBuilderPrefill | null;
}) {
  const [models, setModels] = useState(savedModels);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [name, setName] = useState(EMPTY_MODEL.name);
  const [target, setTarget] = useState<ModelTarget>(EMPTY_MODEL.target);
  const [conditions, setConditions] = useState<ConditionLeaf[]>(EMPTY_MODEL.conditions);

  const [isSaving, startSaveTransition] = useTransition();
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const [selectedGameId, setSelectedGameId] = useState<string>(games[0]?.id ?? "");
  const [previewResult, setPreviewResult] = useState<{
    game: { homeTeam: string; awayTeam: string; commenceTime: string };
    preview: ModelPreview;
  } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isPreviewing, startPreviewTransition] = useTransition();

  const weightTotal = totalConditionWeight(conditions);

  function handleAddVariable(variableId: string, side?: VariableSide) {
    const variable = getModelVariable(variableId);
    const needsSide = variable?.scope === "team" || variable?.scope === "pitcher";
    setConditions((prev) => [
      ...prev,
      { type: "condition", id: newConditionId(), variableId, side: needsSide ? (side ?? "favorite") : undefined, operator: "GT", threshold: 0, weight: 0 },
    ]);
    setPreviewResult(null);
  }

  // Seeds one condition from a Charts/Slate deep link ("Add as condition" /
  // "Build a model for this game") - same handleAddVariable path a manual
  // click in the variable library uses, not a separate condition-creation
  // route. The ref (not just an empty dependency array) guards against
  // React StrictMode's deliberate double-invoke of effects in dev, which
  // otherwise adds the prefilled condition twice - confirmed live before
  // this guard was added.
  const prefillApplied = useRef(false);
  useEffect(() => {
    if (prefillApplied.current) return;
    prefillApplied.current = true;
    if (!prefillCondition) return;
    if (!getModelVariable(prefillCondition.variableId)) return;
    handleAddVariable(prefillCondition.variableId, prefillCondition.side);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleUpdateCondition(id: string, patch: Partial<ConditionLeaf>) {
    setConditions((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    setPreviewResult(null);
  }

  function handleDeleteCondition(id: string) {
    setConditions((prev) => prev.filter((c) => c.id !== id));
    setPreviewResult(null);
  }

  function resetToEmptyModel() {
    setActiveModelId(null);
    setName(EMPTY_MODEL.name);
    setTarget(EMPTY_MODEL.target);
    setConditions([]);
    setPreviewResult(null);
    setSaveMessage(null);
  }

  function handleSelectSavedModel(modelId: string) {
    if (!modelId) {
      resetToEmptyModel();
      return;
    }
    const model = models.find((m) => m.id === modelId);
    if (!model) return;
    setActiveModelId(model.id);
    setName(model.name);
    setTarget(model.target as ModelTarget);
    setConditions(flattenToLeaves(model.conditions));
    setPreviewResult(null);
    setSaveMessage(null);
  }

  function handleSave() {
    setSaveMessage(null);
    startSaveTransition(async () => {
      const result = await saveModelAction({ id: activeModelId ?? undefined, name, target, conditions });
      if (result.ok) {
        setActiveModelId(result.model.id);
        setModels((prev) => [result.model, ...prev.filter((m) => m.id !== result.model.id)]);
        setSaveMessage("Saved.");
      } else {
        setSaveMessage(result.error);
      }
    });
  }

  function handleDelete() {
    if (!activeModelId) return;
    const modelId = activeModelId;
    startSaveTransition(async () => {
      const result = await deleteModelAction(modelId);
      if (result.ok) {
        setModels((prev) => prev.filter((m) => m.id !== modelId));
        resetToEmptyModel();
      }
    });
  }

  function handleRunPreview() {
    setPreviewError(null);
    if (!selectedGameId) {
      setPreviewError("No upcoming games available to preview against.");
      return;
    }
    startPreviewTransition(async () => {
      const result = await previewModelAction({ sportKey, target, conditions, gameId: selectedGameId });
      if (result.ok) {
        setPreviewResult(result);
      } else {
        setPreviewResult(null);
        setPreviewError(result.error);
      }
    });
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-card bg-white p-4 shadow-soft">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Model name"
          className="min-w-[160px] flex-1 rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium outline-none focus:border-brand-400"
        />

        <select
          value={target}
          onChange={(e) => {
            setTarget(e.target.value as ModelTarget);
            setPreviewResult(null);
          }}
          className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
        >
          {TARGET_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              Predicts: {o.label}
            </option>
          ))}
        </select>

        <select
          value={activeModelId ?? ""}
          onChange={(e) => handleSelectSavedModel(e.target.value)}
          className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
        >
          <option value="">New model</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>

        <button
          onClick={resetToEmptyModel}
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-600 transition hover:bg-gray-50"
        >
          New
        </button>
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-50"
        >
          {isSaving ? "Saving..." : "Save"}
        </button>
        {activeModelId && (
          <button
            onClick={handleDelete}
            disabled={isSaving}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-50"
          >
            Delete
          </button>
        )}
        {saveMessage && <span className="text-sm text-gray-500">{saveMessage}</span>}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr_360px]">
        <VariableLibrary onAdd={handleAddVariable} />
        <ConditionBuilder
          conditions={conditions}
          weightTotal={weightTotal}
          onUpdate={handleUpdateCondition}
          onDelete={handleDeleteCondition}
        />
        <LivePreview
          games={games}
          selectedGameId={selectedGameId}
          onSelectGame={(id) => {
            setSelectedGameId(id);
            setPreviewResult(null);
          }}
          onRunPreview={handleRunPreview}
          previewing={isPreviewing}
          result={previewResult}
          error={previewError}
          target={target}
          conditionCount={conditions.length}
          weightTotal={weightTotal}
        />
      </div>
    </div>
  );
}
