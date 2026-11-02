// The review queue for the unattended Telegram ingest: building the items (each possible answer already matched to
// its game and priced), answering one (resolveReviewItem) and dismissing one (dismissReviewItem). Server-side only,
// no UI yet. Every function takes the userId explicitly and filters by it.
import { revalidateTag } from "next/cache";
import { prisma } from "@/lib/prisma";
import { cacheKeys } from "@/lib/cache-keys";
import { resolveAmbiguousPick } from "@/lib/parse-catalog";
import {
  isReviewOptions,
  pickRowToStored,
  storedToPickRow,
  type ReviewChoice,
  type ReviewOptions,
} from "@/lib/ingest-review-options";
import { createPickRowResolver, type PickRowResolution } from "@/server/data/bulk-import-core";
import { toItem, type CatalogQuestion } from "@/server/data/catalog-import-orchestrator";
import { insertPicksDeduped } from "@/server/data/pick-dedup";
import { revalidateCapperRoster } from "@/server/data/capper-roster";
import { revalidateReviewQueue } from "@/server/data/ingest-review-queue";
import type { IngestQuestionType, Prisma } from "@prisma/client";

export type ReviewItemDraft = {
  capperName: string;
  lineText: string;
  questionType: IngestQuestionType;
  options: ReviewOptions;
};

const choiceFrom = (base: Omit<ReviewChoice, "pick" | "unmatched">, r: PickRowResolution): ReviewChoice =>
  r.ok ? { ...base, pick: pickRowToStored(r.row) } : { ...base, pick: null, unmatched: r.reason };

// One draft per held pick. For each possible answer the game is matched and priced now (the same lookup the import
// uses), so resolveReviewItem never has to match again. The reads are the import's own cached feeds: one loader is
// shared by every choice of every question in the batch.
export async function buildReviewDrafts(questions: CatalogQuestion[]): Promise<ReviewItemDraft[]> {
  if (questions.length === 0) return [];
  const resolve = createPickRowResolver();
  const drafts: ReviewItemDraft[] = [];
  for (const q of questions) {
    const lineText = q.pick.raw;
    const capperName = q.pick.capperName;
    if (q.type === "AMBIGUOUS_TEAM" || q.type === "PLAYER_AMBIGUITY") {
      const choices: ReviewChoice[] = [];
      for (let i = 0; i < q.options.length; i++) {
        const option = q.options[i];
        const picked = resolveAmbiguousPick(q.pick, option);
        // A near-miss capper name is settled together with the answer: nothing creates a capper from it.
        const cappers = q.capperSuggestion
          ? [
              { id: "use-suggestion", name: q.capperSuggestion, label: ` - as ${q.capperSuggestion}` },
              { id: "new-capper", name: q.pick.capperName, label: ` - as new capper "${q.pick.capperName}"` },
            ]
          : [{ id: "", name: q.pick.capperName, label: "" }];
        for (const c of cappers) {
          const r = await resolve(toItem(picked, c.name));
          choices.push(
            choiceFrom(
              {
                id: c.id ? `opt:${i}|${c.id}` : `opt:${i}`,
                label: option.label + c.label,
                sport: option.sport,
                nickname: option.nickname,
                ...(option.playerName ? { playerName: option.playerName } : {}),
                ...(option.typedName ? { typedName: option.typedName } : {}),
                capperName: c.name,
              },
              r
            )
          );
        }
      }
      drafts.push({ capperName, lineText, questionType: q.type, options: { choices } });
    } else if (q.type === "MISSING_TOTAL_LINE") {
      const r = await resolve(toItem(q.pick, q.pick.capperName, q.inferredLine));
      drafts.push({
        capperName,
        lineText,
        questionType: q.type,
        options: {
          choices: [choiceFrom({ id: "confirm", label: `Use the market line ${q.inferredLine}`, inferredLine: q.inferredLine, lineReason: q.reason }, r)],
        },
      });
    } else {
      // CAPPER_FUZZY: the pick is fully resolved, only the capper is open.
      const r = await resolve(toItem(q.pick, q.rawName));
      drafts.push({
        capperName,
        lineText,
        questionType: q.type,
        options: {
          choices: [
            choiceFrom({ id: "use-suggestion", label: `Use existing capper "${q.suggestion}"`, capperName: q.suggestion }, r),
            choiceFrom({ id: "new-capper", label: `New capper "${q.rawName}"`, capperName: q.rawName }, r),
          ],
        },
      });
    }
  }
  return drafts;
}

