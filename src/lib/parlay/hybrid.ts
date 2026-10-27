// Consensus Hybrid's optimizer: turns ranked consensus positions (consensus.ts),
// FanDuel's alternate-line ladders (server/data/alt-ladders.ts) and both teams'
// recent swings (recent-swings.ts) into a priced hybrid. Pure: no I/O, no DB, no
// fetch, no clock. Client-safe.
//
// The primary hybrid is a SAME-GAME BOX: one game, one team-side leg (the merged
// ML + spread position) plus one total leg. Consensus picks each leg's side;
// recent games place each leg's edge on a forgiving alternate line; the target
// odds fine-tune.
//
// Per leg:
//   1. Tonight's line: the ladder point whose two sides are priced closest to
//      each other (implied probability). A team side also tries the moneyline
//      pair as pick'em (0) when the h2h ladder is there - in hockey and baseball
//      that is the main line, since the alternate spreads start at 1.5.
//   2. The edge, from recent swings measured against each past game's own line
//      and applied to tonight's line:
//        Over   tonight - the worst under-miss (both teams' totalMiss)
//        Under  tonight + the worst over-miss
//        Side T T's spread + the worst miss (T's coverMargin, and the
//               opponent's coverMargin negated: the opponent covering by X is
//               T missing by X)
//      A meeting of the two teams sits in both teams' lists; it is counted once.
//      `balanced` sets aside the single biggest miss (when there are at least two
//      games); `wider` uses them all. A team with fewer than 3 games carrying the
//      line in question uses its raw scores instead (Over: the lowest recent
//      total; Under: the highest; side: the worst losing margin), and the leg is
//      marked edgeSource "raw". With both kinds in play the more forgiving edge
//      wins. Football spreads landing at or within 0.5 of 3 / 7 / 10 / 14 move to
//      the forgiving side of that key number.
//   3. Snap: the least forgiving rung at or past both the edge and the anchor
//      (consensus.ts: the easiest endorsed line). Rungs priced under
//      HYBRID_MIN_LEG_PRICE, or outside the optional per-leg range, are never
//      candidates. When the ladder runs out before the edge, the most forgiving
//      rung left is used and the reason says so.
//
// Fine-tuning, in implied probability: the target range is a probability band.
// An edge-placed hybrid inside it is kept. Too short (more likely than the
// band): legs tighten back toward the anchor, never past it. Too long: legs
// push further out. Among in-band combinations: fewest rungs moved from the
// edges, then the more even split between legs, then closest to the band's
// middle. With nothing in band, the combination closest to the band.
//
// Games: a box needs a qualifying team side AND a qualifying total on the same
// game (one of each - never both teams, never Over and Under); a game scores the
// sum of the two. The top HYBRID_CANDIDATE_GAMES are built; the result is a
// primary plus up to HYBRID_ALTERNATES alternates, each on a different game.
// Only when no box lands in the band, each box may take up to two more single
// edge-placed legs from other games (next-best position first, kept only when
// it gets strictly closer; HYBRID_MAX_LEGS in all). With no box-eligible game,
// the top two positions on different games make a cross-game hybrid.
//
// Pricing: the product of the legs' decimal prices (combine-odds.ts). FanDuel
// prices a same-game combination as an SGP, which we do not get, so any hybrid
// with two legs on one game is `isEstimate: true` - no correlation adjustment is
// guessed. A cross-game hybrid's product is exact.
import { americanToDecimal, combineOdds, hasUsablePrice } from "@/lib/parlay/combine-odds";
import type { ConsensusPosition, HybridFamily, PositionCapper } from "@/lib/parlay/consensus";
import type { SwingGame } from "@/lib/parlay/recent-swings";
import { normalizeTeamName, teamNamesMatch } from "@/lib/team-name-match";

// No leg is priced shorter than this.
export const HYBRID_MIN_LEG_PRICE = -600;
export const HYBRID_MAX_LEGS = 4;
export const HYBRID_DEFAULT_TARGET_MIN = -140;
export const HYBRID_DEFAULT_TARGET_MAX = -110;
// Box-eligible games evaluated, and alternates returned beside the primary.
export const HYBRID_CANDIDATE_GAMES = 6;
export const HYBRID_ALTERNATES = 2;
// Recent games read per team, and how many must carry the line for it to be used.
export const HYBRID_SWING_GAMES = 5;
export const HYBRID_MIN_STORED_GAMES = 3;
const FOOTBALL_KEY_NUMBERS = [3, 7, 10, 14];
// Consensus supporters shown per leg.
const TOP_SUPPORTERS = 3;
const EPS = 1e-9;

// ---- Inputs ----

export type HybridMarketKey = "alternate_spreads" | "alternate_totals" | "h2h";

// The fields of server/data/alt-ladders.ts AltLadder this file reads (an
// AltLadderResult is assignable to HybridLadders).
export type HybridLadderOutcome = { name: string; point?: number; price: number; sid?: string; link?: string };
export type HybridLadder = { outcomes: HybridLadderOutcome[]; marketLastUpdate: Date | string | null; isStale: boolean };
export type HybridLadders = Record<string, Partial<Record<HybridMarketKey, HybridLadder>>>;

