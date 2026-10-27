"use server";

// Consensus Hybrid's two server actions (PR 4 of the hybrid series; no UI yet).
//
//   hybridGenerateAction   settings in, the optimizer's result out (plus the
//                          availability notes). The flow and its reads are in
//                          server/data/hybrid-generate.ts.
//   hybridFanDuelLinkAction the exact-line betslip link for a result's legs
//                          (lib/parlay/hybrid-link.ts, server half in
//                          server/data/hybrid-fanduel-link.ts).
//
// Nothing about a pick, a game, a price, a ladder or a FanDuel id is taken from
// the client: it names leagues, games, settings and (for the link) the legs'
// event / market / outcome / point; the server reads the rest. The Standard
// generator (actions/parlay-generate.ts) is not touched by either.
import { requireUser } from "@/server/auth";
import { LIVE_SPORTS } from "@/server/data/odds";
import { prisma } from "@/lib/prisma";
import { getAltLaddersAwaitingClaims } from "@/server/data/alt-ladders";
import { loadGeneratorSnapshot } from "@/server/data/generator-snapshot";
import { getRecentSwings } from "@/server/data/recent-swings";
import { runHybridGenerate, type HybridGenerateResponse } from "@/server/data/hybrid-generate";
import { buildHybridFanDuelLink } from "@/server/data/hybrid-fanduel-link";
import { parseHybridRequest, type HybridGenerateRequest } from "@/lib/parlay/hybrid-request";
import { parseHybridLinkLegs, type HybridLinkLegInput, type HybridLinkResponse } from "@/lib/parlay/hybrid-link";
import type { ParlayRejection } from "@/lib/parlay/leg-cap";
import { oddsApiRequestKeys } from "@/lib/sport-seasons";

const LIVE_LABELS = new Set(LIVE_SPORTS.map((s) => s.label));

export async function hybridGenerateAction(request: HybridGenerateRequest): Promise<HybridGenerateResponse | ParlayRejection> {
  const user = await requireUser();
  const req = parseHybridRequest(request, LIVE_LABELS);
  if ("error" in req) return req;

  const now = new Date();
  return runHybridGenerate(req, {
    now,
    loadSnapshot: (scope) => loadGeneratorSnapshot(user.id, scope, now),
    getLadders: (requests) => getAltLaddersAwaitingClaims(requests),
    getSwings: (args) => getRecentSwings(args),
    leagueKey: (label) => LIVE_SPORTS.find((s) => s.label === label)?.key,
  });
}

export async function hybridFanDuelLinkAction(legs: HybridLinkLegInput[]): Promise<HybridLinkResponse | ParlayRejection> {
  await requireUser();
  const now = new Date();
  // A league's own key, plus its preseason key while one is open.
  const allowed = new Set(LIVE_SPORTS.flatMap((s) => oddsApiRequestKeys(s.key, now)));
  const parsed = parseHybridLinkLegs(legs, allowed);
  if ("error" in parsed) return parsed;

  return buildHybridFanDuelLink(parsed, {
    now,
    getCommenceTimes: async (eventIds) => {
      const rows = await prisma.oddsAltLadder.findMany({ where: { eventId: { in: eventIds } }, select: { eventId: true, commenceTime: true } });
      return new Map(rows.map((r) => [r.eventId, r.commenceTime]));
    },
    getLadders: (requests) => getAltLaddersAwaitingClaims(requests),
  });
}