export type ReviewResult =
  | { ok: true; pickId: string }
  | { ok: false; error: "not_found" | "not_pending" | "bad_choice" | "no_game_match" | "duplicate" | "limit" | "failed"; message: string };

// Answers one review item: inserts the pick stored on the chosen option (no game matching, no price lookup) through
// the same duplicate-checked, limit-checked insert the importer uses, then marks the item RESOLVED. The item is
// claimed first (PENDING -> RESOLVED, one conditional update), so a double tap inserts once.
export async function resolveReviewItem(userId: string, itemId: string, choiceId: string): Promise<ReviewResult> {
  const item = await prisma.ingestReviewItem.findFirst({ where: { id: itemId, userId }, select: { id: true, status: true, options: true } });
  if (!item) return { ok: false, error: "not_found", message: "No such review item." };
  if (item.status !== "PENDING") return { ok: false, error: "not_pending", message: "This item was already answered." };
  if (!isReviewOptions(item.options)) return { ok: false, error: "failed", message: "The stored options are unreadable." };
  const choice = item.options.choices.find((c) => c.id === choiceId);
  if (!choice) return { ok: false, error: "bad_choice", message: "That is not one of this item's choices." };
  if (!choice.pick) return { ok: false, error: "no_game_match", message: choice.unmatched ?? "No game was matched for this choice." };

  const claimed = await prisma.ingestReviewItem.updateMany({
    where: { id: itemId, userId, status: "PENDING" },
    data: { status: "RESOLVED", resolvedAt: new Date() },
  });
  if (claimed.count === 0) return { ok: false, error: "not_pending", message: "This item was already answered." };

  const release = () =>
    prisma.ingestReviewItem.updateMany({ where: { id: itemId, userId, status: "RESOLVED", resolvedPickId: null }, data: { status: "PENDING", resolvedAt: null } });

  let result: Awaited<ReturnType<typeof insertPicksDeduped>>;
  try {
    result = await insertPicksDeduped(userId, [storedToPickRow(choice.pick, choice.capperName)]);
  } catch (err) {
    await release();
    console.error("[ingest-review] insert failed", itemId, err instanceof Error ? err.message : err);
    return { ok: false, error: "failed", message: "The pick could not be saved." };
  }
  if (!result.allowed) {
    await release();
    return { ok: false, error: "limit", message: result.message };
  }
  if (result.created.length === 0) {
    await release();
    return { ok: false, error: "duplicate", message: "This pick is already logged." };
  }
  const pickId = result.created[0].id;
  await prisma.ingestReviewItem.updateMany({ where: { id: itemId, userId }, data: { resolvedPickId: pickId } });
  revalidateTag(cacheKeys.dashboard(userId));
  revalidateCapperRoster(userId);
  revalidateReviewQueue(userId);
  return { ok: true, pickId };
}

export async function dismissReviewItem(userId: string, itemId: string): Promise<{ ok: true } | { ok: false; error: "not_found" | "not_pending" }> {
  const done = await prisma.ingestReviewItem.updateMany({
    where: { id: itemId, userId, status: "PENDING" },
    data: { status: "DISMISSED", resolvedAt: new Date() },
  });
  if (done.count === 1) {
    revalidateReviewQueue(userId);
    return { ok: true };
  }
  const exists = await prisma.ingestReviewItem.findFirst({ where: { id: itemId, userId }, select: { id: true } });
  return { ok: false, error: exists ? "not_pending" : "not_found" };
}

export function reviewDraftsToRows(batchId: string, userId: string, day: string, drafts: ReviewItemDraft[]): Prisma.IngestReviewItemCreateManyInput[] {
  return drafts.map((d) => ({
    ingestBatchId: batchId,
    userId,
    capperName: d.capperName.slice(0, 200),
    lineText: d.lineText.slice(0, 500),
    day,
    questionType: d.questionType,
    options: d.options as unknown as Prisma.InputJsonValue,
  }));
}
