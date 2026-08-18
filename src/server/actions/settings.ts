"use server";

import { Theme } from "@prisma/client";
import { requireUser } from "@/server/auth";
import { prisma } from "@/lib/prisma";

export type UpdateThemePreferenceResult = { success: true } | { success: false; error: string };

// No revalidatePath - AppLayout (the sole reader of themePreference) is
// already force-dynamic, so the next server render picks this up on its
// own. ThemeProvider applies the change optimistically client-side in the
// meantime; this call just makes it durable across sessions/devices.
export async function updateThemePreferenceAction(theme: Theme): Promise<UpdateThemePreferenceResult> {
  const user = await requireUser();

  try {
    await prisma.user.update({
      where: { id: user.id },
      data: { themePreference: theme },
    });
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not save theme preference.";
    return { success: false, error: message };
  }
}