export type HybridWidth = "balanced" | "wider";

export type HybridSettings = {
  // American odds; either order. Absent or unusable: -140 / -110.
  targetMin?: number;
  targetMax?: number;
  width?: HybridWidth;
  // Optional per-leg price range in American odds, either order.
  legRange?: { min: number; max: number } | null;
  // Default and hard cap HYBRID_MAX_LEGS; at least 2.
  maxLegs?: number;
};

export type HybridInput = {
  positions: ConsensusPosition[];
  ladders: HybridLadders;
  // Keyed by team name as the positions spell it (getRecentSwings' `teams`).
  swings: Record<string, SwingGame[]>;
  settings?: HybridSettings;
};

// ---- Output ----

export type EdgeSource = "stored" | "raw" | "none";

export type HybridLeg = {
  positionKey: string;
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
  sport: string;
  family: HybridFamily;
  // The team name, or "OVER" / "UNDER".
  direction: string;
  marketKey: HybridMarketKey;
  // The outcome as FanDuel names it (a team, "Over" or "Under"): what the exact-line
  // handoff (hybrid-link.ts) matches on.
  outcomeName: string;
  // The leg's point on its own scale (a team's spread; a total). null on h2h.
  point: number | null;
  price: number;
  sid: string | null;
  link: string | null;
  label: string;
  // Tonight's main line on the leg's scale (a team side: that team's spread, 0
  // for pick'em). null when the ladder has no priced pair.
  tonightLine: number | null;
  // Where recent swings put the edge (after any key-number move), on the leg's scale.
  edge: number;
  edgeSource: EdgeSource;
  keyNumberPush: { from: number; to: number } | null;
  // The rung the edge snapped to (null point = the moneyline).
  snappedPoint: number | null;
  // False when the ladder (or the price floor / range) ran out before the edge.
  edgeReached: boolean;
  // Fine-tuning, relative to the snapped rung: negative rungs = tightened.
  move: { rungs: number; why: string };
  reason: string;
  isStale: boolean;
  marketLastUpdate: string | null;
  consensus: {
    supporters: number;
    opposers: number;
    score: number;
    anchorLine: number;
    anchorIsMoneyline: boolean;
    topSupporters: { capperName: string; record: "LEAGUE" | "OVERALL"; wins: number; losses: number; n: number; winPct: number }[];
  };
};

export type HybridStructure = "same-game-box" | "cross-game";

export type Hybrid = {
  structure: HybridStructure;
  legs: HybridLeg[];
  combinedAmerican: number;
  combinedDecimal: number;
  impliedProbability: number;
  isEstimate: boolean;
  inTarget: boolean;
  boxDescription: string;
  // The oldest marketLastUpdate across the legs (ISO), null when none had one.
  oddsAsOf: string | null;
  anyStale: boolean;
  // The legs' consensus scores summed.
  consensusScore: number;
  // Rungs moved from the edges, summed.
  rungsMoved: number;
};

export type HybridResult = {
  primary: Hybrid | null;
  alternates: Hybrid[];
  // Why there is no primary, when there is none.
  note: string | null;
};

// ---- Odds math (combine-odds.ts underneath) ----

// The implied probability of an American price; null when it is not a price.
export function impliedProbability(american: number): number | null {
  const d = americanToDecimal(american);
  return d === null ? null : 1 / d;
}

export type TargetBand = { low: number; high: number; mid: number };

// The target range as an implied-probability band. -140 / -110 -> 0.5238 - 0.5833.
export function targetBand(settings?: HybridSettings): TargetBand {
  let a = impliedProbability(settings?.targetMin ?? NaN);
  let b = impliedProbability(settings?.targetMax ?? NaN);
  if (a === null || b === null) {
    a = impliedProbability(HYBRID_DEFAULT_TARGET_MIN)!;
    b = impliedProbability(HYBRID_DEFAULT_TARGET_MAX)!;
  }
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  return { low, high, mid: (low + high) / 2 };
}

// 0 inside the band, else the implied-probability gap to its nearer end.
export function distanceToBand(p: number, band: TargetBand): number {
  if (p > band.high + EPS) return p - band.high;
  if (p < band.low - EPS) return band.low - p;
  return 0;
}

function legPriceAllowed(price: number, range: { low: number; high: number } | null): boolean {
  if (!hasUsablePrice(price)) return false;
  if (price < 0 && price < HYBRID_MIN_LEG_PRICE) return false;
  if (!range) return true;
  const p = impliedProbability(price)!;
  return p >= range.low - EPS && p <= range.high + EPS;
}

function legRangeBand(settings?: HybridSettings): { low: number; high: number } | null {
  const r = settings?.legRange;
  if (!r) return null;
  const a = impliedProbability(r.min);
  const b = impliedProbability(r.max);
  if (a === null || b === null) return null;
  return { low: Math.min(a, b), high: Math.max(a, b) };
}

// ---- Ladders ----

