// Auto-Generate's Primary + Alternates, and the no-repeat Regenerate.
//
// Why: Parlay A is fully deterministic (each game's #1 pick, from the
// top-ranked games), so regenerating used to return the same parlay. The
// Primary stays exactly that; the alternates are sampled.
//
//   - Shortlist: each game's #1 pick plus its existing "next picks" list
//     (NEXT_PICKS_SHOWN, after Include Picks filtering - the same list each
//     Parlay A leg already shows), plus any slip pick on that game that isn't
//     already on it. Ranked by compareByRecord, the one ranking Parlay A uses.
//   - Locks (from the Parlay slip, see lib/parlay/slip-build.ts): lockParlay
//     puts each locked pick and each locked game into Parlay A, displacing
//     its weakest unlocked legs. No locks: Parlay A is returned untouched.
//   - Alternates: the locked legs stay; the other legs rotate - games are
//     drawn weighted by their #1 pick's win %, and each drawn game's leg is
//     drawn from its shortlist weighted by win %. One leg per game. With a
//     Pick Mix, an alternate keeps the Primary's game line / prop split
//     where it can.
//   - Every parlay in a set differs from every other by at least
//     minLegDifference legs (2, or 1 for parlays of 3 legs or fewer), and
//     never equals a leg set the caller has already shown (`exclude`). Bounded
//     retries - when they run out the set is simply shorter, never a repeat.
//
// No gate: like Parlay A, nothing here is filtered by a qualification
// threshold - the ranking only orders. Pure: the caller passes the random
// source, so a test can seed it.
import {
  NEXT_PICKS_SHOWN,
  compareRankedPicks,
  rankGamePicks,
  type AutoLeg,
  type AutoParlay,
  type GeneratorGame,
  type GeneratorPick,
  type RankedPick,
} from "@/lib/parlay/auto-generate";
import { blocks } from "@/lib/parlay/build-my-picks";
import { toBuildCandidate } from "@/lib/parlay/pool-swap";
import { classifyPickKind, type PickKind } from "@/lib/parlay/pick-kind";
import type { ParlayRejection } from "@/lib/parlay/leg-cap";
import type { CapperLeagueRecords } from "@/server/data/picks";

import { legSetKey, type SlipHint } from "@/lib/parlay/parlay-set";

export { EMPTY_SLIP, legSetKey, NO_MORE_DISTINCT, type SlipHint } from "@/lib/parlay/parlay-set";

export type Rng = () => number;

// How many legs two parlays don't share (the larger side's count).
export function legDifference(a: readonly string[], b: readonly string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  return Math.max(a.filter((id) => !sb.has(id)).length, b.filter((id) => !sa.has(id)).length);
}

export function minLegDifference(legCount: number): number {
  return legCount <= 3 ? 1 : 2;
}

export function gameShortlist(game: GeneratorGame, records: CapperLeagueRecords, slipPickIds: ReadonlySet<string>): RankedPick[] {
  const ranked = rankGamePicks(game.picks, records);
  const list = ranked.slice(0, 1 + NEXT_PICKS_SHOWN);
  for (const r of ranked.slice(1 + NEXT_PICKS_SHOWN)) if (slipPickIds.has(r.pick.pickId)) list.push(r);
  return list;
}

// `gameRank` is where `top` ranks among its game's picks (1 = the game's #1);
// kept only when it isn't the #1, for the leg's "Why this leg?".
const legOf = (game: GeneratorGame, top: RankedPick, shortlist: RankedPick[], locked = false, gameRank = 1): AutoLeg => ({
  gameId: game.gameId,
  gameLabel: game.gameLabel,
  gameTime: game.gameTime,
  top,
  next: shortlist.filter((r) => r.pick.pickId !== top.pick.pickId).slice(0, NEXT_PICKS_SHOWN),
  ...(locked ? { locked: true } : {}),
  ...(gameRank > 1 ? { gameRank } : {}),
});

const pickLabel = (p: GeneratorPick) => `${p.capperName} — ${p.betDetail}`;

// A lock that can't be honoured. `missing` are the slip keys (pick id, or
// "game:" + game id) not found in this build's games, for the caller to name.
export type LockRejection = ParlayRejection & { missing?: string[] };

