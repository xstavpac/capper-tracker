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
//
// "Include Picks" (All / Game Lines / Props) narrows every game's picks before
// any of this runs (filterGamesByInclude). A Pick Mix, with All, sets how many
// of Parlay A's legs come from each kind (buildMixedParlay); the ranking above
// still picks which. pick-kind.ts is the only thing that says which kind a
// pick is.
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
  toParlayLeg,
  wilsonLowerBound,
} from "@/lib/parlay/qualification-ranking";
import type { GameFeedStatus } from "@/lib/parlay/game-over";
import { sameGameConflict } from "@/lib/parlay/same-game-rules";
import { MAX_LEGS_PER_GAME, MAX_PARLAY_LEGS } from "@/lib/parlay/leg-cap";
import type { Rule } from "@/lib/parlay/relationship-classifier";
import { classifyPickKind, type PickKind } from "@/lib/parlay/pick-kind";
import { includedKind, keepsPick, mixSplit, type IncludePicks, type MixSplit } from "@/lib/parlay/pick-mix";

// gameNumber is the pick row's own doubleheader game number (Pick.gameNumber),
// null or absent when the pick never said which game it is on.
export type GeneratorPick = ExpanderPick & { datePosted: string; gameNumber?: number | null };

export type GeneratorGame = {
  gameId: string;
  gameLabel: string;
  gameTime: string;
  // The score feed's status for the game (game-over.ts); null/absent when unknown.
  gameStatus?: GameFeedStatus | null;
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
  // Put in by a Parlay slip lock (lockParlay, alternates.ts) - kept in every
  // alternate. Absent on every leg when the slip has no locks.
  locked?: boolean;
  // An alternate's leg that isn't its game's #1 pick: where it ranked (2 =
  // the game's #2). Display only - absent on Parlay A's own legs.
  gameRank?: number;
};

// Set only when a Pick Mix was applied (Include Picks = All with a custom
// mix): the Game Lines share and the leg counts it asked for.
export type AutoMix = { gameLinesPct: number; target: MixSplit };

export type AutoParlay = {
  requested: number;
  // Games with at least one pick - the most legs Parlay A can have.
  available: number;
  // min(requested, available) legs, strongest #1 pick first. When
  // available < requested the UI must ask before showing this.
  legs: AutoLeg[];
  mix?: AutoMix;
};

// Win% desc, then bigger sample, then pick id - see compareByRecord.
export function compareRankedPicks(a: RankedPick, b: RankedPick): number {
  return compareByRecord({ pickId: a.pick.pickId, record: a.record }, { pickId: b.pick.pickId, record: b.record });
}

export function rankGamePicks(picks: GeneratorPick[], records: CapperLeagueRecords): RankedPick[] {
  return picks.map((pick) => ({ pick, record: bestAvailableRecord(pick, records) })).sort(compareRankedPicks);
}

// "Include Picks": every game keeps only the picks of the kind asked for (all
// of them for ALL). Games left with no picks stay, empty - buildAutoParlay
// already skips those. Run once, before every builder below, so Parlay A, the
// same-game fill and Hedge/Contrarian all see the same picks.
export function filterGamesByInclude(games: GeneratorGame[], include: IncludePicks): GeneratorGame[] {
  if (include === "ALL") return games;
  return games.map((g) => ({ ...g, picks: g.picks.filter((p) => keepsPick(include, p)) }));
}