// One rung of a leg's ladder. `order` grows with forgiveness: a team's spread
// (the moneyline at 0), an Under's line, an Over's line negated.
export type Rung = {
  marketKey: HybridMarketKey;
  outcomeName: string;
  point: number | null;
  order: number;
  price: number;
  sid: string | null;
  link: string | null;
  isStale: boolean;
  marketLastUpdate: string | null;
};

const sameTeam = (a: string, b: string) => a === b || normalizeTeamName(a) === normalizeTeamName(b);

function isoOrNull(d: Date | string | null): string | null {
  if (d === null) return null;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

function toRung(o: HybridLadderOutcome, marketKey: HybridMarketKey, ladder: HybridLadder, order: number): Rung {
  return {
    marketKey,
    outcomeName: o.name,
    point: marketKey === "h2h" ? null : o.point!,
    order,
    price: o.price,
    sid: o.sid ?? null,
    link: o.link ?? null,
    isStale: ladder.isStale,
    marketLastUpdate: isoOrNull(ladder.marketLastUpdate),
  };
}

// Forgiveness order of a line on the position's own scale.
function orderOf(p: Pick<ConsensusPosition, "family" | "direction">, line: number): number {
  return p.family === "TOTAL" && p.direction === "OVER" ? -line : line;
}
function lineOf(p: Pick<ConsensusPosition, "family" | "direction">, order: number): number {
  return p.family === "TOTAL" && p.direction === "OVER" ? -order : order;
}

// Every rung the position may use, least forgiving first: on its side of the
// anchor, priced at or above the floor and inside the per-leg range. A team
// side takes the moneyline (as 0) only when its anchor is 0 or harder, and never
// an alternate spread at 0. `anyPrice` skips the floor and range (to tell why a
// leg stopped short of its edge).
export function legRungs(p: ConsensusPosition, ladders: HybridLadders, settings?: HybridSettings, opts: { anyPrice?: boolean } = {}): Rung[] {
  const range = legRangeBand(settings);
  const event = ladders[p.eventId] ?? {};
  const anchorOrder = orderOf(p, p.anchorLine);
  const out: Rung[] = [];
  const seen = new Set<number>();
  const add = (r: Rung) => {
    if (r.order < anchorOrder - EPS || seen.has(r.order)) return;
    if (opts.anyPrice ? !hasUsablePrice(r.price) : !legPriceAllowed(r.price, range)) return;
    seen.add(r.order);
    out.push(r);
  };
  if (p.family === "SIDE") {
    const alt = event.alternate_spreads;
    for (const o of alt?.outcomes ?? []) {
      if (typeof o.point !== "number" || o.point === 0 || !sameTeam(o.name, p.direction)) continue;
      add(toRung(o, "alternate_spreads", alt!, o.point));
    }
    const h2h = event.h2h;
    const ml = h2h?.outcomes.find((o) => sameTeam(o.name, p.direction));
    if (ml && p.anchorLine <= 0) add(toRung(ml, "h2h", h2h!, 0));
  } else {
    const alt = event.alternate_totals;
    const name = p.direction === "OVER" ? "over" : "under";
    for (const o of alt?.outcomes ?? []) {
      if (typeof o.point !== "number" || o.name.toLowerCase() !== name) continue;
      add(toRung(o, "alternate_totals", alt!, orderOf(p, o.point)));
    }
  }
  return out.sort((a, b) => a.order - b.order);
}

// Tonight's main line on the position's scale: the pair whose two prices are
// closest in implied probability. A team side's pairs are T at p with the
// opponent at -p, plus both moneylines as pick'em. A tie goes to the higher
// point (from the home side for spreads), then the lower vig.
export function tonightLine(p: ConsensusPosition, ladders: HybridLadders): number | null {
  return tonightPair(p, ladders)?.line ?? null;
}

// tonightLine, plus the leg team's moneyline price when the main line is the
// moneyline pair (the reason shows it: "pick'em" alone hides a -132 favorite).
function tonightPair(p: ConsensusPosition, ladders: HybridLadders): { line: number; moneyline: number | null } | null {
  const event = ladders[p.eventId] ?? {};
  type Pair = { point: number; gap: number; vig: number; home: number; away: number; ml: boolean };
  const pairs: Pair[] = [];
  const push = (point: number, a: number, b: number, ml = false) => {
    const pa = impliedProbability(a);
    const pb = impliedProbability(b);
    if (pa !== null && pb !== null) pairs.push({ point, gap: Math.abs(pa - pb), vig: pa + pb, home: a, away: b, ml });
  };
  if (p.family === "SIDE") {
    const outs = event.alternate_spreads?.outcomes ?? [];
    for (const h of outs) {
      if (typeof h.point !== "number" || !sameTeam(h.name, p.homeTeam)) continue;
      const a = outs.find((o) => sameTeam(o.name, p.awayTeam) && o.point === -h.point!);
      if (a) push(h.point, h.price, a.price);
    }
    const ml = event.h2h?.outcomes ?? [];
    const hm = ml.find((o) => sameTeam(o.name, p.homeTeam));
    const am = ml.find((o) => sameTeam(o.name, p.awayTeam));
    if (hm && am) push(0, hm.price, am.price, true);
  } else {
    const outs = event.alternate_totals?.outcomes ?? [];
    for (const o of outs) {
      if (typeof o.point !== "number" || o.name.toLowerCase() !== "over") continue;
      const u = outs.find((x) => x.name.toLowerCase() === "under" && x.point === o.point);
      if (u) push(o.point, o.price, u.price);
    }
  }
  if (pairs.length === 0) return null;
  pairs.sort((a, b) => (Math.abs(a.gap - b.gap) > EPS ? a.gap - b.gap : a.point !== b.point ? b.point - a.point : a.vig - b.vig));
  const best = pairs[0];
  if (p.family === "TOTAL") return { line: best.point, moneyline: null };
  // A spread line is the negation for the other team; 0 stays 0.
  const isHome = sameTeam(p.direction, p.homeTeam);
  const line = isHome || best.point === 0 ? best.point : -best.point;
  return { line, moneyline: best.ml ? (isHome ? best.home : best.away) : null };
}

// ---- Edges ----

export type EdgePlacement = {
  // Tonight's line, or the anchor when the ladder has no priced pair.
  base: number;
  edge: number;
  edgeSource: EdgeSource;
  // The worst miss used from the stored lines, and the raw-score value used.
  storedMiss: number | null;
  rawValue: number | null;
  // The miss (or raw value) `balanced` set aside, per kind.
  setAside: { stored: number | null; raw: number | null };
  rawTeams: string[];
  keyNumberPush: { from: number; to: number } | null;
};

function gamesFor(swings: Record<string, SwingGame[]>, team: string): SwingGame[] {
  const exact = swings[team];
  if (exact) return exact.slice(0, HYBRID_SWING_GAMES);
  const key = Object.keys(swings).find((k) => sameTeam(k, team));
  return key ? swings[key].slice(0, HYBRID_SWING_GAMES) : [];
}

export function isFootball(sport: string): boolean {
  const s = sport.toUpperCase();
  return s === "NFL" || s === "NCAAF" || s.startsWith("AMERICANFOOTBALL_");
}

// A football spread at or within 0.5 of a key number moves to that number's
// forgiving side: +2.5..+3.5 -> +3.5, -3.5..-2.5 -> -2.5.
export function pushKeyNumber(edge: number): number {
  for (const k of FOOTBALL_KEY_NUMBERS) {
    if (edge >= 0 && Math.abs(edge - k) <= 0.5 + EPS) return k + 0.5;
    if (edge < 0 && Math.abs(-edge - k) <= 0.5 + EPS) return -k + 0.5;
  }
  return edge;
}

// The biggest of `values` after `balanced` sets the single biggest aside (two
// or more values only). An empty list is 0.
function worstOf(values: number[], width: HybridWidth): { worst: number; setAside: number | null } {
  const sorted = [...values].sort((a, b) => b - a);
  if (width === "balanced" && sorted.length >= 2) return { worst: sorted[1], setAside: sorted[0] };
  return { worst: sorted[0] ?? 0, setAside: null };
}

// Where recent swings put the position's edge, on its own scale. `tonight` is
// the main line (null: the anchor stands in).
export function placeEdge(p: ConsensusPosition, tonight: number | null, swings: Record<string, SwingGame[]>, width: HybridWidth = "balanced"): EdgePlacement {
  const base = tonight ?? p.anchorLine;
  const side = p.family === "SIDE";
  const team = side ? p.direction : p.homeTeam;
  const other = side ? (sameTeam(p.direction, p.homeTeam) ? p.awayTeam : p.homeTeam) : p.awayTeam;
  const mine = gamesFor(swings, team);
  const minePlayed = new Set(mine.filter((g) => teamNamesMatch(g.opponent, other)).map((g) => g.date));
  // A meeting of the two teams is already in `mine`.
  const theirs = gamesFor(swings, other).filter((g) => !(minePlayed.has(g.date) && teamNamesMatch(g.opponent, team)));

  // From the leg's side: a team side reads T's numbers and the opponent's
  // negated; a total reads both teams' as they are.
  const stored: number[] = [];
  const raw: number[] = [];
  const rawTeams: string[] = [];
  const read = (games: SwingGame[], name: string, sign: number) => {
    const withLine = games.filter((g) => (side ? g.coverMargin : g.totalMiss) !== null);
    if (withLine.length >= HYBRID_MIN_STORED_GAMES) {
      for (const g of withLine) stored.push(sign * (side ? g.coverMargin! : g.totalMiss!));
    } else if (games.length > 0) {
      rawTeams.push(name);
      for (const g of games) raw.push(side ? sign * g.margin : g.actualTotal);
    }
  };
  read(mine, team, 1);
  read(theirs, other, side ? -1 : 1);

  const over = p.family === "TOTAL" && p.direction === "OVER";
  const edges: { order: number; source: "stored" | "raw" }[] = [];
  let storedMiss: number | null = null;
  let rawValue: number | null = null;
  const setAside: EdgePlacement["setAside"] = { stored: null, raw: null };

  if (stored.length > 0) {
    // Misses in the direction that hurts this leg, as sizes (0 = no miss).
    const misses = stored.map((v) => Math.max(0, side || over ? -v : v));
    const w = worstOf(misses, width);
    storedMiss = w.worst;
    setAside.stored = w.setAside;
    edges.push({ order: orderOf(p, over ? base - w.worst : base + w.worst), source: "stored" });
  }
  if (raw.length > 0) {
    // Ordered so the worst is the largest: losses as sizes, the lowest total for
    // an Over (negated), the highest for an Under.
    const keyed = side ? raw.map((v) => Math.max(0, -v)) : over ? raw.map((v) => -v) : raw;
    const w = worstOf(keyed, width);
    rawValue = over ? -w.worst : w.worst;
    setAside.raw = w.setAside === null ? null : over ? -w.setAside : w.setAside;
    edges.push({ order: orderOf(p, rawValue), source: "raw" });
  }

  let edge = base;
  let edgeSource: EdgeSource = "none";
  if (edges.length > 0) {
    edge = lineOf(p, Math.max(...edges.map((e) => e.order)));
    edgeSource = rawTeams.length > 0 ? "raw" : "stored";
  }
  let keyNumberPush: EdgePlacement["keyNumberPush"] = null;
  if (side && isFootball(p.sport)) {
    const pushed = pushKeyNumber(edge);
    if (pushed !== edge) keyNumberPush = { from: edge, to: pushed };
    edge = pushed;
  }
  return { base, edge, edgeSource, storedMiss, rawValue, setAside, rawTeams, keyNumberPush };
}

// The rung the edge snaps to: the least forgiving at or past the edge (the
// rungs already respect the anchor). Past the ladder's end: the last rung.
export function snapIndex(rungs: Rung[], edgeOrder: number): { index: number; reached: boolean } {
  const i = rungs.findIndex((r) => r.order >= edgeOrder - EPS);
  return i >= 0 ? { index: i, reached: true } : { index: rungs.length - 1, reached: false };
}

// ---- Placed legs and fine-tuning ----

type Placed = {
  position: ConsensusPosition;
  rungs: Rung[];
  tonight: number | null;
  // The team's moneyline when tonight's line is the moneyline pair.
  tonightMoneyline: number | null;
  placement: EdgePlacement;
  edgeIndex: number;
  edgeReached: boolean;
  // What stopped the leg short of its edge: the ladder's end, or the price
  // floor / per-leg range.
  edgeStop: "ladder" | "price" | null;
};

function place(p: ConsensusPosition, input: HybridInput, settings: HybridSettings): Placed | null {
  const rungs = legRungs(p, input.ladders, settings);
  if (rungs.length === 0) return null;
  const pair = tonightPair(p, input.ladders);
  const tonight = pair?.line ?? null;
  const placement = placeEdge(p, tonight, input.swings, settings.width ?? "balanced");
  const edgeOrder = orderOf(p, placement.edge);
  const snap = snapIndex(rungs, edgeOrder);
  let edgeStop: Placed["edgeStop"] = null;
  if (!snap.reached) edgeStop = snapIndex(legRungs(p, input.ladders, settings, { anyPrice: true }), edgeOrder).reached ? "price" : "ladder";
  return { position: p, rungs, tonight, tonightMoneyline: pair?.moneyline ?? null, placement, edgeIndex: snap.index, edgeReached: snap.reached, edgeStop };
}

const decimalOf = (r: Rung) => americanToDecimal(r.price)!;

type Tuned = { indexes: number[]; implied: number; distance: number; rungsMoved: number; direction: "kept" | "tighten" | "push" };

// The best rungs for `legs`. Legs from `tunable` on may move (in the one
// direction the edge-placed price calls for); the ones before it stay on their
// edges.
function tune(legs: Placed[], tunableFrom: number, band: TargetBand): Tuned {
  const edges = legs.map((l) => l.edgeIndex);
  const impliedAt = (idx: number[]) => 1 / idx.reduce((d, i, k) => d * decimalOf(legs[k].rungs[i]), 1);
  const start = impliedAt(edges);
  if (distanceToBand(start, band) === 0) return { indexes: edges, implied: start, distance: 0, rungsMoved: 0, direction: "kept" };

  // More likely than the band: tighten. Less likely: push out.
  const direction: Tuned["direction"] = start > band.high ? "tighten" : "push";
  const choices = legs.map((l, k) => {
    if (k < tunableFrom) return [l.edgeIndex];
    const out: number[] = [];
    if (direction === "tighten") for (let i = l.edgeIndex; i >= 0; i--) out.push(i);
    else for (let i = l.edgeIndex; i < l.rungs.length; i++) out.push(i);
    return out;
  });

  const found: { best: (Tuned & { balance: number; mid: number }) | null } = { best: null };
  const visit = (k: number, idx: number[]) => {
    if (k === legs.length) {
      const implied = impliedAt(idx);
      const devs = idx.map((i, j) => Math.abs(i - edges[j]));
      const cand = {
        indexes: [...idx],
        implied,
        distance: distanceToBand(implied, band),
        rungsMoved: devs.reduce((s, d) => s + d, 0),
        direction,
        balance: Math.max(...devs) - Math.min(...devs),
        mid: Math.abs(implied - band.mid),
      };
      if (!found.best || better(cand, found.best)) found.best = cand;
      return;
    }
    for (const i of choices[k]) visit(k + 1, [...idx, i]);
  };
  visit(0, []);
  const b = found.best!;
  return { indexes: b.indexes, implied: b.implied, distance: b.distance, rungsMoved: b.rungsMoved, direction: b.direction };
}

type Ranked = { distance: number; rungsMoved: number; balance: number; mid: number };
// In band beats out of band; then the closer to the band; then fewest rungs,
// the more even split, the closer to the middle.
function better(a: Ranked, b: Ranked): boolean {
  if (Math.abs(a.distance - b.distance) > EPS) return a.distance < b.distance;
  if (a.rungsMoved !== b.rungsMoved) return a.rungsMoved < b.rungsMoved;
  if (a.balance !== b.balance) return a.balance < b.balance;
  return a.mid < b.mid - EPS;
}

// ---- Words ----

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}
function fmtSigned(n: number): string {
  return n > 0 ? "+" + fmt(n) : fmt(n);
}
function fmtSpread(n: number): string {
  return n === 0 ? "pick'em" : fmtSigned(n);
}

