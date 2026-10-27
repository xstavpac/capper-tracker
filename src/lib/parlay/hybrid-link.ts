// "Send to FanDuel" for a Consensus Hybrid: the exact-line counterpart of the
// Standard generator's handoff (fanduel-link.ts). The Standard handoff may move a
// pick to the nearest line FanDuel offers (maxLineMove); a hybrid never does. Its
// legs were placed on specific alternate-line rungs, so a leg goes in the betslip
// at its exact point or the whole link is withheld.
//
//   - Input: (eventId, sportKey, marketKey, outcomeName, point) per leg. No price,
//     selection id or link is ever taken from the client; the sport key is only
//     checked against the leagues the app carries.
//   - Each leg is matched with matchFanDuelOutcome and NO maxLineMove: the same
//     market, the same outcome and the same point, else nothing. The market and
//     selection ids come from the feed's own sid / betslip link, nowhere else.
//   - Any leg missing, changed, ambiguous or unpriced: url is null (never a partial
//     slip), and the response says which leg is gone and the nearest point FanDuel
//     has for it now, so the page can offer a re-generate.
//   - Every leg comes back with FanDuel's current price, so the page can show
//     "price moved from -250 to -265" against the price it generated with.
// Pure and client-safe; the server half (server/data/hybrid-fanduel-link.ts) reads
// the ladders.
import { buildFanDuelBetslipUrl, matchFanDuelOutcome, type FanDuelSelection } from "@/lib/parlay/fanduel-link";
import type { HybridMarketKey } from "@/lib/parlay/hybrid";
import { HYBRID_MAX_LEGS } from "@/lib/parlay/hybrid";
import type { ParlayRejection } from "@/lib/parlay/leg-cap";
import type { AltLadder, AltLadderResult } from "@/server/data/alt-ladders";

export type HybridLinkLegInput = {
  eventId: string;
  // The Odds API key the event lists under (a league's own, or its preseason key).
  sportKey: string;
  marketKey: HybridMarketKey;
  // The feed's spelling: a team name, "Over" or "Under".
  outcomeName: string;
  // The leg's point; null for h2h.
  point: number | null;
};

export type HybridLinkNearest = { point: number | null; price: number };

export type HybridLinkLegResult =
  | { status: "matched"; leg: HybridLinkLegInput; price: number; isStale: boolean }
  | {
      status: "gone";
      leg: HybridLinkLegInput;
      reason: string;
      // FanDuel's closest line for the same market and outcome right now; null
      // when the market has none (or the lines could not be read).
      nearest: HybridLinkNearest | null;
    };

export type HybridLinkResponse = {
  // Null unless every leg matched.
  url: string | null;
  legs: HybridLinkLegResult[];
  anyStale: boolean;
  // The oldest FanDuel market update behind the prices (ISO), null when unknown.
  oddsAsOf: string | null;
};

const MARKETS: readonly string[] = ["alternate_spreads", "alternate_totals", "h2h"];
const MAX_TEXT = 100;
const reject = (error: string): ParlayRejection => ({ error });
export const HYBRID_LINK_INVALID = "That request isn't valid - generate again and retry.";

export function parseHybridLinkLegs(raw: unknown, allowedSportKeys: ReadonlySet<string>): HybridLinkLegInput[] | ParlayRejection {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > HYBRID_MAX_LEGS) return reject(HYBRID_LINK_INVALID);
  const legs: HybridLinkLegInput[] = [];
  for (const r of raw) {
    if (typeof r !== "object" || r === null) return reject(HYBRID_LINK_INVALID);
    const { eventId, sportKey, marketKey, outcomeName, point } = r as Record<string, unknown>;
    if (typeof eventId !== "string" || eventId.length === 0 || eventId.length > 64) return reject(HYBRID_LINK_INVALID);
    if (typeof sportKey !== "string" || !allowedSportKeys.has(sportKey)) return reject(HYBRID_LINK_INVALID);
    if (typeof marketKey !== "string" || !MARKETS.includes(marketKey)) return reject(HYBRID_LINK_INVALID);
    if (typeof outcomeName !== "string" || outcomeName.length === 0 || outcomeName.length > MAX_TEXT) return reject(HYBRID_LINK_INVALID);
    // h2h has no point; the alternate markets always do.
    if (marketKey === "h2h" ? point !== null && point !== undefined : typeof point !== "number" || !Number.isFinite(point)) return reject(HYBRID_LINK_INVALID);
    const leg: HybridLinkLegInput = { eventId, sportKey, marketKey: marketKey as HybridMarketKey, outcomeName, point: marketKey === "h2h" ? null : (point as number) };
    if (legs.some((l) => l.eventId === leg.eventId && l.marketKey === leg.marketKey && l.outcomeName === leg.outcomeName && l.point === leg.point)) {
      return reject("The same leg is in the slip twice.");
    }
    legs.push(leg);
  }
  return legs;
}