// gameLinesPct (a Pick Mix, see pick-mix.ts) is only ever passed with Include
// Picks = All. Without it, Parlay A is exactly what it always was.
export function buildAutoParlay(
  games: GeneratorGame[],
  records: CapperLeagueRecords,
  requested: number,
  gameLinesPct: number | null = null
): AutoParlay {
  if (gameLinesPct !== null) return buildMixedParlay(games, records, requested, gameLinesPct);
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

// Parlay A with a Pick Mix. The mix decides HOW MANY legs come from game lines
// and from props; the same ranking as above decides WHICH. Still one leg per
// game.
//   1. Each game offers its best game line and its best prop (when it has
//      them). Walking every offer strongest first, take one while its pool
//      still has quota and its game is unused - so a game is never spent on
//      its weaker market while its stronger one still had room.
//   2. Shortfall: a pool that ran out of games leaves its legs to the other
//      pool's best remaining offers. Never fails because the mix can't be met;
//      buildMixNotes says what happened.
// Same-game legs come after, from buildSameGameLegs, only if games run out.
function buildMixedParlay(games: GeneratorGame[], records: CapperLeagueRecords, requested: number, gameLinesPct: number): AutoParlay {
  const target = mixSplit(requested, gameLinesPct);
  type Offer = { game: GeneratorGame; kind: PickKind; top: RankedPick; ranked: RankedPick[] };
  const offers: Offer[] = [];
  let available = 0;
  for (const game of games) {
    if (game.picks.length === 0) continue;
    available++;
    const ranked = rankGamePicks(game.picks, records);
    for (const kind of ["GAME_LINE", "PROP"] as const) {
      const top = ranked.find((r) => classifyPickKind(r.pick) === kind);
      if (top) offers.push({ game, kind, top, ranked });
    }
  }
  offers.sort((a, b) => compareRankedPicks(a.top, b.top));

  const left: Record<PickKind, number> = { GAME_LINE: target.gameLines, PROP: target.props };
  const used = new Set<string>();
  const legs: AutoLeg[] = [];
  const take = (o: Offer) => {
    used.add(o.game.gameId);
    legs.push({
      gameId: o.game.gameId,
      gameLabel: o.game.gameLabel,
      gameTime: o.game.gameTime,
      top: o.top,
      next: o.ranked.filter((r) => r !== o.top).slice(0, NEXT_PICKS_SHOWN),
    });
  };
  for (const o of offers) {
    if (left[o.kind] <= 0 || used.has(o.game.gameId)) continue;
    take(o);
    left[o.kind]--;
  }
  // Whatever pass 1 left short can only be filled by the other pool: an offer
  // of the short pool on an unused game would have been taken above.
  for (const o of offers) {
    if (legs.length >= requested) break;
    if (!used.has(o.game.gameId)) take(o);
  }
  legs.sort((a, b) => compareRankedPicks(a.top, b.top));
  return { requested, available, legs, mix: { gameLinesPct, target } };
}

const KIND_NOUN: Record<PickKind, [string, string]> = { GAME_LINE: ["game line", "game lines"], PROP: ["prop", "props"] };
const KIND_LABEL: Record<PickKind, string> = { GAME_LINE: "Game Lines", PROP: "Props" };
const legsText = (n: number) => `${n} leg${n === 1 ? "" : "s"}`;

// What a Pick Mix couldn't meet, as the plain-text notes the result shows
// ("Only 1 eligible prop — filled 2 extra legs with Game Lines."). Counts the
// finished parlay - Parlay A plus its same-game legs. Empty when the mix was
// met, or no mix was set.
export function buildMixNotes(parlayA: AutoParlay, sameGame?: SameGameFill): string[] {
  if (!parlayA.mix) return [];
  const count: Record<PickKind, number> = { GAME_LINE: 0, PROP: 0 };
  for (const l of parlayA.legs) count[classifyPickKind(l.top.pick)]++;
  for (const l of sameGame?.legs ?? []) count[classifyPickKind(l.pick)]++;
  const target: Record<PickKind, number> = { GAME_LINE: parlayA.mix.target.gameLines, PROP: parlayA.mix.target.props };
  const notes: string[] = [];
  for (const kind of ["GAME_LINE", "PROP"] as const) {
    const other: PickKind = kind === "GAME_LINE" ? "PROP" : "GAME_LINE";
    if (count[kind] >= target[kind]) continue;
    const [one, many] = KIND_NOUN[kind];
    const have = count[kind] === 0 ? `No eligible ${many}` : `Only ${count[kind]} eligible ${count[kind] === 1 ? one : many}`;
    const extra = count[other] - target[other];
    notes.push(
      extra > 0
        ? `${have} — filled ${extra} extra leg${extra === 1 ? "" : "s"} with ${KIND_LABEL[other]}.`
        : `${have} for the ${legsText(target[kind])} of ${KIND_LABEL[kind]} in your mix.`
    );
  }
  return notes;
}

// The empty state for a filter that leaves a league nothing to offer ("No
// props available for WNBA right now."). Read off the in-window picks
// themselves - there is no list of which leagues have props. `games` is the
// slate BEFORE filterGamesByInclude. null for All, or when every league has
// at least one pick of the kind.
export function filterEmptyNote(games: GeneratorGame[], include: IncludePicks, leagues: string[]): string | null {
  const kind = includedKind(include);
  if (kind === null) return null;
  const empty = leagues.filter(
    (league) => !games.some((g) => g.leagueName === league && g.picks.some((p) => classifyPickKind(p) === kind))
  );
  if (empty.length === 0) return null;
  return `No ${KIND_NOUN[kind][1]} available for ${empty.join(", ")} right now.`;
}

// Hedge and Contrarian only ever swap game lines (classifyPair has no rule for
// a player prop), so a parlay with no game-line leg has no variant to show.
export const SWAP_GAME_LINES_ONLY_NOTE = "Hedge and Contrarian swap game lines only.";

export function swapVariantNote(include: IncludePicks, parlayA: AutoParlay): string | null {
  const anyGameLine = parlayA.legs.some((l) => classifyPickKind(l.top.pick) === "GAME_LINE");
  return include === "PROPS" || !anyGameLine ? SWAP_GAME_LINES_ONLY_NOTE : null;
}

// Lives in qualification-core.ts (client-safe); re-exported for existing imports.
export { toParlayLeg };

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
// Same-game fill ("Max legs per game" 2 to 5). Runs after Parlay A and never
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
export type MaxLegsPerGame = 1 | 2 | 3 | 4 | 5;

// Never trusted as sent: a whole number from 1 to MAX_LEGS_PER_GAME, else 1.
export function toMaxLegsPerGame(value: unknown): MaxLegsPerGame {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_LEGS_PER_GAME ? (value as MaxLegsPerGame) : 1;
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
  const fits = (candidate: SameGameLeg) => {
    const inGame = taken.get(candidate.gameId)!;
    return inGame.length < maxLegsPerGame && !inGame.some((p) => sameGameConflict(asCandidate(candidate.pick), asCandidate(p)) !== null);
  };

  // With a Pick Mix, a pool Parlay A left short is served first: the strongest
  // candidate that fits AND is of a short pool, else the strongest that fits.
  // Without a mix nothing is short and this is the plain strongest-first walk.
  // A candidate that doesn't fit never fits later (games only fill up), so
  // searching from the top each time skips nothing it shouldn't.
  const short: Record<PickKind, number> = { GAME_LINE: 0, PROP: 0 };
  if (parlayA.mix) {
    short.GAME_LINE = parlayA.mix.target.gameLines;
    short.PROP = parlayA.mix.target.props;
    for (const leg of parlayA.legs) short[classifyPickKind(leg.top.pick)]--;
  }
  const pending = [...candidates];
  while (fill.legs.length < room) {
    let i = pending.findIndex((c) => short[classifyPickKind(c.pick)] > 0 && fits(c));
    if (i < 0) i = pending.findIndex(fits);
    if (i < 0) break;
    const [candidate] = pending.splice(i, 1);
    taken.get(candidate.gameId)!.push(candidate.pick);
    short[classifyPickKind(candidate.pick)]--;
    fill.legs.push(candidate);
  }
  return fill;
}
