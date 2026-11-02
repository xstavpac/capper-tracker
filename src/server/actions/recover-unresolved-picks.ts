"use server";

import { requireUser } from "@/server/auth";
import { recoverUnresolvedPicks, type RecoverUnresolvedResult } from "@/server/data/recover-unresolved-core";

export type { RecoverUnresolvedResult };

// Session-checked wrapper; the recovery logic and its comments live in
// server/data/recover-unresolved-core.ts.
export async function recoverUnresolvedPicksAction(
  text: string,
  knownCapperNames: string[] = []
): Promise<RecoverUnresolvedResult> {
  await requireUser();
  return recoverUnresolvedPicks(text, knownCapperNames);
}
