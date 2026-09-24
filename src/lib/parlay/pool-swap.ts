// Adapts the Parlay Pool's selected picks into the AutoParlay shape
// buildSwapParlay (auto-generate.ts) already knows how to swap legs within -
// so Hedge/Contrarian on Select-Your-Own-Picks reuse the exact same engine
// Auto-Generate uses. No second Hedge/Contrarian implementation.
//
// Per docs/parlay-white-paper.md Section 2.1, My Picks / Auto Hedge /
// Contrarian are three modes over the SAME primary pool. The primary here is
// exactly what My Picks already builds (parlay-pool-section.tsx): the
// ranked, conflict-free top N of the in-scope pool via selectConflictFreeLegs
// (Section 9). Auto Hedge/Contrarian then search each of those N legs' own
// game for a qualifying alternate - that search itself is unchanged
// buildSwapParlay, called by the server action that wires this up
// (server/actions/parlay-pool-generator.ts).
//
// Pure - no DB access.
import { selectConflictFreeLegs, type BuildCandidate, type SkippedPick, type UnverifiedPair } from "@/lib/parlay/build-my-picks";
import { bestAvailableRecord } from "@/lib/parlay/pick-record";
import type { AutoLeg, AutoParlay, GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { CapperLeagueRecords } from "@/server/data/picks";

function bestAvailableWinPct(pick: GeneratorPick, records: CapperLeagueRecords): number {
  return bestAvailableRecord(pick, records)?.winPct ?? -1;
}

// Same rawBetDetail/game-fields mapping parlay-pool-section.tsx's own
// toBuildCandidate uses for My Picks - kept identical so a pick ranks and
// conflict-checks the same way regardless of which mode ends up using it.
function toBuildCandidate(p: GeneratorPick): BuildCandidate {
  return {
    pickId: p.pickId,
    label: `${p.capperName} — ${p.betDetail}`,
    betType: p.betType,
    period: p.period,
    betDetail: p.rawBetDetail,
    line: p.line,
    homeTeam: p.homeTeam,
    awayTeam: p.awayTeam,
    gameTime: new Date(p.gameTime),
    sportName: p.leagueName,
  };
}

export type PoolPrimary = {
  // legs.length is min(requested, however many conflict-free legs the
  // in-scope pool has) - buildSwapParlay only ever reads parlayA.legs, so
  // requested/available here are for the UI's own shortfall notice, not the
  // swap engine.
  parlayA: AutoParlay;
  skipped: SkippedPick[];
  unverified: UnverifiedPair[];
  requested: number;
  shortfall: number;
};

// pool must already be scoped to the picks the caller wants considered (the
// in-scope Parlay Pool) - this function does no league-scope filtering of
// its own, same convention as selectConflictFreeLegs.
export function buildPoolPrimary(pool: GeneratorPick[], records: CapperLeagueRecords, legCount: number): PoolPrimary {
  const ranked = [...pool].sort((a, b) => bestAvailableWinPct(b, records) - bestAvailableWinPct(a, records));
  const byId = new Map(ranked.map((p) => [p.pickId, p]));
  const selection = selectConflictFreeLegs(ranked.map(toBuildCandidate), legCount);
  const legs: AutoLeg[] = selection.legs.map((c) => {
    const pick = byId.get(c.pickId)!;
    return {
      gameId: pick.gameId,
      gameLabel: pick.gameLabel,
      gameTime: pick.gameTime,
      top: { pick, record: bestAvailableRecord(pick, records) },
      next: [],
    };
  });
  return {
    parlayA: { requested: legCount, available: pool.length, legs },
    skipped: selection.skipped,
    unverified: selection.unverified,
    requested: selection.requested,
    shortfall: selection.shortfall,
  };
}

// Unlike Auto-Generate's parlayA (always one leg per game by construction),
// a pool-driven primary can have TWO legs from the same game - e.g. a side
// and an independent total, both allowed through Section 9's conflict
// check. buildSwapParlay excludes only a leg's OWN pickId from that game's
// candidate list (auto-generate.ts), so without this a sibling leg's own
// pick could resurface as a "swap" suggestion for a DIFFERENT leg in the
// same game - not an alternate the user didn't select, but a pick they
// already did. Strips every primary pickId from every game's candidate
// list up front so only genuinely not-selected picks can ever be offered as
// a substitute for any leg.
export function excludeSelectedPicks(games: GeneratorGame[], parlayA: AutoParlay): GeneratorGame[] {
  const primaryPickIds = new Set(parlayA.legs.map((l) => l.top.pick.pickId));
  return games.map((g) => ({ ...g, picks: g.picks.filter((p) => !primaryPickIds.has(p.pickId)) }));
}
