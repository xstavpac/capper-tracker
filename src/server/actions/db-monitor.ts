"use server";

import { revalidatePath } from "next/cache";
import { requireAdminOpsAction } from "@/server/admin-gate";
import { resetPgStatStatements } from "@/server/data/db-monitor";

// DB Monitor "Reset stats". Admin-only: a server action is a public POST
// endpoint, so the gate is re-checked here, not trusted from the page.
export async function resetDbStatsAction(): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireAdminOpsAction();
  try {
    await resetPgStatStatements();
  } catch (err) {
    return { ok: false, error: (err instanceof Error ? err.message : String(err)).split("\n").filter(Boolean).pop() ?? "Reset failed" };
  }
  revalidatePath("/admin/db-monitor");
  return { ok: true };
}
