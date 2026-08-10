import { prisma } from "@/lib/prisma";
import type { ModelTarget } from "@prisma/client";
import type { ConditionTree } from "@/lib/model-builder";

export type SavedModel = {
  id: string;
  name: string;
  target: ModelTarget;
  conditions: ConditionTree;
  updatedAt: Date;
};

function toSavedModel(row: { id: string; name: string; target: ModelTarget; conditions: unknown; updatedAt: Date }): SavedModel {
  return {
    id: row.id,
    name: row.name,
    target: row.target,
    conditions: row.conditions as ConditionTree,
    updatedAt: row.updatedAt,
  };
}

export async function getUserModels(userId: string): Promise<SavedModel[]> {
  const rows = await prisma.userModel.findMany({ where: { userId }, orderBy: { updatedAt: "desc" } });
  return rows.map(toSavedModel);
}

export async function getUserModel(userId: string, modelId: string): Promise<SavedModel | null> {
  const row = await prisma.userModel.findFirst({ where: { id: modelId, userId } });
  return row ? toSavedModel(row) : null;
}

export async function createUserModel(
  userId: string,
  data: { name: string; target: ModelTarget; conditions: ConditionTree }
): Promise<SavedModel> {
  const row = await prisma.userModel.create({
    data: { userId, name: data.name, target: data.target, conditions: data.conditions as object },
  });
  return toSavedModel(row);
}

export async function updateUserModel(
  userId: string,
  modelId: string,
  data: { name: string; target: ModelTarget; conditions: ConditionTree }
): Promise<SavedModel | null> {
  // findFirst-then-update (not a scoped updateMany) so a modelId belonging to
  // another user 404s in the action instead of silently updating 0 rows.
  const existing = await prisma.userModel.findFirst({ where: { id: modelId, userId } });
  if (!existing) return null;

  const row = await prisma.userModel.update({
    where: { id: modelId },
    data: { name: data.name, target: data.target, conditions: data.conditions as object },
  });
  return toSavedModel(row);
}

export async function deleteUserModel(userId: string, modelId: string): Promise<boolean> {
  const result = await prisma.userModel.deleteMany({ where: { id: modelId, userId } });
  return result.count > 0;
}
