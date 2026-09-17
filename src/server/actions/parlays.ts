"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth";
import { updateLegStatus, deleteParlayBet } from "@/server/data/parlays";
import type { PickStatus } from "@prisma/client";

export type ParlayActionResult = { success: true } | { success: false; error: string };

// No createParlayAction here - unlike the Aug 18 manual-parlay build this
// replaces, ParlayBet/Leg rows are only ever created by the MLP bulk-import
// path now (see bulkImportParlaysAction, server/actions/bulk-picks.ts),
// which calls createParlayBet (server/data/parlays.ts) directly with
// already-resolved leg data - there is no manual entry form to validate
// against.

export async function updateLegStatusAction(legId: string, status: PickStatus): Promise<ParlayActionResult> {
  const user = await requireUser();

  try {
    await updateLegStatus(user.id, legId, status);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong.";
    return { success: false, error: message };
  }

  revalidatePath("/picks");
  revalidatePath("/dashboard");
  return { success: true };
}

// Deletes a whole parlay (legs cascade). No revalidateTag for the
// dashboard cache here - it reads only Pick rows, which a parlay deletion
// never touches.
export async function deleteParlayAction(parlayBetId: string): Promise<ParlayActionResult> {
  const user = await requireUser();

  try {
    await deleteParlayBet(user.id, parlayBetId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong.";
    return { success: false, error: message };
  }

  revalidatePath("/picks");
  revalidatePath("/dashboard");
  return { success: true };
}
