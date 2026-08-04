"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth";
import { createCapper } from "@/server/data/cappers";
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
