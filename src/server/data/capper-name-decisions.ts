// Remembered answers to the capper "did you mean" prompt, per name pair. A row exists
// only because a person answered; nothing here ever decides a pair on its own.
import { prisma } from "@/lib/prisma";
import { capperPairKeys, type CapperNameDecisionKind, type StoredCapperNameDecision } from "@/lib/fuzzy-match";

// One narrow read per import / import-page load: three short columns, one row per pair
// the user has ever answered (tens, not thousands).
export async function getCapperNameDecisions(userId: string): Promise<StoredCapperNameDecision[]> {
  const rows = await prisma.capperNameDecision.findMany({
    where: { userId },
    select: { rawKey: true, suggestedKey: true, decision: true },
  });
  return rows.flatMap((r) =>
    r.decision === "SAME" || r.decision === "DIFFERENT" ? [{ rawKey: r.rawKey, suggestedKey: r.suggestedKey, decision: r.decision }] : []
  );
}

export async function recordCapperNameDecision(
  userId: string,
  rawName: string,
  suggestion: string,
  decision: CapperNameDecisionKind
): Promise<void> {
  const { rawKey, suggestedKey } = capperPairKeys(rawName, suggestion);
  if (!rawKey || !suggestedKey || rawKey === suggestedKey) return;
  await prisma.capperNameDecision.upsert({
    where: { userId_rawKey_suggestedKey: { userId, rawKey, suggestedKey } },
    create: { userId, rawKey, suggestedKey, decision },
    update: { decision },
    select: { id: true },
  });
}
