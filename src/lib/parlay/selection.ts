// The Parlay Generator's selection layer: which of the gated,
// scored candidates become legs. It reads the generator's score directly
// (rankScore x 100: record-score.ts's combined win %, in points) - no -110
// equivalent, no tie bands. Pure and client-safe: no React, no server imports,
// no storage.
//
//   Rank order - score descending, then betKey, then pick id (orderCandidates
//                with no draw). What `rank` means, and what a build with no
//                draw (the server's deterministic Primary, the frozen fixtures,
//                the backtests) takes.
//   A draw     - weighted sampling without replacement, weight
//                exp(beta * (score - top)) x exposure penalty, on a seedable RNG
//                (Gumbel top-k: the same distribution as drawing one leg at a
//                time). The mode (Best / Diversified / Explore) sets beta.
//                Generate draws on a fresh seed per click with no exposure
//                penalty; Regenerate draws with the penalty for every bet and
//                game already shown on this result card.
//
// Either way the order is filled greedily under the constraints, inside the
// fill, never as an after-filter:
//   - betKey dedupe: one leg per bet, whichever capper posted it;
//   - Max legs per game, counted with the legs already on a game (slip picks);
//   - the caller's same-game conflict test (same-game-rules.ts for generated
//     legs, build-my-picks.ts blocks() for Your picks only);
//   - optionally one leg per game before any same-game leg, and Pick Mix quotas
//     (a strict pass that takes only what a share still wants, then an open one).
// A fill that ends short while candidates remain tries a single swap - drop one
// chosen leg, refill - so a greedy first choice can't leave a parlay short when
// a valid swap existed.
//
// Your picks only (more picks than Total legs) adds signature tracking: a
// Regenerate rejects any combination already shown on the result card and, when
// random draws keep repeating, enumerates the valid combinations in rank order
// for the first unseen one. "No other parlays" only when that enumeration
// completes with nothing unseen; a node or wall-clock budget running out first
// is BUDGET_EXHAUSTED, never exhaustion.
import { describePick, describeProp } from "@/lib/parlay/relationship-classifier";
import { easternDateKey } from "@/lib/dates";

// ---------------------------------------------------------------------------
// Modes and tunables
// ---------------------------------------------------------------------------
export type SelectionMode = "BEST" | "DIVERSIFIED" | "EXPLORE";
export const SELECTION_MODES: readonly SelectionMode[] = ["BEST", "DIVERSIFIED", "EXPLORE"];
export const DEFAULT_SELECTION_MODE: SelectionMode = "DIVERSIFIED";

// Per point of combined win %. Measured on prod Regenerate traces (2026-11): a gated pool
// runs ~13-20 points from its top pick to its last (rank 2-3 ~3 points behind the top,
// rank 7-10 ~7, rank 16-20 ~10, rank 21+ ~13). The draw's noise (Gumbel, sd ~1.3 in
// log-weight) is worth 1.3 / beta points: ~1.3 under Best, so a Generate lands on the top
// parlay or a game or two from it; ~3.7 under Diversified; ~11 under Explore, a reach
// across most of the pool. A 4-point gap weighs ~55x under Best, ~4x under Diversified
// and ~1.6x under Explore. (The old 0.8 / 0.35 / 0.12 were set for the edge model's
// +2.6 to +10 range; Best is a little sharper now so a Generate in Best stays near the top.)
// Chosen on the fixture pools in generator-variety-acceptance-test.ts.
export const SELECTION_BETA: Record<SelectionMode, number> = { BEST: 1.0, DIVERSIFIED: 0.35, EXPLORE: 0.12 };

// The exposure penalty (Regenerate only): every earlier showing on THIS result card of
// the same bet (betKey) costs LEG_EXPOSURE_PENALTY in log-weight, and of a leg on the
// same game (gameExposureKey) GAME_EXPOSURE_PENALTY, each counted up to
// MAX_EXPOSURE_COUNTED showings. In points that is penalty / beta, so the same counts
// nudge Best a little and Explore a lot: one showing of a bet is ~1 point under Best,
// ~2.9 under Diversified and ~8 under Explore; of a game ~0.8 / ~2.3 / ~6.7. The game term
// is what rotates which games a parlay leaves out when there are more games than legs.
// The cap keeps a card's long run of Regenerates from pushing Best far from the top
// (a cap of 5-6 had Best changing as much as Diversified). Slip picks and their games
// are never penalized.
export const LEG_EXPOSURE_PENALTY = 1.0;
export const GAME_EXPOSURE_PENALTY = 0.8;
export const MAX_EXPOSURE_COUNTED = 3;

