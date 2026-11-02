// What the review queue UI reads: the pending count (sidebar badge, cached) and the pending list (Catalog Import
// page, one slim query). Writes live in ingest-review.ts; every write that changes the PENDING set calls
// revalidateReviewQueue.
import { revalidateTag } from "next/cache";
import { prisma } from "@/lib/prisma";
import { cacheKeys } from "@/lib/cache-keys";
import { cachedByTag } from "@/server/data/cached";
import type { IngestQuestionType } from "@prisma/client";

// A backstop only: create / resolve / dismiss all revalidate the tag.
const COUNT_REVALIDATE_SECONDS = 120;
export const REVIEW_LIST_LIMIT = 50;

export function revalidateReviewQueue(userId: string) {
  revalidateTag(cacheKeys.ingestReviewCount(userId));
}

// One indexed COUNT on (userId, status), cached per user. The sidebar reads this on every page render.
export function getPendingReviewCount(userId: string): Promise<number> {
  return cachedByTag(cacheKeys.ingestReviewCount(userId), COUNT_REVALIDATE_SECONDS, () =>
    prisma.ingestReviewItem.count({ where: { userId, status: "PENDING" } })
  );
}

// A choice as the card needs it: no stored pick (that is the heavy part), only whether one exists.
export type ReviewCardChoice = {
  id: string;
  label: string;
  inferredLine?: number;
  lineReason?: "missing" | "garbled";
  capperName?: string;
  playerName?: string;
  typedName?: string;
  playable: boolean;
  unmatched?: string;
};

export type ReviewCard = {
  id: string;
  capperName: string;
  lineText: string;
  day: string;
  questionType: IngestQuestionType;
  choices: ReviewCardChoice[];
};

type Row = Omit<ReviewCard, "choices"> & { choices: ReviewCardChoice[] | null };

// PENDING only, oldest first, capped. The choices are projected in SQL out of the options JSON so the stored picks
// (game, price, line per choice) never leave the database.
export async function getPendingReviewCards(userId: string): Promise<ReviewCard[]> {
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT i."id", i."capperName", i."lineText", i."day", i."questionType",
      (SELECT jsonb_agg(jsonb_build_object(
          'id', c.value->>'id',
          'label', c.value->>'label',
          'inferredLine', c.value->'inferredLine',
          'lineReason', c.value->>'lineReason',
          'capperName', c.value->>'capperName',
          'playerName', c.value->>'playerName',
          'typedName', c.value->>'typedName',
          'playable', jsonb_typeof(c.value->'pick') = 'object',
          'unmatched', c.value->>'unmatched') ORDER BY c.ord)
        FROM jsonb_array_elements(i."options"->'choices') WITH ORDINALITY AS c(value, ord)) AS "choices"
    FROM "ingest_review_items" i
    WHERE i."userId" = ${userId} AND i."status" = 'PENDING'
    ORDER BY i."createdAt" ASC, i."id" ASC
    LIMIT ${REVIEW_LIST_LIMIT}`;
  return rows.map((r) => ({
    ...r,
    choices: (r.choices ?? []).map((c) => ({
      id: c.id,
      label: c.label,
      ...(typeof c.inferredLine === "number" ? { inferredLine: c.inferredLine } : {}),
      ...(c.lineReason ? { lineReason: c.lineReason } : {}),
      ...(c.capperName ? { capperName: c.capperName } : {}),
      ...(c.playerName ? { playerName: c.playerName } : {}),
      ...(c.typedName ? { typedName: c.typedName } : {}),
      playable: Boolean(c.playable),
      ...(c.unmatched ? { unmatched: c.unmatched } : {}),
    })),
  }));
}
