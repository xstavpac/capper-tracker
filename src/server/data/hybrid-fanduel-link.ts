// The server half of a Consensus Hybrid's "Send to FanDuel" (the matching and the
// link live in lib/parlay/hybrid-link.ts). It reads the ladders for exactly the
// markets the legs name, through the same cache the generate used
// (getAltLaddersAwaitingClaims: cache first, single-flight, the 95% and daily
// credit gates), so a tap right after Generate spends nothing and a tap after the
// cache expired spends at most one call per event for just those markets.
//
// A game's start time comes from the cached ladder rows the generate wrote (the
// request carries none), and a game that has started is never refetched or sent:
// its in-play prices are not the ones the hybrid was built on.
import { hasKickedOff } from "@/lib/parlay/game-over";
import { buildHybridLink, type HybridLinkLegInput, type HybridLinkResponse } from "@/lib/parlay/hybrid-link";
import type { AltLadderLookup, AltLadderMarket, AltLadderRequest } from "@/server/data/alt-ladders";

export type HybridLinkDeps = {
  now: Date;
  // eventId -> start time, for the events with a cached ladder row.
  getCommenceTimes: (eventIds: string[]) => Promise<Map<string, Date>>;
  getLadders: (requests: AltLadderRequest[]) => Promise<AltLadderLookup>;
};

export async function buildHybridFanDuelLink(legs: HybridLinkLegInput[], deps: HybridLinkDeps): Promise<HybridLinkResponse> {
  const eventIds = Array.from(new Set(legs.map((l) => l.eventId)));
  const starts = await deps.getCommenceTimes(eventIds);

  // One request per event that can be read: the union of its legs' markets.
  const requests: AltLadderRequest[] = [];
  for (const eventId of eventIds) {
    const commenceTime = starts.get(eventId);
    if (!commenceTime || hasKickedOff(commenceTime.toISOString(), deps.now)) continue;
    const mine = legs.filter((l) => l.eventId === eventId);
    requests.push({ eventId, sport: mine[0].sportKey, commenceTime, markets: Array.from(new Set(mine.map((l) => l.marketKey as AltLadderMarket))) });
  }
  const lookup = requests.length > 0 ? await deps.getLadders(requests) : { ladders: {}, pricingInProgress: [] };
  const inProgress = new Set(lookup.pricingInProgress.map((p) => p.eventId + "|" + p.market));

  return buildHybridLink(legs, lookup.ladders, (leg) => {
    const start = starts.get(leg.eventId);
    if (!start) return "FanDuel's lines for this game aren't on file - generate again.";
    if (hasKickedOff(start.toISOString(), deps.now)) return "This game has started - add it on FanDuel.";
    if (inProgress.has(leg.eventId + "|" + leg.marketKey)) return "Pricing in progress - try again in a few seconds.";
    return null;
  });
}
