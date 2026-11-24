// One ingest batch, end to end, for either source:
//   store the raw batch first -> run the unattended catalog import -> park what needs a person in the review queue
//   -> write the counts and status back.
//
//   TELEGRAM   (telegram-ingest.ts): keyed by (channelId, messageId); a re-POST of the same pair is a duplicate.
//   API_TOKEN  (the bot API, PR 4): keyed by sourceKey ("tok:<tokenId>:<request id>"), tokenId set on every insert.
//
// The batch row is written BEFORE any parsing, so the raw text is never lost, and its key makes a resend a no-op.
// What differs between the sources is only what the caller passes in IngestBatchOptions; this function has no
// per-source rules of its own beyond the batch key.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { dropCombinedBetLines, filterPicksByLeague, narrowAmbiguousByLeague } from "@/lib/ingest-filters";
import type { LineOutcome, LineOutcomeListener, TokenDayRule } from "@/lib/ingest-line-outcome";
import { runCatalogImportForUser } from "@/server/data/catalog-import-orchestrator";
import { buildReviewDrafts, reviewDraftsToRows, type ReviewItemDraft } from "@/server/data/ingest-review";
import { revalidateReviewQueue } from "@/server/data/ingest-review-queue";

export type IngestBatchSource =
  | { type: "TELEGRAM"; channelId: string; messageId: number }
  | { type: "API_TOKEN"; tokenId: string; sourceKey: string };

export type IngestBatchContent = { userId: string; day: string; text: string };

export type IngestBatchOptions = {
  allowedLeagues: Set<string>;
  // A game already final when the batch arrives is never matched (Telegram: true). See CatalogImportHooks.
  realTimeIngest: boolean;
  // The bot API's options (API_TOKEN). Unset for Telegram, whose batches run exactly as before.
  dayRule?: TokenDayRule;
  skipRecipientFanOut?: boolean;
  rejectRepeatedLines?: boolean;
  // Every pick line's outcome, after the batch's review items and counts are written (so a needs_review outcome
  // carries its reviewItemId and each candidate's matched game). In the order the import reported them. Not called
  // for a duplicate batch, or for a batch that failed as a whole.
  onLineOutcome?: LineOutcomeListener;
};

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

// The batch row for this source: created, or - when its key already exists - the existing one. null means "already
// finished: a duplicate". An existing row still RECEIVED (an earlier attempt hit an infrastructure error) is finished
// by this attempt.
async function claimBatch(source: IngestBatchSource, content: IngestBatchContent): Promise<{ id: string; duplicate: boolean }> {
  const { day, text } = content;
  try {
    const data: Prisma.IngestBatchUncheckedCreateInput =
      source.type === "TELEGRAM"
        ? { channelId: source.channelId, messageId: source.messageId, day, text }
        : { sourceType: "API_TOKEN", tokenId: source.tokenId, sourceKey: source.sourceKey, day, text };
    const created = await prisma.ingestBatch.create({ data, select: { id: true } });
    return { id: created.id, duplicate: false };
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    const existing =
      source.type === "TELEGRAM"
        ? await prisma.ingestBatch.findUnique({
            where: { channelId_messageId: { channelId: source.channelId, messageId: source.messageId } },
            select: { id: true, status: true },
          })
        : await prisma.ingestBatch.findUnique({ where: { sourceKey: source.sourceKey }, select: { id: true, status: true } });
    if (!existing) throw err;
    return { id: existing.id, duplicate: existing.status !== "RECEIVED" };
  }
}

// The candidates of a needs_review outcome, with the game each answer was matched to (the review item's stored row).
function withReviewItem(outcome: LineOutcome, drafts: ReviewItemDraft[], itemIds: string[] | null): LineOutcome {
  if (outcome.status !== "needs_review") return outcome;
  const draft = drafts[outcome.questionIndex];
  const reviewItemId = itemIds?.[outcome.questionIndex];
  const candidates = draft
    ? draft.options.choices.map((c) => ({
        label: c.label,
        league: c.pick?.sportName ?? c.sport ?? null,
        game: c.pick ? { away: c.pick.awayTeam, home: c.pick.homeTeam, startsAt: c.pick.gameTime } : null,
      }))
    : outcome.candidates;
  return { ...outcome, candidates, ...(reviewItemId ? { reviewItemId } : {}) };
}

