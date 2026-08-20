"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth";
import { createCapper, mergeCappers, renameCapper, deleteCapper, dismissDuplicatePair, toggleFavoriteCapper } from "@/server/data/cappers";
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

export type RenameCapperResult = { success: true } | { success: false; error: string };

// Plain rename only - never infers a merge from a name collision with
// another of the user's cappers. Merge is always a separate, explicit
// action (mergeCappersAction) the user opts into from the profile page's
// "Merge into existing capper" picker, not something this action decides on
// their behalf based on what they typed.
export async function renameCapperAction(capperId: string, name: string): Promise<RenameCapperResult> {
  const user = await requireUser();

  try {
    await renameCapper(user.id, capperId, name);
    revalidatePath("/cappers");
    revalidatePath("/cappers/[capperId]", "page");
    // The Betting Catalog Import page (bulk-import-form.tsx) reads its known-
    // capper-name list from this route at render time - without revalidating
    // it too, a client-side navigation there right after a rename can still
    // serve the pre-rename name list, which is exactly the staleness window
    // that let a renamed capper's picks silently misattribute to an unrelated
    // existing capper whose name happened to be a prefix of the new one (see
    // the capper-rename-misattribution investigation). parseCatalog's inline
    // matching is now hardened against this independently too, but closing
    // the staleness window itself is still the right fix, not just the backstop.
    revalidatePath("/picks/import");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong.";
    return { success: false, error: message };
  }

  return { success: true };
}

export type DeleteCapperResult =
  | { success: true; deletedPickCount: number }
  | { success: false; error: string };

// Permanently removes the capper and (via schema cascade) every pick/parlay
// leg tied to it - meant for junk/parser-misfire records with no real track
// record worth keeping, not a soft-delete. The caller (the profile page's
// confirmation dialog) is responsible for showing the pick count and getting
// an explicit confirm before this is ever called.
export async function deleteCapperAction(capperId: string): Promise<DeleteCapperResult> {
  const user = await requireUser();

  try {
    const result = await deleteCapper(user.id, capperId);
    revalidatePath("/cappers");
    revalidatePath("/dashboard");
    revalidatePath("/reports");
    return { success: true, ...result };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong.";
    return { success: false, error: message };
  }
}

export type ToggleFavoriteCapperResult =
  | { success: true; isFavorite: boolean }
  | { success: false; error: string };

// Toggles Capper.isFavorite - no confirmation, meant to feel instant. Only
// revalidates /cappers (the Favorites section and the star's own state both
// live there); the capper detail page doesn't show favorite status, so no
// need to revalidate it too.
export async function toggleFavoriteCapperAction(capperId: string): Promise<ToggleFavoriteCapperResult> {
  const user = await requireUser();

  try {
    const isFavorite = await toggleFavoriteCapper(user.id, capperId);
    revalidatePath("/cappers");
    return { success: true, isFavorite };
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