// FanDuel's closest line for the leg's market and outcome, nearer first; two
// equally near go to the easier one (lower for an Over, higher otherwise).
export function nearestLine(leg: HybridLinkLegInput, ladder: AltLadder | undefined): HybridLinkNearest | null {
  if (!ladder) return null;
  const same = ladder.outcomes.filter((o) => o.name === leg.outcomeName);
  if (leg.marketKey === "h2h") return same[0] ? { point: null, price: same[0].price } : null;
  const withPoint = same.filter((o): o is typeof o & { point: number } => typeof o.point === "number");
  if (withPoint.length === 0 || leg.point === null) return null;
  const want = leg.point;
  const sign = leg.outcomeName === "Over" ? 1 : -1; // Over: lower is easier
  withPoint.sort((a, b) => Math.abs(a.point - want) - Math.abs(b.point - want) || sign * (a.point - b.point));
  return { point: withPoint[0].point, price: withPoint[0].price };
}

// `unavailable`: why a leg can't be read at all (its game has started, no lines
// are on file, or another request is still pricing it); the legs it names are
// "gone" without a ladder lookup.
export function buildHybridLink(legs: HybridLinkLegInput[], ladders: AltLadderResult, unavailable: (leg: HybridLinkLegInput) => string | null): HybridLinkResponse {
  const results: HybridLinkLegResult[] = [];
  const selections: FanDuelSelection[] = [];
  const updates: string[] = [];
  for (const leg of legs) {
    const why = unavailable(leg);
    if (why) {
      results.push({ status: "gone", leg, reason: why, nearest: null });
      continue;
    }
    const ladder = ladders[leg.eventId]?.[leg.marketKey];
    if (!ladder) {
      results.push({ status: "gone", leg, reason: "FanDuel's lines for this game couldn't be read right now.", nearest: null });
      continue;
    }
    // No maxLineMove: the exact point or nothing.
    const match = matchFanDuelOutcome(
      { marketKeys: [leg.marketKey], outcomeName: leg.outcomeName, ...(leg.point === null ? {} : { point: leg.point }) },
      [{ key: leg.marketKey, sid: null, outcomes: ladder.outcomes }]
    );
    if (match.status === "matched") {
      selections.push(match.selection);
      if (ladder.marketLastUpdate) updates.push(new Date(ladder.marketLastUpdate).toISOString());
      results.push({ status: "matched", leg, price: match.price, isStale: ladder.isStale });
      continue;
    }
    const near = nearestLine(leg, ladder);
    // Without maxLineMove the matcher never answers "adjusted"; a nearest-line answer would be refused anyway.
    const matchWhy = "reason" in match ? match.reason : "FanDuel only has a different line.";
    const reason = match.status === "ambiguous" ? matchWhy : near && near.point !== null && near.point !== leg.point ? `FanDuel no longer has this exact line (closest is ${near.point}).` : matchWhy;
    results.push({ status: "gone", leg, reason, nearest: near });
  }
  const all = results.every((r) => r.status === "matched");
  return {
    url: all ? buildFanDuelBetslipUrl(selections) : null,
    legs: results,
    anyStale: results.some((r) => r.status === "matched" && r.isStale),
    oddsAsOf: updates.sort()[0] ?? null,
  };
}
