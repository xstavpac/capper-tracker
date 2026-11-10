"use server";

import { requireUser } from "@/server/auth";
import { recordCapperNameDecision } from "@/server/data/capper-name-decisions";

// Called when the person answers a "did you mean" prompt on the import form. Session user only.
export async function recordCapperNameDecisionAction(rawName: string, suggestion: string, decision: "SAME" | "DIFFERENT"): Promise<void> {
  const user = await requireUser();
  if (typeof rawName !== "string" || typeof suggestion !== "string" || (decision !== "SAME" && decision !== "DIFFERENT")) return;
  await recordCapperNameDecision(user.id, rawName.slice(0, 200), suggestion.slice(0, 200), decision);
}
