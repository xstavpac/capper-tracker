// Consensus Hybrid's generate flow, with every read injected (HybridDeps) so the
// wiring is tested with no database and no network. The server action
// (actions/parlay-hybrid.ts) supplies the real ones.
//
// The minimum reads, in order:
//   1. the Standard generator's snapshot (generator-snapshot.ts): pending picks
//      on unstarted in-window games, plus both record maps. No new pick reads.
//   2. positions (consensus.ts) from that snapshot, restricted to the targeted
//      games and to the Include Picks markets.
//   3. the candidate events: the top box-eligible games, as many as the legs cap
//      can hold plus two spare (ladderGameCount, 6 to HYBRID_MAX_LADDER_GAMES),
//      or the first three games when none is box-eligible (the cross-game
//      fallback). Ladders are asked for ONLY these - never more than
//      HYBRID_MAX_LADDER_GAMES, backfill included - and the optimizer is handed
//      only the positions on them.
//   4. getAltLadders-with-claim-wait for those events: alternate_spreads for a
//      team-side position, alternate_totals for a total, h2h only for a team side
//      with moneyline supporters.
//   5. getRecentSwings per sport involved (cached per sport and Eastern day).
//   6. optimizeHybrid.
//   7. "Why only N games?" (hybrid-diagnostics.ts): every game with picks the
//      parlay does not use and the first gate it failed - from what steps 1-6
//      already hold, no further read.
// The slip is ignored. The result comes back as the optimizer made it, plus a
// note for each event whose alternate lines are not posted yet or are still being
// priced by another request.
import { buildConsensusPositions, type ConsensusPosition } from "@/lib/parlay/consensus";
import { boxEligibleGames, HYBRID_MAX_LADDER_GAMES, ladderGameCount, optimizeHybridReport, type HybridBoxLegs, type HybridResult } from "@/lib/parlay/hybrid";
import { explainSkips, type HybridDiagnostics } from "@/lib/parlay/hybrid-diagnostics";
import { HYBRID_LINK_MAX_LEGS } from "@/lib/parlay/hybrid-link";
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
  // False when the parlay has more legs than the FanDuel handoff takes (HYBRID_LINK_MAX_LEGS).
  linkable: boolean;
  // "Why only N games?": each unused game with picks and the first gate it failed.
  diagnostics: HybridDiagnostics;
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

// The events to buy ladders for, in order. With a box: the top ladderGameCount
// box-eligible games - no more, so the credit spend is bounded by
// HYBRID_MAX_LADDER_GAMES whatever the slate holds, and no padding events. With
// none: the cross-game fallback needs two games plus one spare for a game with no
// ladder.
export function chooseCandidateEvents(ranked: ConsensusPosition[], maxLegs: number, boxLegs: HybridBoxLegs = "2"): string[] {
  const box = boxEligibleGames(ranked)
    .slice(0, ladderGameCount(maxLegs, boxLegs))
    .map((g) => g.eventId);
  if (box.length > 0) return box;
  return Array.from(new Set(ranked.map((p) => p.eventId))).slice(0, 3);
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
  const { snapshot, eventSportKeys, skippedGames } = loaded;

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

  // 4b. Backfill: a top box game FanDuel hasn't posted alternate lines for is replaced by the next
  // box-eligible game, once (a second pass, and the games asked about never pass
  // HYBRID_MAX_LADDER_GAMES, so the spend stays bounded). A game already known to be
  // unposted is a held cache row - asking for it again buys nothing - and is never re-asked here.
  const boxIds = boxEligibleGames(ranked).map((g) => g.eventId);
  const topBox = new Set(boxIds.slice(0, ladderGameCount(req.settings.maxLegs, req.settings.boxLegs)));
  const unposted = unpostedEvents(requests, lookup);
  const lost = candidateEvents.filter((id) => topBox.has(id) && unposted.has(id)).length;
  if (lost > 0) {
    const have = new Set(candidateEvents);
    const more = boxIds.filter((id) => !have.has(id)).slice(0, Math.min(lost, Math.max(0, HYBRID_MAX_LADDER_GAMES - candidateEvents.length)));
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
  const { result, report } = optimizeHybridReport({ positions, ladders: lookup.ladders, swings, settings: { targetMin, targetMax, width, legRange: perLegRange, maxLegs, boxLegs } });
  const notes = eventNotes(requests, positions, lookup);

  // 7. Why the other games with picks are not in it.
  const diagnostics = explainSkips({
    games: targetIds.size > 0 ? games.filter((g) => targetIds.has(g.gameId)) : games,
    pickCounts: Object.fromEntries(snapshot.games.map((g) => [g.gameId, g.picks.length])),
    snapshotSkipped: skippedGames ?? [],
    records: snapshot,
    minWinPct: req.settings.minWinPct,
    filtered: games.some((g, i) => g.picks.length !== snapshot.games[i].picks.length),
    positions: ranked,
    candidateEvents,
    notes,
    report,
    result,
  });

  return { result, notes, candidateEvents, eventSportKeys: Object.fromEntries(requests.map((r) => [r.eventId, r.sport])), linkable: (result.primary?.legs.length ?? 0) <= HYBRID_LINK_MAX_LEGS, diagnostics, generatedAt: deps.now.toISOString() };
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