// Parlay A with the slip's locks applied. No locks: `parlayA` itself.
export function lockParlay(
  parlayA: AutoParlay,
  games: GeneratorGame[],
  records: CapperLeagueRecords,
  slip: SlipHint
): AutoParlay | LockRejection {
  const lockedPickIds = slip.picks.filter((p) => p.locked).map((p) => p.pickId);
  const lockedGameIds = slip.games.filter((g) => g.locked).map((g) => g.gameId);
  if (lockedPickIds.length === 0 && lockedGameIds.length === 0) return parlayA;

  const gameOfPick = new Map<string, GeneratorGame>();
  for (const g of games) for (const p of g.picks) gameOfPick.set(p.pickId, g);
  const gameById = new Map(games.map((g) => [g.gameId, g]));
  const missing = [
    ...lockedPickIds.filter((id) => !gameOfPick.has(id)),
    ...lockedGameIds.filter((id) => !gameById.get(id)?.picks.length).map((id) => "game:" + id),
  ];
  if (missing.length > 0) {
    return { error: "Some locked slip items aren't in this build's games, so they can't be locked in.", missing };
  }

  const lockedPicks = lockedPickIds.map((id) => gameOfPick.get(id)!.picks.find((p) => p.pickId === id)!);
  for (let i = 0; i < lockedPicks.length; i++) {
    for (let j = i + 1; j < lockedPicks.length; j++) {
      const { blocked, isDuplicate } = blocks(toBuildCandidate(lockedPicks[i]), toBuildCandidate(lockedPicks[j]));
      if (blocked) {
        return { error: `Locked picks ${pickLabel(lockedPicks[i])} and ${pickLabel(lockedPicks[j])} ${isDuplicate ? "are the same bet" : "conflict"} - unlock one.` };
      }
    }
  }

  const slipIds = new Set(slip.picks.map((p) => p.pickId));
  const locked: AutoLeg[] = [];
  for (const pick of lockedPicks) {
    const game = gameOfPick.get(pick.pickId)!;
    const shortlist = gameShortlist(game, records, slipIds);
    const top = shortlist.find((r) => r.pick.pickId === pick.pickId) ?? { pick, record: rankGamePicks([pick], records)[0].record };
    locked.push(legOf(game, top, shortlist, true));
  }
  const coveredGames = new Set(locked.map((l) => l.gameId));
  for (const id of lockedGameIds) {
    if (coveredGames.has(id)) continue;
    const game = gameById.get(id)!;
    const shortlist = gameShortlist(game, records, slipIds);
    locked.push(legOf(game, shortlist[0], shortlist, true));
    coveredGames.add(id);
  }
  if (locked.length > parlayA.requested) {
    return { error: `${locked.length} slip items are locked, but the parlay is only ${parlayA.requested} leg${parlayA.requested === 1 ? "" : "s"} - unlock some or add legs.` };
  }

  // Parlay A's own legs fill the rest, strongest first, skipping locked games.
  const room = Math.max(parlayA.legs.length, locked.length) - locked.length;
  const rest = parlayA.legs.filter((l) => !coveredGames.has(l.gameId)).slice(0, room);
  const legs = [...locked, ...rest].sort((a, b) => compareRankedPicks(a.top, b.top));
  return { ...parlayA, legs };
}

// Weighted by win % (a pick with no record weighs least, not nothing).
const weightOf = (r: RankedPick) => Math.max(r.record?.winPct ?? 0, 1);

// Weighted order without replacement (Efraimidis-Spirakis keys).
function weightedOrder<T>(items: T[], weight: (t: T) => number, rng: Rng): T[] {
  return items
    .map((item) => ({ item, key: Math.pow(Math.max(rng(), 1e-12), 1 / weight(item)) }))
    .sort((a, b) => b.key - a.key)
    .map((x) => x.item);
}

function weightedPick<T>(items: T[], weight: (t: T) => number, rng: Rng): T {
  const total = items.reduce((s, t) => s + weight(t), 0);
  let x = rng() * total;
  for (const t of items) {
    x -= weight(t);
    if (x <= 0) return t;
  }
  return items[items.length - 1];
}

