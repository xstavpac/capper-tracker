// Auto-Generate for the Parlay Generator: Parlay A plus its Hedge and
// Contrarian variants. Pure - no DB access. The caller (server action) loads
// today's unstarted games and picks, already scoped to the signed-in user's
// own tracked cappers, plus both record maps.
//
// No new classification or qualification logic lives here:
//   - Parlay A ranks each game's picks by bestAvailableRecord (the same record
//     My Picks ranks by), and takes exactly one leg per game (each game's #1).
//   - Hedge/Contrarian call rankCandidates (qualification-ranking.ts) with
//     AUTO_HEDGE / CONTRARIAN for each Parlay A leg against that leg's own
//     game's other picks. That covers the classifier, the 55% gate, the
//     Contrarian headcount and the Wilson ordering.
//
// Parlay A is never modified. Hedge/Contrarian are new objects that carry
// each Parlay A pick unchanged when it has no qualifying alternate.
import type { CapperLeagueRecords } from "@/server/data/picks";
import type { CategoryBreakdownItem } from "@/server/data/stats";
import type { ExpanderPick } from "@/components/live/game-picks-expander";
import { bestAvailableRecord, type RankRecord } from "@/lib/parlay/pick-record";
import { contrarianHeadcountPasses, rankCandidates, type ParlayLeg } from "@/lib/parlay/qualification-ranking";
import type { Rule } from "@/lib/parlay/relationship-classifier";

export type GeneratorPick = ExpanderPick & { datePosted: string };

export type GeneratorGame = {
  gameId: string;
  gameLabel: string;
  gameTime: string;
  leagueName: string;
  picks: GeneratorPick[];
};

export type RankedPick = { pick: GeneratorPick; record: RankRecord | null };

// How many of each game's runner-up picks show (collapsed) under its leg.
export const NEXT_PICKS_SHOWN = 3;

export type AutoLeg = {
  gameId: string;
  gameLabel: string;
  gameTime: string;
  top: RankedPick;
  next: RankedPick[];
};

export type AutoParlay = {
  requested: number;
  // Games with at least one pick - the most legs Parlay A can have.
  available: number;
  // min(requested, available) legs, strongest #1 pick first. When
  // available < requested the UI must ask before showing this.
  legs: AutoLeg[];
};

// Win% desc, then bigger sample, then pick id (so equal records never
// depend on input order). A pick with no record at all ranks below every
// pick that has one - it still shows, it just can't outrank a real record.
export function compareRankedPicks(a: RankedPick, b: RankedPick): number {
  if (a.record && !b.record) return -1;
  if (!a.record && b.record) return 1;
  if (a.record && b.record) {
    if (b.record.winPct !== a.record.winPct) return b.record.winPct - a.record.winPct;
    if (b.record.n !== a.record.n) return b.record.n - a.record.n;
  }
  return a.pick.pickId < b.pick.pickId ? -1 : a.pick.pickId > b.pick.pickId ? 1 : 0;
}

export function rankGamePicks(picks: GeneratorPick[], records: CapperLeagueRecords): RankedPick[] {
  return picks.map((pick) => ({ pick, record: bestAvailableRecord(pick, records) })).sort(compareRankedPicks);
}

export function buildAutoParlay(games: GeneratorGame[], records: CapperLeagueRecords, requested: number): AutoParlay {
  const candidates: AutoLeg[] = [];
  for (const game of games) {
    if (game.picks.length === 0) continue;
    const [top, ...rest] = rankGamePicks(game.picks, records);
    candidates.push({
      gameId: game.gameId,
      gameLabel: game.gameLabel,
      gameTime: game.gameTime,
      top,
      next: rest.slice(0, NEXT_PICKS_SHOWN),
    });
  }
  candidates.sort((a, b) => compareRankedPicks(a.top, b.top));
  return { requested, available: candidates.length, legs: candidates.slice(0, requested) };
}

export function toParlayLeg(p: GeneratorPick): ParlayLeg {
  return {
    pickId: p.pickId,
    capperId: p.capperId,
    betType: p.betType,
    period: p.period,
    betDetail: p.rawBetDetail,
    line: p.line,
    odds: p.odds,
    datePosted: new Date(p.datePosted),
    homeTeam: p.homeTeam,
    awayTeam: p.awayTeam,
    gameTime: new Date(p.gameTime),
    sportName: p.leagueName,
  };
}

export type SwapMode = "AUTO_HEDGE" | "CONTRARIAN";

export type SwapLeg = {
  gameId: string;
  gameLabel: string;
  original: RankedPick; // the Parlay A leg, exactly as it is there
  swap: {
    pick: GeneratorPick;
    rule: Rule;
    // The market record rankCandidates gated and ranked on.
    record: { wins: number; losses: number; n: number; winPct: number };
    wilsonLowerBound: number;
  } | null;
  // Why a leg stayed unchanged: no candidate cleared rankCandidates, or
  // (Contrarian only) the primary's side isn't the majority, so
  // rankCandidates rejects every candidate up front.
  unchangedReason: "NO_ALTERNATE" | "NOT_MAJORITY" | null;
};

export type SwapParlay = {
  mode: SwapMode;
  legs: SwapLeg[];
  swapCount: number;
};

export function buildSwapParlay(
  parlayA: AutoParlay,
  games: GeneratorGame[],
  mode: SwapMode,
  categoryRecords: Record<string, CategoryBreakdownItem | null>
): SwapParlay {
  const picksByGame = new Map(games.map((g) => [g.gameId, g.picks]));
  const legs: SwapLeg[] = parlayA.legs.map((leg) => {
    const gamePicks = picksByGame.get(leg.gameId) ?? [];
    const primary = toParlayLeg(leg.top.pick);
    // Only this game's picks are candidates, so every swap stays in the
    // same game and the parlay stays one leg per game.
    const others = gamePicks.filter((p) => p.pickId !== leg.top.pick.pickId);
    const ranked = rankCandidates(primary, others.map(toParlayLeg), mode, categoryRecords, gamePicks.map(toParlayLeg));
    const best = ranked[0];
    const bestPick = best ? others.find((p) => p.pickId === best.leg.pickId) : undefined;
    if (!best || !bestPick) {
      const notMajority = mode === "CONTRARIAN" && !contrarianHeadcountPasses(primary, gamePicks.map(toParlayLeg));
      return {
        gameId: leg.gameId,
        gameLabel: leg.gameLabel,
        original: leg.top,
        swap: null,
        unchangedReason: notMajority ? "NOT_MAJORITY" : "NO_ALTERNATE",
      };
    }
    return {
      gameId: leg.gameId,
      gameLabel: leg.gameLabel,
      original: leg.top,
      swap: { pick: bestPick, rule: best.rule, record: best.record, wilsonLowerBound: best.wilsonLowerBound },
      unchangedReason: null,
    };
  });
  return { mode, legs, swapCount: legs.filter((l) => l.swap !== null).length };
}
