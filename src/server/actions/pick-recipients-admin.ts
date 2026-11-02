"use server";

import { revalidatePath } from "next/cache";
import { requireAdminOpsAction } from "@/server/admin-gate";
import {
  addRecipient,
  findUserById,
  pauseRecipient,
  removeRecipient,
  resumeRecipient,
  type RecipientMutation,
} from "@/server/data/pick-recipients";

// Server actions are public POST endpoints, so each one re-checks the admin gate. Pause/resume/remove take effect on
// the very next import (the recipient list is read fresh per import, never cached).
async function done(result: RecipientMutation): Promise<RecipientMutation> {
  if (result.ok) revalidatePath("/admin/recipients");
  return result;
}

// `sourceUserId` must be a real user; the page offers only the signed-in admin and the Telegram ingest user.
export async function addRecipientAction(sourceUserId: string, recipientQuery: string): Promise<RecipientMutation> {
  await requireAdminOpsAction();
  if (typeof recipientQuery !== "string" || typeof sourceUserId !== "string") return { ok: false, error: "Bad request." };
  if (!(await findUserById(sourceUserId))) return { ok: false, error: "Unknown source user." };
  return done(await addRecipient(sourceUserId, recipientQuery));
}

export async function pauseRecipientAction(id: string): Promise<RecipientMutation> {
  await requireAdminOpsAction();
  return done(await pauseRecipient(String(id)));
}

export async function resumeRecipientAction(id: string): Promise<RecipientMutation> {
  await requireAdminOpsAction();
  return done(await resumeRecipient(String(id)));
}

export async function removeRecipientAction(id: string): Promise<RecipientMutation> {
  await requireAdminOpsAction();
  return done(await removeRecipient(String(id)));
}