export type ParlaySetInput = {
  games: GeneratorGame[];
  records: CapperLeagueRecords;
  slip: SlipHint;
  // The (locked) Primary: the first parlay of the set on a first Generate,
  // and the shape every alternate copies - its leg count, its locked legs,
  // its Pick Mix split. null-legs Primary: nothing to build.
  primary: AutoParlay;
  // Include the Primary in the set (a first Generate) or not (Regenerate).
  includePrimary: boolean;
  count: number;
  // Leg sets already shown this session (legSetKey) - never returned again.
  exclude: ReadonlySet<string>;
  // The legs a parlay adds beyond its one-per-game legs (the same-game fill),
  // so the leg sets compared and excluded are the parlays as shown.
  extraLegs: (parlay: AutoParlay) => string[];
  rng: Rng;
  maxTries?: number;
};

export type ParlaySet = {
  parlays: AutoParlay[];
  // Fewer than `count` distinct parlays could be found.
  exhausted: boolean;
};

const allLegIds = (p: AutoParlay, extra: (p: AutoParlay) => string[]) => [...p.legs.map((l) => l.top.pick.pickId), ...extra(p)];

export function buildParlaySet(input: ParlaySetInput): ParlaySet {
  const { games, records, slip, primary, rng, exclude, extraLegs } = input;
  const maxTries = input.maxTries ?? 60;
  const target = primary.legs.length;
  if (target === 0) return { parlays: [], exhausted: false };
  const minDiff = minLegDifference(allLegIds(primary, extraLegs).length);

  const slipIds = new Set(slip.picks.map((p) => p.pickId));
  const lockedLegs = primary.legs.filter((l) => l.locked);
  const lockedGames = new Set(lockedLegs.map((l) => l.gameId));
  const pool = games
    .filter((g) => g.picks.length > 0 && !lockedGames.has(g.gameId))
    .map((game) => ({
      game,
      shortlist: gameShortlist(game, records, slipIds),
      // Display only: each pick's place in its game's full ranking.
      rankOf: new Map(rankGamePicks(game.picks, records).map((r, i) => [r.pick.pickId, i + 1])),
    }));
  // With a Pick Mix, keep the Primary's split of game lines and props.
  const quota: Record<PickKind, number> | null = primary.mix ? { GAME_LINE: 0, PROP: 0 } : null;
  if (quota) for (const l of primary.legs) if (!l.locked) quota[classifyPickKind(l.top.pick)]++;

  const sample = (): AutoParlay => {
    const legs: AutoLeg[] = [...lockedLegs];
    const left = quota ? { ...quota } : null;
    const order = weightedOrder(pool, (g) => weightOf(g.shortlist[0]), rng);
    const used = new Set<string>();
    const fits = (r: RankedPick) => !legs.some((l) => blocks(toBuildCandidate(l.top.pick), toBuildCandidate(r.pick)).blocked);
    // Pass 1 honours the mix's quota; pass 2 fills what it left short.
    for (const strict of left ? [true, false] : [false]) {
      for (const { game, shortlist, rankOf } of order) {
        if (legs.length >= target) break;
        if (used.has(game.gameId)) continue;
        const options = shortlist.filter((r) => fits(r) && (!strict || left![classifyPickKind(r.pick)] > 0));
        if (options.length === 0) continue;
        const top = weightedPick(options, weightOf, rng);
        used.add(game.gameId);
        if (left) left[classifyPickKind(top.pick)]--;
        legs.push(legOf(game, top, shortlist, false, rankOf.get(top.pick.pickId)));
      }
    }
    legs.sort((a, b) => compareRankedPicks(a.top, b.top));
    return { ...primary, legs };
  };

  const parlays: AutoParlay[] = [];
  const shown: string[][] = [];
  const seen = new Set(exclude);
  const accept = (p: AutoParlay) => {
    const ids = allLegIds(p, extraLegs);
    parlays.push(p);
    shown.push(ids);
    seen.add(legSetKey(ids));
  };
  if (input.includePrimary && !seen.has(legSetKey(allLegIds(primary, extraLegs)))) accept(primary);

  let tries = 0;
  while (parlays.length < input.count && tries < maxTries) {
    tries++;
    const candidate = sample();
    const ids = allLegIds(candidate, extraLegs);
    if (ids.length === 0 || seen.has(legSetKey(ids))) continue;
    if (shown.some((other) => legDifference(ids, other) < minDiff)) continue;
    accept(candidate);
  }
  return { parlays, exhausted: parlays.length < input.count };
}