// Random draws a Regenerate makes before it settles (Standard) or enumerates (Your picks only).
export const STANDARD_DRAW_TRIES = 12;
export const SUBSET_DRAW_TRIES = 50;
// The enumeration's budget: search nodes and wall-clock time, whichever runs out first.
export const ENUMERATION_NODE_BUDGET = 200_000;
export const ENUMERATION_TIME_BUDGET_MS = 50;

// Names the selection layer in the run log's scoringVersion.
export const SELECTION_VERSION = "sel-v1";

// ---------------------------------------------------------------------------
// RNG
// ---------------------------------------------------------------------------
export type Rng = () => number;

// mulberry32: small, seedable, good enough to shuffle a slate.
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A seed per page load: crypto when there is one, Math.random otherwise.
export function freshSeed(): number {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto;
  if (c?.getRandomValues) return c.getRandomValues(new Uint32Array(1))[0];
  return Math.floor(Math.random() * 4294967296);
}

// A seed derived from another and a label (FNV-1a), so one Regenerate's sub-draws
// (each try, each Hedge leg) are independent but reproducible.
export function deriveSeed(seed: number, label: string | number): number {
  let h = (0x811c9dc5 ^ (seed >>> 0)) >>> 0;
  const s = String(label);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// betKey: one bet, whichever capper posted it
// ---------------------------------------------------------------------------
export type BetKeyPick = {
  gameId: string;
  betType: string;
  period: string;
  rawBetDetail: string | null;
  line: number | null;
  homeTeam: string;
  awayTeam: string;
  gameTime: string;
  leagueName: string;
};

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));

// From the Relationship Classifier's own description of the pick: game, market,
// scope, side or direction, line. A pick it can't describe falls back on its own
// text, so two such picks are one bet only when they read the same.
export function betKeyOf(p: BetKeyPick): string {
  const input = { betType: p.betType, period: p.period, betDetail: p.rawBetDetail, line: p.line };
  if (p.betType === "PLAYER_PROP") {
    // With its league, so an NBA prop is read by the basketball parser (no-sport text reads none of its markets).
    const d = describeProp(input, p.leagueName);
    if (d.status === "OK") return [p.gameId, "PROP", p.period, d.player, d.market, d.direction, fmt(d.line)].join("|");
  } else {
    const d = describePick(input, { homeTeam: p.homeTeam, awayTeam: p.awayTeam, gameTime: new Date(p.gameTime), sportName: p.leagueName, gameId: p.gameId });
    if (d.status === "OK") return [p.gameId, p.betType, d.period, d.level ?? "", d.direction ?? "", d.teamTarget ?? "", fmt(d.line)].join("|");
  }
  return [p.gameId, "RAW", p.betType, p.period, (p.rawBetDetail ?? "").trim().toLowerCase().replace(/\s+/g, " "), fmt(p.line)].join("|");
}

// ---------------------------------------------------------------------------
// Exposure: what this result card has already shown
// ---------------------------------------------------------------------------
// How many parlays shown on this result card (Generate's and every Regenerate's) held
// each bet (betKey) and each game (gameExposureKey). The session keeps it in memory and
// resets it on Generate / Refresh; nothing is stored between page loads.
export type Exposure = { legs: Readonly<Record<string, number>>; games: Readonly<Record<string, number>> };
export const NO_EXPOSURE: Exposure = { legs: {}, games: {} };

// One game, as the server names it: sport + the two teams (either order) + the Eastern
// date + the doubleheader game number (0 when none is known). Stable across snapshot
// reloads, unlike a board's game id. Read off each pick (the engine's candidates and the
// session's shown legs alike, so the two always agree); a doubleheader pick that doesn't
// say which game it is on keys as 0, so such picks on the two games count as one game -
// a penalty shared, never a constraint broken.
export type GameKeyInput = { leagueName: string; homeTeam: string; awayTeam: string; gameTime: string; gameNumber?: number | null };
export function gameExposureKey(g: GameKeyInput): string {
  const teams = [g.homeTeam.trim().toLowerCase(), g.awayTeam.trim().toLowerCase()].sort();
  const t = new Date(g.gameTime);
  const day = Number.isNaN(t.getTime()) ? g.gameTime : easternDateKey(t);
  return [g.leagueName, teams[0], teams[1], day, g.gameNumber ?? 0].join("|");
}