function totalNoun(sport: string): string {
  const s = sport.toUpperCase();
  if (s === "NHL" || s.startsWith("ICEHOCKEY_")) return "goals";
  if (s === "MLB" || s.startsWith("BASEBALL_")) return "runs";
  return "points";
}

function legLabel(p: ConsensusPosition, r: Rung): string {
  if (p.family === "TOTAL") return (p.direction === "OVER" ? "Over " : "Under ") + fmt(r.point!);
  return r.marketKey === "h2h" ? p.direction + " ML" : p.direction + " " + fmtSigned(r.point!);
}

// "Denver Broncos lose by 14 or fewer", "43+ total points".
function legClause(p: ConsensusPosition, r: Rung, withGame: boolean): string {
  if (p.family === "TOTAL") {
    const x = r.point!;
    const text = p.direction === "OVER" ? `${Math.floor(x) + 1}+ total ${totalNoun(p.sport)}` : `${Math.ceil(x) - 1} or fewer total ${totalNoun(p.sport)}`;
    return withGame ? `${text} in ${p.awayTeam} @ ${p.homeTeam}` : text;
  }
  if (r.marketKey === "h2h") return `${p.direction} win`;
  const x = r.point!;
  if (x > 0) {
    const lose = Math.ceil(x) - 1;
    return lose >= 1 ? `${p.direction} lose by ${lose} or fewer` : `${p.direction} win or tie`;
  }
  return `${p.direction} win by ${Math.floor(-x) + 1} or more`;
}