export async function ingestBatch(source: IngestBatchSource, content: IngestBatchContent, options: IngestBatchOptions): Promise<IngestResponse> {
  const { userId, day, text } = content;
  const logLabel = source.type === "TELEGRAM" ? "[ingest-telegram]" : "[ingest-api]";
  const logKeys = source.type === "TELEGRAM" ? { channelId: source.channelId, messageId: source.messageId } : { tokenId: source.tokenId };

  // 1. Store the raw batch first.
  const claimed = await claimBatch(source, content);
  const batchId = claimed.id;
  if (claimed.duplicate) return { status: "duplicate", batchId };

  // 2. The import, as the signed-in user would have pasted it, with every question parked instead of asked.
  //    realTimeIngest (Telegram): the message is imported as it arrives, so a game already final now was final when it
  //    was posted - never matched (the line is logged as skipped). Review choices are matched now too, by the same rule.
  const outcomes: { raw: string; outcome: LineOutcome }[] = [];
  try {
    const result = await runCatalogImportForUser(userId, text, day, {
      preFilterText: dropCombinedBetLines,
      prepareAmbiguous: (picks) => narrowAmbiguousByLeague(options.allowedLeagues, picks),
      filterPicks: (picks) => filterPicksByLeague(options.allowedLeagues, picks),
      realTimeIngest: options.realTimeIngest,
      ...(options.dayRule ? { dayRule: options.dayRule } : {}),
      ...(options.skipRecipientFanOut ? { skipRecipientFanOut: true } : {}),
      ...(options.rejectRepeatedLines ? { rejectRepeatedLines: true } : {}),
      ...(options.onLineOutcome ? { onLineOutcome: (raw: string, outcome: LineOutcome) => void outcomes.push({ raw, outcome }) } : {}),
    });
    const drafts = await buildReviewDrafts(result.questions, { realTimeIngest: options.realTimeIngest, dayRule: options.dayRule });

    const imported = result.importResult?.success ? result.importResult.imported : 0;
    // Lines that were lost for a reason nobody chose (as opposed to a filter or a duplicate doing its job). A pick the
    // import held for a far-future game is in the import's own `skipped`, but it is not lost: it is one of the review
    // items counted in pendingReview below, so it is taken out here and counted once.
    const unexpected =
      result.unresolvedLines.length +
      result.noCapperLines.length +
      result.heldParlays.length +
      (result.importResult
        ? result.importResult.success
          ? result.importResult.skipped - result.importResult.farFutureHeld.length
          : 1
        : 0);
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

    const itemRows = reviewDraftsToRows(batchId, userId, day, drafts);
    const batchUpdate = prisma.ingestBatch.update({
      where: { id: batchId },
      data: { status, importedCount: imported, skippedCount: skipped, pendingReviewCount: pendingReview, error },
    });
    // With a listener the review items' ids are read back (one id per item, in draft order) for its outcomes.
    let itemIds: string[] | null = null;
    if (options.onLineOutcome) {
      const [items] = await prisma.$transaction([prisma.ingestReviewItem.createManyAndReturn({ data: itemRows, select: { id: true } }), batchUpdate]);
      itemIds = items.map((i) => i.id);
    } else {
      await prisma.$transaction([prisma.ingestReviewItem.createMany({ data: itemRows }), batchUpdate]);
    }
    if (pendingReview > 0) revalidateReviewQueue(userId);
    console.log(logLabel, { batchId, ...logKeys, status, imported, skipped, pendingReview });
    if (options.onLineOutcome) for (const o of outcomes) options.onLineOutcome(o.raw, withReviewItem(o.outcome, drafts, itemIds));
    return { status: status.toLowerCase() as "imported" | "partial" | "failed", batchId, imported, skipped, pendingReview };
  } catch (err) {
    if (isInfraError(err)) throw err;
    // A bad batch: record it and answer 200 so the reader does not retry it forever.
    const message = (err instanceof Error ? err.message : "import failed").slice(0, MAX_ERROR_LENGTH);
    await prisma.ingestBatch.update({ where: { id: batchId }, data: { status: "FAILED", error: message } });
    console.error(`${logLabel} batch failed`, { batchId, ...logKeys });
    return { status: "failed", batchId, imported: 0, skipped: 0, pendingReview: 0 };
  }
}
