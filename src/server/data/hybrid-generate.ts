// Consensus Hybrid's generate flow, with every read injected (HybridDeps) so the
// wiring is tested with no database and no network. The server action
// (actions/parlay-hybrid.ts) supplies the real ones.
//
// The minimum reads, in order:
//   1. the Standard generator's snapshot (generator-snapshot.ts): pending picks
//      on unstarted in-window games, plus both record maps. No new pick reads.
//   2. positions (consensus.ts) from that snapshot, restricted to the targeted
//      games and to the Include Picks markets.
//   3. the candidate events: the top HYBRID_CANDIDATE_GAMES box-eligible games,
//      plus the few next events the optimizer may reach for to expand past two
//      legs or to fall back to a cross-game pair. Ladders are asked for ONLY
//      these, and the optimizer is handed only the positions on them.
//   4. getAltLadders-with-claim-wait for those events: alternate_spreads for a
//      team-side position, alternate_totals for a total, h2h only for a team side
//      with moneyline supporters.
//   5. getRecentSwings per sport involved (cached per sport and Eastern day).
//   6. optimizeHybrid.
// The slip is ignored. The result comes back as the optimizer made it, plus a
// note for each event whose alternate lines are not posted yet or are still being
// priced by another request.
import { buildConsensusPositions, type ConsensusPosition } from "@/lib/parlay/consensus";
import { boxEligibleGames, HYBRID_CANDIDATE_GAMES, optimizeHybrid, type HybridBoxLegs, type HybridResult } from "@/lib/parlay/hybrid";
import type { HybridGenerateRequest } from "@/lib/parlay/hybrid-request";
import { keepsPick } from "@/lib/parlay/include-picks";
import type { ParlayRejection } from "@/lib/parlay/leg-cap";
import type { SwingGame } from "@/lib/parlay/recent-swings";
import type { AltLadderLookup, AltLadderMarket, AltLadderRequest, AltLadderUnavailableCause } from "@/server/data/alt-ladders";
import type { LoadedSnapshot, SnapshotScope } from "@/server/data/generator-snapshot";

export const ALT_LINES_NOT_POSTED_NOTE = "Alternate lines post on game day (FanDuel).";
export const LADDERS_UNAVAILABLE_NOTE = "Live alternate prices are unavailable right now.";
export const PRICING_IN_PROGRESS_NOTE = "Pricing in progress - another request is fetching this game's FanDuel lines. Try again in a few seconds.";

export type HybridEventNote = {
  eventId: string;
  gameLabel: string;
  kind: "alt-lines-not-posted" | "pricing-in-progress" | "ladders-unavailable";
  message: string;
  // ladders-unavailable only: the credit budget, the usage gate or an API failure stopped the pricing.
  cause?: AltLadderUnavailableCause;
};

export type HybridGenerateResponse = {
  result: HybridResult;
  notes: HybridEventNote[];
  // The events ladders were asked for (the credit spend is bounded by these).
  candidateEvents: string[];
  // Each candidate event's Odds API sport key: what hybridFanDuelLinkAction's legs carry.
  eventSportKeys: Record<string, string>;
  generatedAt: string;
};

export type HybridDeps = {
  now: Date;
  loadSnapshot: (scope: SnapshotScope) => Promise<LoadedSnapshot | ParlayRejection>;
  getLadders: (requests: AltLadderRequest[]) => Promise<AltLadderLookup>;
  getSwings: (args: { sport: string; teams: string[]; before: Date }) => Promise<Record<string, SwingGame[]>>;
  // League label ("NBA") -> the Odds API key of its regular season ("basketball_nba").
  leagueKey: (label: string) => string | undefined;
};

// Events beyond the box-eligible games that a hybrid with more than two legs can
// take its extra legs from (one per leg past the box: past two, or past three
// when the box may take the other side of its total, which is on the box's own
// game and ladder).
export function extraEventCount(maxLegs: number, boxLegs: HybridBoxLegs = "2"): number {
  return Math.max(0, maxLegs - (boxLegs === "2" ? 2 : 3));
}