function describe(legs: { p: ConsensusPosition; r: Rung }[], boxEvent: string | null): string {
  const clauses = legs.map(({ p, r }) => legClause(p, r, p.eventId !== boxEvent));
  const joined = clauses.length <= 2 ? clauses.join(" and ") : clauses.slice(0, -1).join(", ") + " and " + clauses[clauses.length - 1];
  return "Wins if " + joined;
}

function edgeReason(l: Placed, final: Rung, move: { rungs: number; why: string }): string {
  const p = l.position;
  const e = l.placement;
  const parts = [legLabel(p, final)];
  const side = p.family === "SIDE";
  if (l.tonightMoneyline !== null) parts.push(`tonight pick'em (ML ${fmtSigned(l.tonightMoneyline)})`);
  else if (l.tonight !== null) parts.push("tonight " + (side ? fmtSpread(l.tonight) : fmt(l.tonight)));
  else parts.push("no main line on the ladder, measured from the anchor " + (side ? fmtSpread(p.anchorLine) : fmt(p.anchorLine)));
  if (e.storedMiss !== null) {
    const w = fmt(e.storedMiss);
    if (side) parts.push(e.storedMiss > 0 ? `their games miss the spread by up to ${w}` : "their games have not missed the spread");
    else if (p.direction === "OVER") parts.push(e.storedMiss > 0 ? `their games fall short of the total by up to ${w}` : "their games have not gone under the total");
    else parts.push(e.storedMiss > 0 ? `their games go over the total by up to ${w}` : "their games have not gone over the total");
    if (e.setAside.stored !== null && e.setAside.stored > e.storedMiss) parts.push(`biggest miss (${fmt(e.setAside.stored)}) set aside`);
  }
  if (e.rawValue !== null) {
    if (side) parts.push(e.rawValue > 0 ? `lost by up to ${fmt(e.rawValue)} recently` : "no recent losses");
    else parts.push((p.direction === "OVER" ? "lowest recent total " : "highest recent total ") + fmt(e.rawValue));
    parts.push(`raw scores (lines missing${e.rawTeams.length === 1 ? " for " + e.rawTeams[0] : ""})`);
  }
  if (e.edgeSource === "none") parts.push("no recent games");
  if (e.keyNumberPush) parts.push(`key number: ${fmtSigned(e.keyNumberPush.from)} -> ${fmtSigned(e.keyNumberPush.to)}`);
  if (l.edgeStop === "ladder") parts.push("ladder stops short of the edge");
  if (l.edgeStop === "price") parts.push(`price limits (${HYBRID_MIN_LEG_PRICE} floor / leg range) stop it short of the edge`);
  if (move.rungs !== 0) parts.push(move.why);
  return parts.join(" · ");
}

