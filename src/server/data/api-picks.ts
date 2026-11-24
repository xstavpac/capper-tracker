// POST /api/v1/picks (bot API tokens, PR 4): one request = at most one API_TOKEN ingest batch, with a per-pick result
// for every client_id. The route (app/api/v1/picks/route.ts) authenticates and validates; this does the rest.
//
//   a. Earlier submissions of the same (token, client_id): ACCEPTED returns its stored result and is not reprocessed;
//      NEEDS_REVIEW dismisses its old review item (the badge drops) and is reprocessed; REJECTED / DISMISSED are
//      reprocessed.
//   b-d. The picks being processed go through the shared ingest core (ingest-batch.ts) as ONE API_TOKEN batch:
//      "capper\n<pick>\n<pick>...", the token day rule, no recipient fan-out, repeated lines rejected.
//   e. One ApiPickSubmission row per processed client_id (upsert on (tokenId, clientId)).
//   f. Results in the request's order.
//
// Matching outcomes to client_ids: the core reports outcomes by (capper, line text), not in line order, but for one
// (capper, line text) in line order. Every line here has the same capper, so outcomes are queued by line text and
// each pick takes the next one for its text.
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { namedPickDay, tokenRequestDay, type LineOutcome } from "@/lib/ingest-line-outcome";
import { canonicalApiPickResult, isApiPickResult, type ApiPickResult } from "@/lib/api-pick-result";
import { ingestBatch } from "@/server/data/ingest-batch";
import { dismissReviewItem } from "@/server/data/ingest-review";
import { leagueDaySlateStored } from "@/server/data/odds";
import { sportKeyForName } from "@/server/data/pick-dedup";

export const API_PICKS_MAX_BODY_BYTES = 64 * 1024;
export const API_PICKS_MAX_PICKS = 50;
const MAX_CAPPER = 100;
const MAX_CLIENT_ID = 100;
const MAX_TEXT = 500;

export type ApiPicksBody = { capper: string; picks: { client_id: string; text: string }[] };

// Characters as a person counts them (code points), not UTF-16 units.
const chars = (s: string) => [...s].length;
// One line of the batch text: a pick's text (or the capper) can never start a line of its own.
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function validateApiPicksBody(raw: unknown): { ok: true; body: ApiPicksBody } | { ok: false; detail: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, detail: "body must be a JSON object" };
  const { capper, picks } = raw as Record<string, unknown>;
  if (typeof capper !== "string" || chars(oneLine(capper)) < 1 || chars(oneLine(capper)) > MAX_CAPPER)
    return { ok: false, detail: `capper must be a string of 1-${MAX_CAPPER} characters` };
  if (!Array.isArray(picks) || picks.length < 1 || picks.length > API_PICKS_MAX_PICKS)
    return { ok: false, detail: `picks must be an array of 1-${API_PICKS_MAX_PICKS} items` };
  const seen = new Set<string>();
  const out: ApiPicksBody["picks"] = [];
  for (let i = 0; i < picks.length; i++) {
    const p = picks[i] as Record<string, unknown> | null;
    if (!p || typeof p !== "object" || Array.isArray(p)) return { ok: false, detail: `picks[${i}] must be an object` };
    const { client_id, text } = p;
    if (typeof client_id !== "string" || chars(client_id) < 1 || chars(client_id) > MAX_CLIENT_ID)
      return { ok: false, detail: `picks[${i}].client_id must be a string of 1-${MAX_CLIENT_ID} characters` };
    if (typeof text !== "string" || chars(oneLine(text)) < 1 || chars(text) > MAX_TEXT)
      return { ok: false, detail: `picks[${i}].text must be a string of 1-${MAX_TEXT} characters` };
    if (seen.has(client_id)) return { ok: false, detail: `client_id "${client_id}" appears more than once in this request` };
    seen.add(client_id);
    out.push({ client_id, text });
  }
  return { ok: true, body: { capper, picks: out } };
}

export type SubmitApiPicksOptions = {
  allowedLeagues: Set<string>;
  now?: Date;
  /** Tests pin this; production reads the 7-day schedule store, then the stored feeds (odds.ts leagueDaySlateStored). */
  hasGamesOnDay?: (sportKey: string, dayKey: string) => Promise<boolean>;
};

type Processed = { result: ApiPickResult; status: "ACCEPTED" | "NEEDS_REVIEW" | "REJECTED"; pickId: string | null; reviewItemId: string | null; reason: string | null };

const lineKey = (s: string) => oneLine(s).toLowerCase();

// no_game_found, split: the pick names a day after the request day and that day's slate isn't stored (past the 7-day
// schedule store, or a day whose pull never landed, with no game in the other feeds either) -> game_not_scheduled_yet:
// resend closer to game day. A stored day (even one with no games), or no day named, stays no_game_found.
async function noGameReason(
  text: string,
  league: string | undefined,
  requestDay: string,
  hasGamesOnDay: (sportKey: string, dayKey: string) => Promise<boolean>,
  memo: Map<string, Promise<boolean>>
): Promise<"no_game_found" | "game_not_scheduled_yet"> {
  const day = namedPickDay(text, requestDay);
  const sportKey = league ? sportKeyForName(league) : undefined;
  if (!day || day <= requestDay || !sportKey) return "no_game_found";
  const k = sportKey + "|" + day;
  if (!memo.has(k)) memo.set(k, hasGamesOnDay(sportKey, day));
  return (await memo.get(k)!) ? "no_game_found" : "game_not_scheduled_yet";
}