// The events to buy ladders for, in order. With a box: the top K box-eligible
// games, then the next positions' events (one per leg the settings allow beyond
// two). With none: the cross-game fallback needs two games, plus one per extra
// leg and one spare for a game with no ladder.
export function chooseCandidateEvents(ranked: ConsensusPosition[], maxLegs: number, boxLegs: HybridBoxLegs = "2"): string[] {
  const box = boxEligibleGames(ranked)
    .slice(0, HYBRID_CANDIDATE_GAMES)
    .map((g) => g.eventId);
  const chosen = new Set(box);
  const extra = box.length > 0 ? extraEventCount(maxLegs, boxLegs) : maxLegs + 1;
  let added = 0;
  for (const p of ranked) {
    if (added >= extra) break;
    if (chosen.has(p.eventId)) continue;
    chosen.add(p.eventId);
    added++;
  }
  return Array.from(chosen);
}

// What each candidate event needs from the ladder cache: its team-side position
// needs alternate_spreads (and h2h only when a supporter backs the moneyline),
// its total needs alternate_totals.
export function moneylineIsMainLine(sport: string): boolean {
  const s = sport.toUpperCase();
  return s === "NHL" || s === "MLB" || s.startsWith("ICEHOCKEY_") || s.startsWith("BASEBALL_");
}

export function ladderRequests(positions: ConsensusPosition[], eventIds: string[], sportKeyOf: (p: ConsensusPosition) => string): AltLadderRequest[] {
  const out: AltLadderRequest[] = [];
  for (const eventId of eventIds) {
    const here = positions.filter((p) => p.eventId === eventId);
    if (here.length === 0) continue;
    const markets: AltLadderMarket[] = [];
    const sides = here.filter((p) => p.family === "SIDE");
    if (sides.length > 0) markets.push("alternate_spreads");
    if (here.some((p) => p.family === "TOTAL")) markets.push("alternate_totals");
    // Hockey and baseball: the moneyline IS the main line (the alternate spreads start at 1.5), so
    // tonight's line needs it. Elsewhere only a side with moneyline supporters asks for it.
    if (sides.length > 0 && (moneylineIsMainLine(sides[0].sport) || sides.some((p) => p.supporters.some((s) => s.postedMarket === "MONEYLINE")))) markets.push("h2h");
    out.push({ eventId, sport: sportKeyOf(here[0]), commenceTime: here[0].commenceTime, markets });
  }
  return out;
}

const ALT_MARKETS: AltLadderMarket[] = ["alternate_spreads", "alternate_totals"];

