"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth";
import { createUserModel, updateUserModel, deleteUserModel, type SavedModel } from "@/server/data/models";
import { getOddsForSport, getLiveScoresForSport, matchScoreToGame } from "@/server/data/odds";
import { buildGameContext, previewModel, type ModelTarget, type ModelPreview } from "@/server/data/model-evaluation";
import { getModelVariable, wrapFlatConditions, type ConditionLeaf } from "@/lib/model-builder";
import type { ModelTarget as PrismaModelTarget } from "@prisma/client";

// Simple mode's UI only ever edits a flat leaf array - it's wrapped into a
// ConditionTree (a single root AND-group) right before hitting storage/the
// evaluation engine, both of which speak the tree shape uniformly so a
// future Advanced mode is a new UI layer over the same save path and engine.
export type SaveModelInput = {
  id?: string;
  name: string;
  target: ModelTarget;
  conditions: ConditionLeaf[];
};

export type SaveModelResult = { ok: true; model: SavedModel } | { ok: false; error: string };

function validateConditions(conditions: ConditionLeaf[]): string | null {
  if (conditions.length === 0) return "Add at least one condition before saving.";
  for (const c of conditions) {
    const variable = getModelVariable(c.variableId);
    if (!variable) return "Unknown variable in a condition.";
    if ((variable.scope === "team" || variable.scope === "pitcher") && !c.side) {
      return `"${variable.label}" needs a Favorite/Underdog side selected.`;
    }
  }
  return null;
}

export async function saveModelAction(input: SaveModelInput): Promise<SaveModelResult> {
  const user = await requireUser();

  const name = input.name.trim();
  if (!name) return { ok: false, error: "Give the model a name." };

  const conditionError = validateConditions(input.conditions);
  if (conditionError) return { ok: false, error: conditionError };

  const data = { name, target: input.target as PrismaModelTarget, conditions: wrapFlatConditions(input.conditions) };
  const model = input.id
    ? await updateUserModel(user.id, input.id, data)
    : await createUserModel(user.id, data);

  if (!model) return { ok: false, error: "Model not found." };

  revalidatePath("/model-builder");
  return { ok: true, model };
}

export async function deleteModelAction(modelId: string): Promise<{ ok: boolean }> {
  const user = await requireUser();
  const deleted = await deleteUserModel(user.id, modelId);
  if (deleted) revalidatePath("/model-builder");
  return { ok: deleted };
}

export type PreviewModelInput = {
  sportKey: string;
  target: ModelTarget;
  conditions: ConditionLeaf[];
  gameId: string;
};

export type PreviewModelResult =
  | { ok: true; game: { homeTeam: string; awayTeam: string; commenceTime: string }; preview: ModelPreview }
  | { ok: false; error: string };

// Runs the right-panel "Live preview" for one real game - resolves the odds-
// API game by id, finds its MLB gamePk (needed for the probable-pitcher
// lookup; the odds API and MLB Stats API use different ids for the same
// game) via the existing matchScoreToGame team/time matcher, then builds the
// game context and evaluates the model against it.
export async function previewModelAction(input: PreviewModelInput): Promise<PreviewModelResult> {
  await requireUser();

  const [oddsGames, scores] = await Promise.all([
    getOddsForSport(input.sportKey),
    getLiveScoresForSport(input.sportKey),
  ]);

  const oddsGame = oddsGames.find((g) => g.id === input.gameId);
  if (!oddsGame) return { ok: false, error: "That game isn't available right now - odds may have refreshed since the page loaded." };

  const matchedScore = matchScoreToGame(scores, oddsGame);
  const gamePk = matchedScore ? matchedScore.id : null;

  const ctx = await buildGameContext(input.sportKey, oddsGame, gamePk);
  const preview = await previewModel(input.sportKey, input.target, wrapFlatConditions(input.conditions), ctx);

  return {
    ok: true,
    game: { homeTeam: oddsGame.homeTeam, awayTeam: oddsGame.awayTeam, commenceTime: oddsGame.commenceTime },
    preview,
  };
}