async function toProcessed(
  clientId: string,
  text: string,
  o: LineOutcome,
  requestDay: string,
  hasGamesOnDay: (sportKey: string, dayKey: string) => Promise<boolean>,
  memo: Map<string, Promise<boolean>>
): Promise<Processed> {
  if (o.status === "accepted") {
    const pick = { league: o.league, game: o.game, market: o.market, line: o.line, odds: o.odds, pickId: o.pickId };
    return { result: { client_id: clientId, status: "accepted", pick }, status: "ACCEPTED", pickId: o.pickId, reviewItemId: null, reason: null };
  }
  if (o.status === "needs_review") {
    return {
      result: { client_id: clientId, status: "needs_review", reason: o.reason, candidates: o.candidates },
      status: "NEEDS_REVIEW",
      pickId: null,
      reviewItemId: o.reviewItemId ?? null,
      reason: o.reason,
    };
  }
  const reason = o.reason === "no_game_found" ? await noGameReason(text, o.league, requestDay, hasGamesOnDay, memo) : o.reason;
  return { result: { client_id: clientId, status: "rejected", reason }, status: "REJECTED", pickId: null, reviewItemId: null, reason };
}

const rejected = (clientId: string, reason: string): Processed => ({
  result: { client_id: clientId, status: "rejected", reason },
  status: "REJECTED",
  pickId: null,
  reviewItemId: null,
  reason,
});

export async function submitApiPicks(
  auth: { tokenId: string; userId: string },
  body: ApiPicksBody,
  opts: SubmitApiPicksOptions
): Promise<ApiPickResult[]> {
  const { tokenId, userId } = auth;
  const now = opts.now ?? new Date();
  const requestDay = tokenRequestDay(now);
  const hasGamesOnDay = opts.hasGamesOnDay ?? ((sportKey: string, dayKey: string) => leagueDaySlateStored(sportKey, dayKey));
  const results = new Map<string, ApiPickResult>();

  // a. Earlier submissions of these client_ids.
  const existing = await prisma.apiPickSubmission.findMany({
    where: { tokenId, clientId: { in: body.picks.map((p) => p.client_id) } },
    select: { clientId: true, status: true, reviewItemId: true, result: true },
  });
  const byClient = new Map(existing.map((e) => [e.clientId, e]));
  const toProcess: ApiPicksBody["picks"] = [];
  for (const p of body.picks) {
    const prev = byClient.get(p.client_id);
    if (prev?.status === "ACCEPTED" && isApiPickResult(prev.result)) {
      results.set(p.client_id, canonicalApiPickResult(prev.result));
      continue;
    }
    if (prev?.status === "NEEDS_REVIEW" && prev.reviewItemId) {
      const dismissed = await dismissReviewItem(userId, prev.reviewItemId);
      if (!dismissed.ok && dismissed.error === "not_pending") {
        // Answered in the review queue since the read above: an approval made it ACCEPTED - return that.
        const now2 = await prisma.apiPickSubmission.findUnique({
          where: { tokenId_clientId: { tokenId, clientId: p.client_id } },
          select: { status: true, result: true },
        });
        if (now2?.status === "ACCEPTED" && isApiPickResult(now2.result)) {
          results.set(p.client_id, canonicalApiPickResult(now2.result));
          continue;
        }
      }
    }
    toProcess.push(p);
  }

  if (toProcess.length > 0) {
    // b-d. One API_TOKEN batch for the picks being processed.
    const outcomes: { raw: string; outcome: LineOutcome }[] = [];
    const text = [oneLine(body.capper), ...toProcess.map((p) => oneLine(p.text))].join("\n");
    const res = await ingestBatch(
      { type: "API_TOKEN", tokenId, sourceKey: `tok:${tokenId}:${randomUUID()}` },
      { userId, day: requestDay, text },
      {
        allowedLeagues: opts.allowedLeagues,
        realTimeIngest: false,
        dayRule: { requestDay },
        skipRecipientFanOut: true,
        rejectRepeatedLines: true,
        onLineOutcome: (raw, outcome) => void outcomes.push({ raw, outcome }),
      }
    );

    const queues = new Map<string, LineOutcome[]>();
    for (const o of outcomes) {
      const k = lineKey(o.raw);
      queues.set(k, [...(queues.get(k) ?? []), o.outcome]);
    }
    const memo = new Map<string, Promise<boolean>>();
    const processed: { clientId: string; p: Processed }[] = [];
    for (const pick of toProcess) {
      const o = queues.get(lineKey(pick.text))?.shift();
      // No outcome: the whole batch failed (recorded on the batch row), or the line was not read as a pick at all.
      const p = o
        ? await toProcessed(pick.client_id, pick.text, o, requestDay, hasGamesOnDay, memo)
        : rejected(pick.client_id, res.status === "failed" && outcomes.length === 0 ? "error" : "unparseable");
      processed.push({ clientId: pick.client_id, p });
      results.set(pick.client_id, p.result);
    }

    // e. The submissions. A reprocessed client_id restarts its createdAt, so "Picks (7d)" counts it by this request.
    await prisma.$transaction(
      processed.map(({ clientId, p }) => {
        const data = {
          status: p.status,
          pickId: p.pickId,
          reviewItemId: p.reviewItemId,
          reason: p.reason,
          batchId: res.batchId,
          result: p.result as unknown as Prisma.InputJsonValue,
        };
        return prisma.apiPickSubmission.upsert({
          where: { tokenId_clientId: { tokenId, clientId } },
          create: { tokenId, clientId, ...data },
          update: { ...data, createdAt: now },
          select: { id: true },
        });
      })
    );
  }

  // f. In request order.
  return body.picks.map((p) => results.get(p.client_id)!);
}