function moveWhy(l: Placed, index: number, tuned: Tuned): { rungs: number; why: string } {
  const rungs = index - l.edgeIndex;
  if (rungs === 0) return { rungs, why: "at its edge" };
  if (rungs < 0) {
    const atAnchor = index === 0;
    return {
      rungs,
      why: `tightened ${-rungs} rung${rungs === -1 ? "" : "s"} toward the anchor` + (tuned.distance > 0 && atAnchor ? " (at the anchor, can't go further)" : " to reach the target"),
    };
  }
  const atEnd = index === l.rungs.length - 1;
  return {
    rungs,
    why: `pushed out ${rungs} rung${rungs === 1 ? "" : "s"}` + (tuned.distance > 0 && atEnd ? " (furthest rung within the price limits)" : " to reach the target"),
  };
}

function topSupporters(cappers: PositionCapper[]) {
  return cappers.slice(0, TOP_SUPPORTERS).map((c) => ({
    capperName: c.capperName,
    record: c.record.source,
    wins: c.record.wins,
    losses: c.record.losses,
    n: c.record.n,
    winPct: c.record.winPct,
  }));
}

function buildHybrid(structure: HybridStructure, legs: Placed[], tuned: Tuned): Hybrid {
  const chosen = legs.map((l, k) => ({ l, r: l.rungs[tuned.indexes[k]], i: tuned.indexes[k] }));
  const combined = combineOdds(chosen.map(({ r }) => ({ odds: r.price })));
  if (combined.status !== "AVAILABLE") throw new Error("hybrid: a candidate rung had no usable price");
  const events = chosen.map(({ l }) => l.position.eventId);
  const sameGame = new Set(events).size < events.length;
  const boxEvent = structure === "same-game-box" ? events[0] : null;
  const updates = chosen.map(({ r }) => r.marketLastUpdate).filter((u): u is string => u !== null).sort();

  const out: HybridLeg[] = chosen.map(({ l, r, i }) => {
    const p = l.position;
    const move = moveWhy(l, i, tuned);
    return {
      positionKey: p.key,
      eventId: p.eventId,
      homeTeam: p.homeTeam,
      awayTeam: p.awayTeam,
      commenceTime: p.commenceTime,
      sport: p.sport,
      family: p.family,
      direction: p.direction,
      marketKey: r.marketKey,
      outcomeName: r.outcomeName,
      point: r.point,
      price: r.price,
      sid: r.sid,
      link: r.link,
      label: legLabel(p, r),
      tonightLine: l.tonight,
      edge: l.placement.edge,
      edgeSource: l.placement.edgeSource,
      keyNumberPush: l.placement.keyNumberPush,
      snappedPoint: l.rungs[l.edgeIndex].point,
      edgeReached: l.edgeReached,
      move,
      reason: edgeReason(l, r, move),
      isStale: r.isStale,
      marketLastUpdate: r.marketLastUpdate,
      consensus: {
        supporters: p.supporters.length,
        opposers: p.opposers.length,
        score: p.score,
        anchorLine: p.anchorLine,
        anchorIsMoneyline: p.anchorIsMoneyline,
        topSupporters: topSupporters(p.supporters),
      },
    };
  });

  return {
    structure,
    legs: out,
    combinedAmerican: combined.american,
    combinedDecimal: combined.decimal,
    impliedProbability: 1 / combined.decimal,
    isEstimate: sameGame,
    inTarget: tuned.distance === 0,
    boxDescription: describe(chosen.map(({ l, r }) => ({ p: l.position, r })), boxEvent),
    oddsAsOf: updates[0] ?? null,
    anyStale: chosen.some(({ r }) => r.isStale),
    consensusScore: chosen.reduce((s, { l }) => s + l.position.score, 0),
    rungsMoved: tuned.rungsMoved,
  };
}