// The exposure penalty for one candidate, as multipliers on its weight: the bet's, the
// game's (1 when the candidate has no gameKey - a slip pick's game), and both together.
export function exposureMultiplier(betKey: string, gameKey: string | undefined, exposure: Exposure): { leg: number; game: number; total: number } {
  const nLeg = Math.min(MAX_EXPOSURE_COUNTED, exposure.legs[betKey] ?? 0);
  const nGame = gameKey === undefined ? 0 : Math.min(MAX_EXPOSURE_COUNTED, exposure.games[gameKey] ?? 0);
  const leg = Math.exp(-LEG_EXPOSURE_PENALTY * nLeg);
  const game = Math.exp(-GAME_EXPOSURE_PENALTY * nGame);
  return { leg, game, total: leg * game };
}

// Counts one shown parlay's legs into an exposure (a new object; the old one is untouched).
export function addExposure(exposure: Exposure, betKeys: readonly string[], gameKeys: readonly string[]): Exposure {
  const legs = { ...exposure.legs };
  const games = { ...exposure.games };
  for (const k of new Set(betKeys)) legs[k] = (legs[k] ?? 0) + 1;
  for (const k of new Set(gameKeys)) games[k] = (games[k] ?? 0) + 1;
  return { legs, games };
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------
export type SelectionCandidate<T> = {
  item: T;
  id: string;
  betKey: string;
  gameId: string;
  // rankScore in percentage points (scoring.ts edge x 100).
  score: number;
  // Pick Mix category, when a quota applies.
  category?: string;
  // The game's exposure identity (gameExposureKey). Absent: no game penalty (a slip pick's game).
  gameKey?: string;
};

export type Ranked<T> = SelectionCandidate<T> & {
  // 1-based position in the rank order (no draw).
  rank: number;
  // The draw weight relative to the top candidate: exp(beta * (score - top)) x reuse. 1 with no draw.
  weight: number;
  // The exposure penalty, as a multiplier: the bet's and the game's together, then each alone. 1 with none.
  reuse: number;
  legReuse: number;
  gameReuse: number;
};

// exposure: Regenerate's penalty for what this result card has shown; absent (Generate) is none.
export type DrawOptions = { rng: Rng; beta: number; exposure?: Exposure };

export const byScoreThenKey = <T>(a: SelectionCandidate<T>, b: SelectionCandidate<T>): number =>
  b.score !== a.score ? b.score - a.score : a.betKey < b.betKey ? -1 : a.betKey > b.betKey ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

// The rank order (no draw), or one draw: Gumbel top-k over log-weights, which is
// weighted sampling without replacement.
export function orderCandidates<T>(candidates: readonly SelectionCandidate<T>[], draw: DrawOptions | null): Ranked<T>[] {
  const base = [...candidates].sort(byScoreThenKey);
  const top = base.length > 0 ? base[0].score : 0;
  const exposure = draw?.exposure ?? NO_EXPOSURE;
  const ranked: Ranked<T>[] = base.map((c, i) => {
    const m = draw ? exposureMultiplier(c.betKey, c.gameKey, exposure) : { leg: 1, game: 1, total: 1 };
    return { ...c, rank: i + 1, reuse: m.total, legReuse: m.leg, gameReuse: m.game, weight: draw ? Math.exp(draw.beta * (c.score - top)) * m.total : 1 };
  });
  if (!draw) return ranked;
  const keyed = ranked.map((r) => {
    const u = Math.min(Math.max(draw.rng(), 1e-300), 1 - 1e-16);
    return { r, key: draw.beta * (r.score - top) + Math.log(r.reuse) - Math.log(-Math.log(u)) };
  });
  keyed.sort((a, b) => b.key - a.key || a.r.rank - b.r.rank);
  return keyed.map((k) => k.r);
}

// ---------------------------------------------------------------------------
// The constrained fill
// ---------------------------------------------------------------------------
export type PreLeg<L> = { gameId: string; leg: L; betKey: string };

export type FillRules<T, L> = {
  need: number;
  maxPerGame: number;
  // Legs already on their games (slip picks): counted against the cap and checked for conflicts.
  preLegs: readonly PreLeg<L>[];
  legOf: (item: T) => L;
  // True when two legs on one game can't both be in the parlay.
  conflict: (a: L, b: L, gameId: string) => boolean;
  // Pick Mix: legs each category still wants, or null.
  quota?: Partial<Record<string, number>> | null;
  // Pick Mix categories whose share is 0: never a leg, in the strict or the open
  // pass, so a shortfall is never filled from a category the user turned off.
  excludeCategories?: readonly string[];
  // One leg per game (with no leg yet) before any same-game leg.
  oneLegPerGameFirst: boolean;
};

export function fillLegs<T, L>(order: readonly Ranked<T>[], rules: FillRules<T, L>, exclude: ReadonlySet<string> = new Set()): Ranked<T>[] {
  const chosen: Ranked<T>[] = [];
  if (rules.need <= 0) return chosen;
  const onGame = new Map<string, L[]>();
  const keys = new Set<string>();
  for (const p of rules.preLegs) {
    onGame.set(p.gameId, [...(onGame.get(p.gameId) ?? []), p.leg]);
    keys.add(p.betKey);
  }
  const preGames = new Set(onGame.keys());
  const left = rules.quota ? { ...rules.quota } : null;
  const picked = new Set<string>();
  const fits = (c: Ranked<T>) => {
    if (picked.has(c.id) || exclude.has(c.id) || keys.has(c.betKey)) return false;
    const legs = onGame.get(c.gameId) ?? [];
    if (legs.length >= rules.maxPerGame) return false;
    const leg = rules.legOf(c.item);
    return legs.every((l) => !rules.conflict(leg, l, c.gameId));
  };
  const off = new Set(rules.excludeCategories ?? []);
  const allows = (c: Ranked<T>, strict: boolean) =>
    !(c.category !== undefined && off.has(c.category)) && (!strict || (c.category !== undefined && (left![c.category] ?? 0) > 0));
  const take = (c: Ranked<T>) => {
    chosen.push(c);
    picked.add(c.id);
    keys.add(c.betKey);
    onGame.set(c.gameId, [...(onGame.get(c.gameId) ?? []), rules.legOf(c.item)]);
    if (left && c.category !== undefined && left[c.category] !== undefined) left[c.category]!--;
  };
  const passes = left ? [true, false] : [false];
  if (rules.oneLegPerGameFirst) {
    // Pass 1: one leg per game that has none yet (slip legs included), best first.
    const gamesTaken = new Set<string>();
    for (const strict of passes) {
      for (const c of order) {
        if (chosen.length >= rules.need) break;
        if (preGames.has(c.gameId) || gamesTaken.has(c.gameId)) continue;
        if (!allows(c, strict) || !fits(c)) continue;
        take(c);
        gamesTaken.add(c.gameId);
      }
    }
    // Pass 2: same-game legs, only when games ran out.
    if (chosen.length < rules.need && rules.maxPerGame > 1) {
      for (const strict of passes) {
        for (const c of order) {
          if (chosen.length >= rules.need) break;
          if (allows(c, strict) && fits(c)) take(c);
        }
      }
    }
  } else {
    for (const strict of passes) {
      for (const c of order) {
        if (chosen.length >= rules.need) break;
        if (allows(c, strict) && fits(c)) take(c);
      }
    }
  }
  return chosen;
}

// The fill, plus the single-swap repair: when it comes up short, drop one chosen
// leg at a time (weakest first) and refill without it; keep the first refill that
// is longer, and repeat while that helps.
export function selectLegs<T, L>(order: readonly Ranked<T>[], rules: FillRules<T, L>): { chosen: Ranked<T>[]; repaired: number } {
  let chosen = fillLegs(order, rules);
  let repaired = 0;
  const excluded = new Set<string>();
  while (chosen.length < rules.need && chosen.length < order.length - excluded.size) {
    let better: Ranked<T>[] | null = null;
    for (let i = chosen.length - 1; i >= 0 && !better; i--) {
      const without = new Set([...excluded, chosen[i].id]);
      const refill = fillLegs(order, rules, without);
      if (refill.length > chosen.length) {
        better = refill;
        excluded.add(chosen[i].id);
      }
    }
    if (!better) break;
    chosen = better;
    repaired++;
  }
  return { chosen, repaired };
}

// ---------------------------------------------------------------------------
// Signatures and enumeration (Your picks only)
// ---------------------------------------------------------------------------
export const signatureOf = (ids: readonly string[]): string => [...ids].sort().join(",");

export type EnumerationResult<T> = {
  // The first unseen valid combination, in rank order, or null.
  found: Ranked<T>[] | null;
  // The first valid combination that differs from `onScreen` (for BUDGET_EXHAUSTED).
  differsFromScreen: Ranked<T>[] | null;
  // Valid combinations visited.
  combos: number;
  nodes: number;
  complete: boolean;
  budgetExhausted: boolean;
};

// Depth-first over the deterministic order, choosing exactly `size` legs under the
// cap, betKey dedupe and the conflict test. Stops at the first unseen combination,
// or when the node or time budget runs out (complete = false).
export function enumerateCombos<T, L>(
  base: readonly Ranked<T>[],
  rules: Pick<FillRules<T, L>, "maxPerGame" | "legOf" | "conflict">,
  size: number,
  seen: ReadonlySet<string>,
  onScreen: string | null,
  budget: { nodes?: number; ms?: number; clock?: () => number } = {}
): EnumerationResult<T> {
  const maxNodes = budget.nodes ?? ENUMERATION_NODE_BUDGET;
  const maxMs = budget.ms ?? ENUMERATION_TIME_BUDGET_MS;
  const clock = budget.clock ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const start = clock();
  const res: EnumerationResult<T> = { found: null, differsFromScreen: null, combos: 0, nodes: 0, complete: false, budgetExhausted: false };
  const stack: Ranked<T>[] = [];
  const onGame = new Map<string, L[]>();
  const keys = new Set<string>();
  const n = base.length;
  const walk = (from: number): boolean => {
    if (stack.length === size) {
      res.combos++;
      const sig = signatureOf(stack.map((s) => s.id));
      if (!res.differsFromScreen && sig !== onScreen) res.differsFromScreen = [...stack];
      if (!seen.has(sig)) {
        res.found = [...stack];
        return true;
      }
      return false;
    }
    for (let i = from; i <= n - (size - stack.length); i++) {
      res.nodes++;
      if (res.nodes > maxNodes || (res.nodes % 256 === 0 && clock() - start > maxMs)) {
        res.budgetExhausted = true;
        return true;
      }
      const c = base[i];
      if (keys.has(c.betKey)) continue;
      const legs = onGame.get(c.gameId) ?? [];
      if (legs.length >= rules.maxPerGame) continue;
      const leg = rules.legOf(c.item);
      if (legs.some((l) => rules.conflict(leg, l, c.gameId))) continue;
      stack.push(c);
      keys.add(c.betKey);
      onGame.set(c.gameId, [...legs, leg]);
      const stop = walk(i + 1);
      stack.pop();
      keys.delete(c.betKey);
      onGame.set(c.gameId, legs);
      if (stop) return true;
    }
    return false;
  };
  if (size > 0) walk(0);
  res.complete = !res.found && !res.budgetExhausted;
  return res;
}

// ---------------------------------------------------------------------------
// The run log's view of a selection
// ---------------------------------------------------------------------------
// reused: the bet was already shown on this card; gameReused: its game was.
export type SelectionLegTrace = { id: string; rank: number; weight: number; reused?: boolean; gameReused?: boolean };

// How a build varied, for the run log: the outcome, how many of the varied legs (historyIds) are new
// against the parlay on screen before it (null with none), and the shape of the pool - games with a
// qualifying pick against the legs to generate (eligibleGames / legsNeeded is the rotation headroom).
export type VarietyTrace = {
  variety: "BEST" | "VARIED" | "NO_ALTERNATIVE";
  noAlternativeReason: "ALL_PICKS_USED" | "NO_COMPARABLE" | null;
  changed: number | null;
  previous: number | null;
  eligibleGames: number;
  legsNeeded: number;
};

export type SelectionTrace = {
  trigger: "GENERATE" | "REGENERATE";
  mode: SelectionMode | null;
  beta: number | null;
  // The draw's seed - Generate's too - so any build can be rebuilt; null for a build with no draw.
  seed: number | null;
  legs: SelectionLegTrace[];
  hedge?: SelectionLegTrace[];
  // Contrarian's picks under SCORING (Swap = All), as hedge.
  contrarian?: SelectionLegTrace[];
  // Chosen legs whose bet was already shown on this card, and whose game was.
  reuseHits: number;
  gameReuseHits?: number;
  outcome?: VarietyTrace;
  // Your picks only: draws rejected as already shown, valid combinations the
  // enumeration visited, and whether its budget ran out.
  rejectedCombos?: number;
  combos?: number;
  budgetExhausted?: boolean;
  exhausted?: boolean;
  repaired?: number;
};

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

export function legTrace<T>(r: Ranked<T>): SelectionLegTrace {
  return { id: r.id, rank: r.rank, weight: round4(r.weight), ...(r.legReuse < 1 ? { reused: true } : {}), ...(r.gameReuse < 1 ? { gameReused: true } : {}) };
}
