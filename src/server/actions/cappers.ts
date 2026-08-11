"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth";
import { createCapper, mergeCappers, dismissDuplicatePair } from "@/server/data/cappers";
import type { Source } from "@prisma/client";

export type CreateCapperResult =
  | { success: true }
  | { success: false; error: string };

export async function createCapperAction(formData: FormData): Promise<CreateCapperResult> {
  const user = await requireUser();

  const name = (formData.get("name") as string)?.trim();
  const source = formData.get("source") as Source;
  const customSource = (formData.get("customSource") as string)?.trim() || undefined;
  const sportSpecialization = (formData.get("sportSpecialization") as string)?.trim() || undefined;
  const colorTag = (formData.get("colorTag") as string) || undefined;
  const notes = (formData.get("notes") as string)?.trim() || undefined;

  if (!name) {
    return { success: false, error: "Capper name is required." };
  }
  if (!source) {
    return { success: false, error: "Source is required." };
  }

  try {
    await createCapper(user.id, {
      name,
      source,
      customSource,
      sportSpecialization,
      colorTag,
      notes,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong.";
    return { success: false, error: message };
  }

  revalidatePath("/cappers");
  revalidatePath("/dashboard");
  return { success: true };
}

export type MergeCappersActionResult =
  | { success: true; mergedPickCount: number; primaryName: string; duplicateName: string }
  | { success: false; error: string };

// Reassigns every pick from the duplicate capper to the primary one, then
// removes the duplicate - see mergeCappers (server/data/cappers.ts) for the
// reassign-before-delete ordering and why it matters. Never called
// automatically; the Cappers page UI always shows a preview and requires an
// explicit confirm click first.
export async function mergeCappersAction(primaryId: string, duplicateId: string): Promise<MergeCappersActionResult> {
  const user = await requireUser();

  try {
    const result = await mergeCappers(user.id, primaryId, duplicateId);
    revalidatePath("/cappers");
    revalidatePath("/cappers/[capperId]", "page");
    revalidatePath("/dashboard");
    revalidatePath("/reports");
    return { success: true, ...result };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong.";
    return { success: false, error: message };
  }
}

export type DismissDuplicatePairResult = { success: true } | { success: false; error: string };

// Persists "not a duplicate" (see dismissDuplicatePair, server/data/cappers.ts)
// so the pair no longer resurfaces on refresh/revisit/re-scan. Never deletes
// or modifies either capper - purely an exclusion record for future scans.
export async function dismissDuplicatePairAction(capperIdA: string, capperIdB: string): Promise<DismissDuplicatePairResult> {
  const user = await requireUser();

  try {
    await dismissDuplicatePair(user.id, capperIdA, capperIdB);
    revalidatePath("/cappers");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong.";
    return { success: false, error: message };
  }

  return { success: true };
}