// ---- Assembly ----

type Candidate = { structure: HybridStructure; core: Placed[]; extras: Placed[]; tuned: Tuned; coreScore: number };

// Up to two more single edge-placed legs from games not yet in the hybrid, best
// position first; each is kept only when it gets strictly closer to the band.
// The core legs re-tune around the added legs.
function expand(c: Candidate, ranked: ConsensusPosition[], placedOf: (p: ConsensusPosition) => Placed | null, band: TargetBand, maxLegs: number): Candidate {
  let current = c;
  const used = new Set(c.core.map((l) => l.position.eventId));
  while (current.tuned.distance > 0 && current.core.length + current.extras.length < maxLegs) {
    let next: Placed | null = null;
    for (const p of ranked) {
      if (used.has(p.eventId)) continue;
      next = placedOf(p);
      if (next) break;
    }
    if (!next) break;
    const extras = [...current.extras, next];
    // Fixed (extra) legs first, the core after them.
    const order = [...extras, ...current.core];
    const t = tune(order, extras.length, band);
    if (t.distance >= current.tuned.distance - EPS) break;
    used.add(next.position.eventId);
    const coreIdx = t.indexes.slice(extras.length);
    current = {
      ...current,
      extras,
      tuned: { ...t, indexes: [...coreIdx, ...t.indexes.slice(0, extras.length)] },
    };
  }
  return current;
}

