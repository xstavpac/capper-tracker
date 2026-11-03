// Pick recipients: users who also receive the source user's IMPORTED picks (admin-managed, /admin/recipients).
//
// Delivery is a copy of the pick on the recipient's own account, made right after the source's import commits:
//   - only imported picks fan out (Telegram ingest, the catalog import form, review-queue approvals); the hook is called
//     from importPicksForUser and resolveReviewItem, NOT from insertPicksDeduped, so createPick (manual) never fans out;
//   - only ACTIVE recipients get one, read at import time - so Pause is immediate, and Resume has no catch-up: a pick is
//     only ever copied once, when it is imported;
//   - the copy is an ordinary pick on the recipient's account (their own capper, their own duplicate check), marked
//     isRecipientCopy with sourcePickId, and bypasses the Free-plan limit (admin-granted);
//   - copies are independent: edits, deletes and regrades of the source pick do not propagate;
//   - cross-user aggregates (platform_category_rates, grading health, backtests) skip isRecipientCopy rows.
// Delivery is best-effort: a failure is logged and never fails or rolls back the source's import.
import { revalidateTag } from "next/cache";
import { cacheKeys } from "@/lib/cache-keys";
import { prisma } from "@/lib/prisma";
import { revalidateCapperRoster } from "@/server/data/capper-roster";
import { insertPicksDeduped, type DedupPickRow } from "@/server/data/pick-dedup";

export type RecipientCopyInput = { row: DedupPickRow; sourcePickId: string };

export type FanOutResult = { recipients: number; delivered: number; skippedDuplicates: number; failed: number };

// ONE small read per import: the recipient ids, ACTIVE only. Deliberately uncached so a pause takes effect on the very
// next import.
export async function getActiveRecipientIds(sourceUserId: string): Promise<string[]> {
  const rows = await prisma.pickRecipient.findMany({
    where: { sourceUserId, status: "ACTIVE" },
    select: { recipientUserId: true },
  });
  return rows.map((r) => r.recipientUserId);
}

export async function fanOutImportedPicks(sourceUserId: string, copies: RecipientCopyInput[]): Promise<FanOutResult> {
  const result: FanOutResult = { recipients: 0, delivered: 0, skippedDuplicates: 0, failed: 0 };
  if (copies.length === 0) return result;
  try {
    const recipientIds = await getActiveRecipientIds(sourceUserId);
    result.recipients = recipientIds.length;
    for (const recipientId of recipientIds) {
      try {
        const rows: DedupPickRow[] = copies.map(({ row, sourcePickId }) => ({
          ...row,
          capperId: undefined,
          sportId: undefined,
          overrideDuplicate: false,
          raw: undefined,
          isRecipientCopy: true,
          sourcePickId,
        }));
        const out = await insertPicksDeduped(recipientId, rows, { recipientCopy: true });
        if (out.allowed) {
          result.delivered += out.created.length;
          result.skippedDuplicates += out.skippedDuplicates.length;
          revalidateTag(cacheKeys.dashboard(recipientId));
          // Only a delivery that added a capper to this recipient's roster (the first one from a given source capper).
          if (out.cappersAdded > 0) revalidateCapperRoster(recipientId);
        } else {
          result.failed += copies.length;
          console.error("[pick-recipients] delivery refused", { recipientId, copies: copies.length });
        }
      } catch (err) {
        result.failed += copies.length;
        console.error("[pick-recipients] delivery failed", { recipientId, err: err instanceof Error ? err.message : err });
      }
    }
  } catch (err) {
    result.failed += copies.length;
    console.error("[pick-recipients] could not read recipients", err instanceof Error ? err.message : err);
  }
  if (result.failed > 0) console.error("[pick-recipients] some copies were not delivered", result);
  return result;
}

// ---- admin ----

export type RecipientRow = {
  id: string;
  status: "ACTIVE" | "PAUSED";
  createdAt: Date;
  pausedAt: Date | null;
  resumedAt: Date | null;
  source: { id: string; name: string | null; email: string };
  recipient: { id: string; name: string | null; email: string };
};

// The whole list: a handful of rows, two small user joins. Read fresh on each admin page load; no cache, no polling.
export async function listRecipients(): Promise<RecipientRow[]> {
  return prisma.pickRecipient.findMany({
    select: {
      id: true,
      status: true,
      createdAt: true,
      pausedAt: true,
      resumedAt: true,
      source: { select: { id: true, name: true, email: true } },
      recipient: { select: { id: true, name: true, email: true } },
    },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
}

export async function findUserByIdOrEmail(query: string): Promise<{ id: string; name: string | null; email: string } | null> {
  const q = query.trim();
  if (q === "") return null;
  return prisma.user.findFirst({
    where: q.includes("@") ? { email: { equals: q, mode: "insensitive" } } : { id: q },
    select: { id: true, name: true, email: true },
  });
}

export async function findUserById(id: string): Promise<{ id: string; name: string | null; email: string } | null> {
  return prisma.user.findUnique({ where: { id }, select: { id: true, name: true, email: true } });
}

export type RecipientMutation = { ok: true } | { ok: false; error: string };

export async function addRecipient(sourceUserId: string, recipientQuery: string): Promise<RecipientMutation> {
  const recipient = await findUserByIdOrEmail(recipientQuery);
  if (!recipient) return { ok: false, error: "No user with that id or email." };
  if (recipient.id === sourceUserId) return { ok: false, error: "A user cannot be their own recipient." };
  const existing = await prisma.pickRecipient.findUnique({
    where: { sourceUserId_recipientUserId: { sourceUserId, recipientUserId: recipient.id } },
    select: { id: true },
  });
  if (existing) return { ok: false, error: "Already a recipient of that source." };
  await prisma.pickRecipient.create({ data: { sourceUserId, recipientUserId: recipient.id }, select: { id: true } });
  return { ok: true };
}

export async function pauseRecipient(id: string): Promise<RecipientMutation> {
  const done = await prisma.pickRecipient.updateMany({ where: { id, status: "ACTIVE" }, data: { status: "PAUSED", pausedAt: new Date() } });
  return done.count === 1 ? { ok: true } : { ok: false, error: "Not found, or already paused." };
}

export async function resumeRecipient(id: string): Promise<RecipientMutation> {
  const done = await prisma.pickRecipient.updateMany({ where: { id, status: "PAUSED" }, data: { status: "ACTIVE", resumedAt: new Date() } });
  return done.count === 1 ? { ok: true } : { ok: false, error: "Not found, or already active." };
}

// Removes the recipient row only. Picks already delivered stay.
export async function removeRecipient(id: string): Promise<RecipientMutation> {
  const done = await prisma.pickRecipient.deleteMany({ where: { id } });
  return done.count === 1 ? { ok: true } : { ok: false, error: "Not found." };
}

// Cleanup of a recipient's delivered copies, if it is ever needed: ids first (copies only, that user only), then a
// delete by id AND userId. Never a filter-only delete. Not wired to any UI.
const COPY_ID_PAGE = 5000;
export async function listRecipientCopyIds(recipientUserId: string): Promise<string[]> {
  const rows = await prisma.pick.findMany({ where: { userId: recipientUserId, isRecipientCopy: true }, select: { id: true }, take: COPY_ID_PAGE });
  return rows.map((r) => r.id);
}

export async function deleteRecipientCopiesById(recipientUserId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const done = await prisma.pick.deleteMany({ where: { id: { in: ids }, userId: recipientUserId, isRecipientCopy: true } });
  return done.count;
}