export async function runHybridGenerate(req: HybridGenerateRequest, deps: HybridDeps): Promise<HybridGenerateResponse | ParlayRejection> {
  // 1. The Standard generator's snapshot, with an empty slip.
  const loaded = await deps.loadSnapshot({ leagues: req.leagues, slipPickIds: [], targets: req.targets });
  if ("error" in loaded) return loaded;
  const { snapshot, eventSportKeys } = loaded;

  // 2. Positions: the Include Picks markets only, on the targeted games only.
  const games = req.include === "ALL" ? snapshot.games : snapshot.games.map((g) => ({ ...g, picks: g.picks.filter((p) => keepsPick(req.include, p)) }));
  const targetIds = new Set(req.targets.map((t) => t.gameId));
  const all = buildConsensusPositions({ games, leagueRecords: snapshot.leagueRecords, categoryRecords: snapshot.categoryRecords }, { now: deps.now, minWinPct: req.settings.minWinPct });
  const ranked = targetIds.size > 0 ? all.filter((p) => targetIds.has(p.eventId)) : all;

  // 3. The candidate events, and the positions the optimizer may see.
  const candidateEvents = chooseCandidateEvents(ranked, req.settings.maxLegs, req.settings.boxLegs);
  const candidates = new Set(candidateEvents);
  const sportKeyOf = (p: ConsensusPosition) => eventSportKeys[p.eventId] ?? deps.leagueKey(p.sport) ?? p.sport;

  // 4. Ladders for those events only.
  let requests = ladderRequests(ranked.filter((p) => candidates.has(p.eventId)), candidateEvents, sportKeyOf);
  let lookup: AltLadderLookup = requests.length > 0 ? await deps.getLadders(requests) : { ladders: {}, pricingInProgress: [] };

  // 4b. Backfill: a top-6 box game FanDuel hasn't posted alternate lines for is replaced by the next
  // box-eligible game, once (a second pass, so the spend stays bounded). A game already known to be
  // unposted is a held cache row - asking for it again buys nothing - and is never re-asked here.
  const topBox = new Set(boxEligibleGames(ranked).slice(0, HYBRID_CANDIDATE_GAMES).map((g) => g.eventId));
  const unposted = unpostedEvents(requests, lookup);
  const lost = candidateEvents.filter((id) => topBox.has(id) && unposted.has(id)).length;
  if (lost > 0) {
    const have = new Set(candidateEvents);
    const more = boxEligibleGames(ranked).map((g) => g.eventId).filter((id) => !have.has(id)).slice(0, lost);
    if (more.length > 0) {
      more.forEach((id) => candidates.add(id));
      candidateEvents.push(...more);
      const second = ladderRequests(ranked.filter((p) => more.includes(p.eventId)), more, sportKeyOf);
      const again = await deps.getLadders(second);
      requests = [...requests, ...second];
      lookup = {
        ladders: { ...lookup.ladders, ...again.ladders },
        pricingInProgress: [...lookup.pricingInProgress, ...again.pricingInProgress],
        unavailable: [...(lookup.unavailable ?? []), ...(again.unavailable ?? [])],
      };
    }
  }
  const positions = ranked.filter((p) => candidates.has(p.eventId));

  // 5. Recent swings, one call per sport involved.
  const teamsBySport = new Map<string, Set<string>>();
  for (const p of positions) {
    const key = deps.leagueKey(p.sport) ?? p.sport;
    const teams = teamsBySport.get(key) ?? new Set<string>();
    teams.add(p.homeTeam);
    teams.add(p.awayTeam);
    teamsBySport.set(key, teams);
  }
  const swings: Record<string, SwingGame[]> = {};
  for (const [sport, teams] of teamsBySport) Object.assign(swings, await deps.getSwings({ sport, teams: Array.from(teams), before: deps.now }));

  // 6. The optimizer.
  const { targetMin, targetMax, width, perLegRange, maxLegs, boxLegs } = req.settings;
  const result = optimizeHybrid({ positions, ladders: lookup.ladders, swings, settings: { targetMin, targetMax, width, legRange: perLegRange, maxLegs, boxLegs } });

  return { result, notes: eventNotes(requests, positions, lookup), candidateEvents, eventSportKeys: Object.fromEntries(requests.map((r) => [r.eventId, r.sport])), generatedAt: deps.now.toISOString() };
}

function isUnposted(r: AltLadderRequest, lookup: AltLadderLookup): boolean {
  const event = lookup.ladders[r.eventId] ?? {};
  return ALT_MARKETS.some((m) => r.markets.includes(m) && event[m] !== undefined && event[m]!.outcomes.length === 0);
}

function unpostedEvents(requests: AltLadderRequest[], lookup: AltLadderLookup): Set<string> {
  return new Set(requests.filter((r) => isUnposted(r, lookup)).map((r) => r.eventId));
}

// One note per event that has one: alternate lines FanDuel has not posted yet (a
// fetched ladder with no outcomes), or a ladder another request is still pricing.
function eventNotes(requests: AltLadderRequest[], positions: ConsensusPosition[], lookup: AltLadderLookup): HybridEventNote[] {
  const labelOf = (eventId: string) => {
    const p = positions.find((x) => x.eventId === eventId);
    return p ? `${p.awayTeam} @ ${p.homeTeam}` : eventId;
  };
  const inProgress = new Set(lookup.pricingInProgress.map((x) => x.eventId));
  const causeOf = new Map((lookup.unavailable ?? []).map((u) => [u.eventId, u.cause]));
  const notes: HybridEventNote[] = [];
  for (const r of requests) {
    const cause = causeOf.get(r.eventId);
    if (cause && !inProgress.has(r.eventId)) {
      notes.push({ eventId: r.eventId, gameLabel: labelOf(r.eventId), kind: "ladders-unavailable", message: LADDERS_UNAVAILABLE_NOTE, cause });
      continue;
    }
    if (inProgress.has(r.eventId)) {
      notes.push({ eventId: r.eventId, gameLabel: labelOf(r.eventId), kind: "pricing-in-progress", message: PRICING_IN_PROGRESS_NOTE });
      continue;
    }
    const event = lookup.ladders[r.eventId] ?? {};
    if (isUnposted(r, lookup)) notes.push({ eventId: r.eventId, gameLabel: labelOf(r.eventId), kind: "alt-lines-not-posted", message: ALT_LINES_NOT_POSTED_NOTE });
  }
  return notes;
}