function toHybrid(c: Candidate): Hybrid {
  return buildHybrid(c.structure, [...c.core, ...c.extras], c.tuned);
}

// In band first; fewer legs; then the stronger consensus, fewest rungs moved,
// the more even split. Out of band: closest first, then consensus.
function rankCandidates(a: Candidate, b: Candidate): number {
  const ai = a.tuned.distance === 0;
  const bi = b.tuned.distance === 0;
  if (ai !== bi) return ai ? -1 : 1;
  const al = a.core.length + a.extras.length;
  const bl = b.core.length + b.extras.length;
  if (al !== bl) return al - bl;
  if (!ai && Math.abs(a.tuned.distance - b.tuned.distance) > EPS) return a.tuned.distance - b.tuned.distance;
  if (Math.abs(a.coreScore - b.coreScore) > EPS) return b.coreScore - a.coreScore;
  if (a.tuned.rungsMoved !== b.tuned.rungsMoved) return a.tuned.rungsMoved - b.tuned.rungsMoved;
  const key = (c: Candidate) => c.core[0].position.eventId;
  return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
}

export function normalizeSettings(s?: HybridSettings): Required<Pick<HybridSettings, "width" | "maxLegs">> & HybridSettings {
  const maxLegs = Math.min(HYBRID_MAX_LEGS, Math.max(2, Math.floor(s?.maxLegs ?? HYBRID_MAX_LEGS) || HYBRID_MAX_LEGS));
  return { ...s, width: s?.width === "wider" ? "wider" : "balanced", maxLegs };
}

export type BoxGame = { eventId: string; side: ConsensusPosition; total: ConsensusPosition; score: number };

// Box-eligible games, best first: the best team side and the best total on one
// game, scored as their sum. Exported so the action fetches ladders for exactly
// the games the optimizer will walk.
export function boxEligibleGames(ranked: ConsensusPosition[]): BoxGame[] {
  const games = new Map<string, { side?: ConsensusPosition; total?: ConsensusPosition }>();
  for (const p of ranked) {
    const g = games.get(p.eventId) ?? {};
    if (p.family === "SIDE" && !g.side) g.side = p;
    if (p.family === "TOTAL" && !g.total) g.total = p;
    games.set(p.eventId, g);
  }
  return Array.from(games.entries())
    .filter(([, g]) => g.side && g.total)
    .map(([eventId, g]) => ({ eventId, side: g.side!, total: g.total!, score: g.side!.score + g.total!.score }))
    .sort((a, b) => (Math.abs(a.score - b.score) > EPS ? b.score - a.score : a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
}

export function optimizeHybrid(input: HybridInput): HybridResult {
  const settings = normalizeSettings(input.settings);
  const band = targetBand(settings);
  const ranked = input.positions;

  const placedCache = new Map<string, Placed | null>();
  const placedOf = (p: ConsensusPosition): Placed | null => {
    if (!placedCache.has(p.key)) placedCache.set(p.key, place(p, input, settings));
    return placedCache.get(p.key)!;
  };

  const boxes: Candidate[] = [];
  for (const g of boxEligibleGames(ranked)) {
    if (boxes.length >= HYBRID_CANDIDATE_GAMES) break;
    const side = placedOf(g.side);
    const total = placedOf(g.total);
    if (!side || !total) continue;
    const core = [side, total];
    boxes.push({ structure: "same-game-box", core, extras: [], tuned: tune(core, 0, band), coreScore: g.score });
  }

  if (boxes.length > 0) {
    const anyIn = boxes.some((b) => b.tuned.distance === 0);
    const final = anyIn || settings.maxLegs <= 2 ? boxes : boxes.map((b) => expand(b, ranked, placedOf, band, settings.maxLegs));
    const sorted = [...final].sort(rankCandidates).map(toHybrid);
    return { primary: sorted[0], alternates: sorted.slice(1, 1 + HYBRID_ALTERNATES), note: null };
  }

  // No box: the top two placeable positions on different games.
  let first: Placed | null = null;
  let second: Placed | null = null;
  for (const p of ranked) {
    const l = placedOf(p);
    if (!l) continue;
    if (!first) first = l;
    else if (l.position.eventId !== first.position.eventId) {
      second = l;
      break;
    }
  }
  if (!first || !second) {
    return { primary: null, alternates: [], note: first ? "Only one game has a placeable consensus position." : "No consensus position has a usable FanDuel ladder." };
  }
  const core = [first, second];
  let cross: Candidate = { structure: "cross-game", core, extras: [], tuned: tune(core, 0, band), coreScore: first.position.score + second.position.score };
  if (cross.tuned.distance > 0 && settings.maxLegs > 2) cross = expand(cross, ranked, placedOf, band, settings.maxLegs);
  return { primary: toHybrid(cross), alternates: [], note: null };
}
