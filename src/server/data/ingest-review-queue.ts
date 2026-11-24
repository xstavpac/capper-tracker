// What the review queue UI reads: the pending count (sidebar badge, cached) and the pending list (Catalog Import
// page, one slim query). Writes live in ingest-review.ts; every write that changes the PENDING set calls
// revalidateReviewQueue.
import { revalidateTag } from "next/cache";
import { prisma } from "@/lib/prisma";
import { cacheKeys } from "@/lib/cache-keys";
import { cachedByTag } from "@/server/data/cached";
import type { IngestQuestionType, IngestSourceType } from "@prisma/client";
import { sideForNickname } from "@/lib/team-name-match";
import { teamShortName } from "@/lib/team-abbreviations";

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
  // AMBIGUOUS_TEAM only: the game this choice's stored pick was matched to at ingest (never re-matched here). home /
  // away are short names ("GB"), side is which of them this choice's team is (null when the stored names can't tell).
  game?: ReviewCardGame;
};

export type ReviewCardGame = { home: string; away: string; side: "HOME" | "AWAY" | null; startsAt: string };

// Where the item came from: a Telegram batch, or a bot API token. tokenName is null once the token is revoked or
// deleted (the batch's tokenId is nulled on delete), so the line then reads "API token".
export type ReviewCardSource = { type: "TELEGRAM" } | { type: "API_TOKEN"; tokenName: string | null };

export type ReviewCard = {
  id: string;
  capperName: string;
  lineText: string;
  day: string;
  questionType: IngestQuestionType;
  choices: ReviewCardChoice[];
  source: ReviewCardSource;
  createdAt: string; // ISO; shown in the viewer's own timezone, formatted after mount
};

type RowChoice = Omit<ReviewCardChoice, "game"> & {
  nickname?: string | null;
  home?: string | null;
  away?: string | null;
  startsAt?: string | null;
};
type Row = Omit<ReviewCard, "choices" | "source" | "createdAt"> & {
  choices: RowChoice[] | null;
  sourceType: IngestSourceType;
  tokenName: string | null;
  createdAt: Date;
};

function choiceGame(c: RowChoice): ReviewCardGame | undefined {
  if (!c.home || !c.away || !c.startsAt) return undefined;
  const side = c.nickname ? sideForNickname({ homeTeam: c.home, awayTeam: c.away }, c.nickname) : null;
  return { home: teamShortName(c.home), away: teamShortName(c.away), side, startsAt: new Date(c.startsAt).toISOString() };
}

// PENDING only, oldest first, capped. The choices are projected in SQL out of the options JSON so the stored picks
// (game, price, line per choice) never leave the database: an ambiguous-team choice adds only its game's two team
// names and start time. The batch's source and the token's name come from one LEFT JOIN each (no per-card reads).
export async function getPendingReviewCards(userId: string): Promise<ReviewCard[]> {
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT i."id", i."capperName", i."lineText", i."day", i."questionType", i."createdAt",
      b."sourceType", CASE WHEN t."revokedAt" IS NULL THEN t."name" END AS "tokenName",
      (SELECT jsonb_agg(jsonb_build_object(
          'id', c.value->>'id',
          'label', c.value->>'label',
          'inferredLine', c.value->'inferredLine',
          'lineReason', c.value->>'lineReason',
          'capperName', c.value->>'capperName',
          'playerName', c.value->>'playerName',
          'typedName', c.value->>'typedName',
          'playable', jsonb_typeof(c.value->'pick') = 'object',
          'unmatched', c.value->>'unmatched',
          'nickname', CASE WHEN i."questionType" = 'AMBIGUOUS_TEAM' THEN c.value->>'nickname' END,
          'home', CASE WHEN i."questionType" = 'AMBIGUOUS_TEAM' THEN c.value->'pick'->>'homeTeam' END,
          'away', CASE WHEN i."questionType" = 'AMBIGUOUS_TEAM' THEN c.value->'pick'->>'awayTeam' END,
          'startsAt', CASE WHEN i."questionType" = 'AMBIGUOUS_TEAM' THEN c.value->'pick'->>'gameTime' END) ORDER BY c.ord)
        FROM jsonb_array_elements(i."options"->'choices') WITH ORDINALITY AS c(value, ord)) AS "choices"
    FROM "ingest_review_items" i
    LEFT JOIN "ingest_batches" b ON b."id" = i."ingestBatchId"
    LEFT JOIN "api_tokens" t ON t."id" = b."tokenId"
    WHERE i."userId" = ${userId} AND i."status" = 'PENDING'
    ORDER BY i."createdAt" ASC, i."id" ASC
    LIMIT ${REVIEW_LIST_LIMIT}`;
  return rows.map(({ sourceType, tokenName, createdAt, choices, ...r }) => ({
    ...r,
    source: sourceType === "API_TOKEN" ? { type: "API_TOKEN", tokenName: tokenName ?? null } : { type: "TELEGRAM" },
    createdAt: createdAt.toISOString(),
    choices: (choices ?? []).map((c) => {
      const game = choiceGame(c);
      return {
      id: c.id,
      label: c.label,
      ...(typeof c.inferredLine === "number" ? { inferredLine: c.inferredLine } : {}),
      ...(c.lineReason ? { lineReason: c.lineReason } : {}),
      ...(c.capperName ? { capperName: c.capperName } : {}),
      ...(c.playerName ? { playerName: c.playerName } : {}),
      ...(c.typedName ? { typedName: c.typedName } : {}),
      playable: Boolean(c.playable),
      ...(c.unmatched ? { unmatched: c.unmatched } : {}),
      ...(game ? { game } : {}),
      };
    }),
  }));
}
