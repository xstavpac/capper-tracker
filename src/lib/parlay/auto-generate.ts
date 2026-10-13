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
import { categoryRecordKey, type CapperLeagueRecords } from "@/server/data/picks";
import type { CategoryBreakdownItem } from "@/server/data/stats";
import type { ExpanderPick } from "@/components/live/game-picks-expander";
import { bestAvailableRecord, compareByRecord, type RankRecord } from "@/lib/parlay/pick-record";
import {
  compareByWilson,
  contrarianHeadcountPasses,
  qualifies,
  rankCandidates,
  toParlayCandidate,
  wilsonLowerBound,
  type ParlayLeg,
} from "@/lib/parlay/qualification-ranking";
import { sameGameConflict } from "@/lib/parlay/same-game-rules";
import { MAX_PARLAY_LEGS } from "@/lib/parlay/leg-cap";
import type { Rule } from "@/lib/parlay/relationship-classifier";

// gameNumber is the pick row's own doubleheader game number (Pick.gameNumber),
// null or absent when the pick never said which game it is on.
export type GeneratorPick = ExpanderPick & { datePosted: string; gameNumber?: number | null };

export type GeneratorGame = {
  gameId: string;
  gameLabel: string;
  gameTime: string;
  leagueName: string;
  picks: GeneratorPick[];
  // True when the same two teams play another game the same day. Only the
  // same-game fill reads it (see sureOfGame).
  doubleheader?: boolean;
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

// Win% desc, then bigger sample, then pick id - see compareByRecord.
export function compareRankedPicks(a: RankedPick, b: RankedPick): number {
  return compareByRecord({ pickId: a.pick.pickId, record: a.record }, { pickId: b.pick.pickId, record: b.record });
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
    gameId: p.gameId,
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

// ---------------------------------------------------------------------------
// Same-game fill ("Max legs per game" 2 or 3). Runs after Parlay A and never
// changes it: Parlay A is still exactly one leg per game, and these are extra
// legs from games Parlay A already has.
//
// Only fills a shortfall - it adds legs when Parlay A came up short of the
// requested count because there weren't enough games, and stops at that count.
// A candidate is any other pick on a Parlay A game that:
//   - clears the Section 3 gate (qualifies: 55%+ on the capper's all-leagues
//     record in the pick's own market - the record Hedge/Contrarian gate on,
//     not the record Parlay A ranks by). No pass for being on a game that is
//     already in the parlay.
//   - breaks no same-game rule (same-game-rules.ts) against any leg already
//     taken from its game.
// Candidates across all games are taken strongest first by Wilson lower bound
// (compareByWilson). A rejected candidate is skipped and the walk goes on - it
// never blocks the rest of its game or any other game. Nothing is padded:
// when no candidate is left the parlay stays short.
// ---------------------------------------------------------------------------
export type MaxLegsPerGame = 1 | 2 | 3;

export function toMaxLegsPerGame(value: unknown): MaxLegsPerGame {
  return value === 2 || value === 3 ? value : 1;
}

export type SameGameLeg = {
  gameId: string;
  gameLabel: string;
  gameTime: string;
  pick: GeneratorPick;
  // The record that qualified it - all leagues, this pick's market.
  record: { wins: number; losses: number; n: number; winPct: number };
  wilsonLowerBound: number;
};

export type SameGameFill = {
  maxLegsPerGame: MaxLegsPerGame;
  // In the order they were added: strongest first.
  legs: SameGameLeg[];
};

// On a doubleheader the board tells the two games apart, but a pick with no
// game number of its own was put on one of them by start time alone. Two legs
// are never paired on such a game unless both say which game they are on.
function sureOfGame(game: GeneratorGame, pick: GeneratorPick): boolean {
  return !game.doubleheader || pick.gameNumber != null;
}

export function buildSameGameLegs(
  parlayA: AutoParlay,
  games: GeneratorGame[],
  categoryRecords: Record<string, CategoryBreakdownItem | null>,
  maxLegsPerGame: MaxLegsPerGame
): SameGameFill {
  const fill: SameGameFill = { maxLegsPerGame, legs: [] };
  const room = Math.min(parlayA.requested, MAX_PARLAY_LEGS) - parlayA.legs.length;
  if (maxLegsPerGame <= 1 || room <= 0) return fill;

  const gameById = new Map(games.map((g) => [g.gameId, g]));
  const taken = new Map<string, GeneratorPick[]>();
  const candidates: SameGameLeg[] = [];

  for (const leg of parlayA.legs) {
    const game = gameById.get(leg.gameId);
    if (!game) continue;
    taken.set(leg.gameId, [leg.top.pick]);
    if (!sureOfGame(game, leg.top.pick)) continue;
    for (const pick of game.picks) {
      if (pick.pickId === leg.top.pick.pickId || !pick.category || !sureOfGame(game, pick)) continue;
      const record = categoryRecords[categoryRecordKey(pick.capperId, pick.category)] ?? null;
      if (!record || !qualifies(record)) continue;
      const { wins, losses, winPct } = record;
      candidates.push({
        gameId: leg.gameId,
        gameLabel: leg.gameLabel,
        gameTime: leg.gameTime,
        pick,
        record: { wins, losses, n: wins + losses, winPct },
        wilsonLowerBound: wilsonLowerBound(wins, losses),
      });
    }
  }

  candidates.sort((a, b) => compareByWilson({ ...a, pickId: a.pick.pickId }, { ...b, pickId: b.pick.pickId }));

  const asCandidate = (p: GeneratorPick) => toParlayCandidate(toParlayLeg(p));
  for (const candidate of candidates) {
    if (fill.legs.length >= room) break;
    const inGame = taken.get(candidate.gameId)!;
    if (inGame.length >= maxLegsPerGame) continue;
    if (inGame.some((p) => sameGameConflict(asCandidate(candidate.pick), asCandidate(p)) !== null)) continue;
    inGame.push(candidate.pick);
    fill.legs.push(candidate);
  }
  return fill;
}
