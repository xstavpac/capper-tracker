// One Telegram batch, end to end (the work behind POST /api/ingest/telegram):
//   store the raw batch first -> run the unattended catalog import -> park what needs a person in the review queue
//   -> write the counts and status back.
// The batch row is written BEFORE any parsing, so the raw text is never lost, and (channelId, messageId) makes a
// re-POST a no-op.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { dropCombinedBetLines, filterPicksByLeague, narrowAmbiguousByLeague } from "@/lib/ingest-filters";
import { runCatalogImportForUser } from "@/server/data/catalog-import-orchestrator";
import { buildReviewDrafts, reviewDraftsToRows } from "@/server/data/ingest-review";
import { revalidateReviewQueue } from "@/server/data/ingest-review-queue";

export type IngestBatchInput = { channelId: string; messageId: number; day: string; text: string };
export type IngestConfig = { userId: string; allowedLeagues: Set<string> };

export type IngestResponse =
  | { status: "duplicate"; batchId: string }
  | { status: "imported" | "partial" | "failed"; batchId: string; imported: number; skipped: number; pendingReview: number };

const MAX_ERROR_LENGTH = 500;

// A failure of the database or its connection, not of this batch's content: the caller must see a 5xx so the
// reader retries, and the batch stays RECEIVED so the retry finishes it.
export function isInfraError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientInitializationError || err instanceof Prisma.PrismaClientRustPanicError) return true;
  if (err instanceof Prisma.PrismaClientKnownRequestError) return ["P1001", "P1002", "P1008", "P1017", "P2024"].includes(err.code);
  return false;
}

export async function ingestTelegramBatch(input: IngestBatchInput, config: IngestConfig): Promise<IngestResponse> {
  const { channelId, messageId, day, text } = input;

  // 1. Store the raw batch first. A second POST of the same (channelId, messageId) is a duplicate - unless the first
  //    one never finished (still RECEIVED after an infrastructure error), in which case this one finishes it.
  let batchId: string;
  try {
    const created = await prisma.ingestBatch.create({ data: { channelId, messageId, day, text }, select: { id: true } });
    batchId = created.id;
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    const existing = await prisma.ingestBatch.findUnique({
      where: { channelId_messageId: { channelId, messageId } },
      select: { id: true, status: true },
    });
    if (!existing) throw err;
    if (existing.status !== "RECEIVED") return { status: "duplicate", batchId: existing.id };
    batchId = existing.id;
  }

  // 2. The import, as the signed-in user would have pasted it, with every question parked instead of asked.
  try {
    const result = await runCatalogImportForUser(config.userId, text, day, {
      preFilterText: dropCombinedBetLines,
      prepareAmbiguous: (picks) => narrowAmbiguousByLeague(config.allowedLeagues, picks),
      filterPicks: (picks) => filterPicksByLeague(config.allowedLeagues, picks),
    });
    const drafts = await buildReviewDrafts(result.questions);

    const imported = result.importResult?.success ? result.importResult.imported : 0;
    // Lines that were lost for a reason nobody chose (as opposed to a filter or a duplicate doing its job).
    const unexpected =
      result.unresolvedLines.length +
      result.noCapperLines.length +
      result.heldParlays.length +
      (result.importResult ? (result.importResult.success ? result.importResult.skipped : 1) : 0);
    const skipped = unexpected + result.duplicatesSkipped + result.hookSkipped;
    const pendingReview = drafts.length;

    let status: "IMPORTED" | "PARTIAL" | "FAILED" = pendingReview > 0 || unexpected > 0 ? "PARTIAL" : "IMPORTED";
    let error: string | null = null;
    if (imported === 0 && pendingReview === 0 && unexpected > 0 && result.hookSkipped === 0 && result.duplicatesSkipped === 0) {
      status = "FAILED";
      error = "No pick could be imported from this batch";
    }
    // The source import succeeded; only the copies to recipients did not all arrive. Visible on the batch row.
    const recipientsFailed = result.importResult?.success ? (result.importResult.recipientsFailed ?? 0) : 0;
    if (recipientsFailed > 0 && error === null) error = `Recipient delivery failed for ${recipientsFailed} copies; the source import succeeded`;

    await prisma.$transaction([
      prisma.ingestReviewItem.createMany({ data: reviewDraftsToRows(batchId, config.userId, day, drafts) }),
      prisma.ingestBatch.update({
        where: { id: batchId },
        data: { status, importedCount: imported, skippedCount: skipped, pendingReviewCount: pendingReview, error },
      }),
    ]);
    if (pendingReview > 0) revalidateReviewQueue(config.userId);
    console.log("[ingest-telegram]", { batchId, channelId, messageId, status, imported, skipped, pendingReview });
    return { status: status.toLowerCase() as "imported" | "partial" | "failed", batchId, imported, skipped, pendingReview };
  } catch (err) {
    if (isInfraError(err)) throw err;
    // A bad batch: record it and answer 200 so the reader does not retry it forever.
    const message = (err instanceof Error ? err.message : "import failed").slice(0, MAX_ERROR_LENGTH);
    await prisma.ingestBatch.update({ where: { id: batchId }, data: { status: "FAILED", error: message } });
    console.error("[ingest-telegram] batch failed", { batchId, channelId, messageId });
    return { status: "failed", batchId, imported: 0, skipped: 0, pendingReview: 0 };
  }
}
