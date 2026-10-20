// The slip-pick building blocks the Parlay Generator's engine (generator.ts)
// shares: toBuildCandidate (a board pick as the conflict walk reads it) and the
// conflict-free primary of a pick pool (buildPoolPrimary, selectConflictFreeLegs
// - Section 9). Pure - no DB access.
import { selectConflictFreeLegs, type BuildCandidate, type SkippedPick, type UnverifiedPair } from "@/lib/parlay/build-my-picks";
import { bestAvailableRecord, rankPoolPicks } from "@/lib/parlay/pick-record";
import type { AutoLeg, AutoParlay, GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { CapperLeagueRecords } from "@/server/data/picks";

// The one mapping from a board pick to the conflict walk's candidate, so a
// pick ranks and conflict-checks the same way wherever it is used.
// `records`, when given, sets the standing a duplicate line is settled on.
export function toBuildCandidate(p: GeneratorPick, records?: CapperLeagueRecords): BuildCandidate {
  const record = records ? bestAvailableRecord(p, records) : undefined;
  return {
    ...(records ? { standing: record ? { winPct: record.winPct, n: record.n } : null } : {}),
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
    gameId: p.gameId,
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
  const ranked = rankPoolPicks(pool, records);
  const byId = new Map(ranked.map((p) => [p.pickId, p]));
  const selection = selectConflictFreeLegs(
    ranked.map((p) => toBuildCandidate(p, records)),
    legCount
  );
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
