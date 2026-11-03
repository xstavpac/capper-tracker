// The Parlay Generator's one scoring module: a pick goes in, a score and its
// breakdown come out. Standard, Your picks only, Hedge and slip ranking read it
// (generator.ts); Contrarian and Consensus Hybrid switch to it in later PRs, and
// until then best-of-two and Wilson (pick-record.ts, qualification-core.ts) still
// decide those. Pure and client-safe: the engine runs in the browser, so
// everything here reads what the snapshot already holds and nothing reads the
// database.
//
// Win probability: a three-level Beta-binomial shrinkage, prior strength
// PRIOR_STRENGTH picks at each level:
//   platform rate for the league + category (platformRateFor)
//     -> the capper's record in the category in their OTHER leagues
//       -> the capper's record in the category in this league
// The middle level is overall minus league, never overall. Overall already holds
// the in-league picks, so shrinking toward it counts them twice (1-0 would score
// 56.5, not ~54; 18-4 75.1, not ~68).
//
// A player prop with a market key (prop-market-key.ts) reads its per-market
// record, never its category's, exactly as recordForGate does; its "overall" is
// the market's sport family. No recency weighting. Pushes never count.
//
// Two models, and the breakdown names which scored the pick:
//
// Edge model: a pick with a real price, from a capper with at least
// MIN_PRICED_PICKS real-priced picks in the category. Each priced pick's edge is
// won minus its implied probability (pushes out). shrunkEdge shrinks the in-league
// edge toward the other-leagues edge, which shrinks toward zero: the platform prior
// for a priced record is no edge, not a category win rate. An edge earned at one
// price doesn't carry over as raw points (18-4 at -110 would be +15 at -2000 too, a
// 110% pick), so it moves to the pick's price on the log-odds scale:
//   histP = historical break-even + shrunkEdge, clamped
//   skill = logit(histP) - logit(historical break-even)
//   p     = sigmoid(logit(the pick's break-even) + skill)
//   edge  = p - the pick's break-even
//
// Win-rate model: everything else. It uses the win-probability hierarchy above.
//   - No real price on the pick: shrunk probability minus the platform's average
//     break-even for the league + category, labelled "no price data". That average
//     is a yardstick and not its price: it only puts the pick on the same scale.
//   - A real price but a thin priced history: the worse of the capper's edge (shrunk
//     minus the pick's break-even) and the platform's (shrunk minus the average).
//     Alone the first passes a long shot on the category prior (0-1 at +200) and the
//     second ignores the price (2-0 at -500).
//
// Gate: the user's win-% lever L keeps its label but means "the edge a capper at
// L% has at -110": a pick passes when its edge reaches L minus the -110 break-even.
// With the default break-even the win-rate model at -110 is exactly the plain
// "shrunk probability >= L". L = 0 is no gate; a pick with no record never passes.
// Ranking reads the same edge (rankScore).
//
// Long-shot rule (ls1): with L > 0 a pick with a real price also needs its capper's
// RAW record in the scored category (in-league plus other leagues, pushes out) to
// reach a bar: wins / decided >= min(break-even of the pick's own price, L / 100). A
// category prior (DOG_ML's ~38%) is above a long dog's break-even, so without this a
// 0-3 capper at +300 passed on the prior alone. Evidence must clear the price, not the
// prior. The bar never asks more than the lever does, so lowering L still widens the
// pool below break-even (10-10 at -110 passes at 45) and the -110 gate has no cliff
// between 0 and 1. 1-0 and 8-0 pass at any price; 0-for-N never does at any L > 0. A pick
// with no real price has no price of its own, so the rule doesn't apply to it. At L = 0
// nothing changes.
//
// A capper's historical break-even is shown in the breakdown and drives the
// price transfer; it is never compared against to make a score.
import type { ExpanderPick } from "@/components/live/game-picks-expander";
import { hasUsablePrice } from "@/lib/parlay/combine-odds";
import { GATE_DEFAULT } from "@/lib/parlay/gate";
import { propMarketKey, type PropMarketKey } from "@/lib/prop-market-key";
import { categoryRecordKey, leagueRecordKey, propMarketRecordKey } from "@/lib/record-keys";
import type { CapperLeagueRecords, PropMarketRecord } from "@/server/data/picks";
import type { CategoryBreakdownItem, PricedColumn } from "@/server/data/stats";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
// Picks of prior weight at each level of the hierarchy.
export const PRIOR_STRENGTH = 20;
// A platform rate on fewer decided picks than this falls back a tier (many
// period and prop categories are tiny: NBA FIRST_QUARTER_ML is 0-1).
export const PLATFORM_MIN_DECIDED = 30;
// When no tier has enough picks, even across leagues.
export const DEFAULT_PLATFORM_RATE = 0.52;
// A no-price pick's yardstick when no tier has enough priced picks: -110.
export const DEFAULT_BREAK_EVEN = 110 / 210;
export const NO_PRICE_LABEL = "no price data";
// Real-priced picks a capper needs in the category for the edge model (pushes out, every league).
export const MIN_PRICED_PICKS = 5;
// histP's range, so a logit stays finite.
export const MIN_PROB = 0.01;
export const MAX_PROB = 0.99;
// Names these rules in the run log. Any change to a constant above changes it.
export const SCORING_VERSION = "hier-k20-logit-edge-min5-ls1-v2";

const PLACEHOLDER_ODDS = -110;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------
export type ScoringPick = Pick<ExpanderPick, "pickId" | "capperId" | "leagueName" | "category" | "betType" | "propMarket" | "odds" | "oddsSource">;

// One league + bet type + key's platform totals. `key` is the pick's category,
// or its PropMarketKey for a prop that has one. impliedSum / priced are over the
// picks whose price is real (priceOf).
export type PlatformRateRow = { league: string; betType: string; key: string; wins: number; losses: number; impliedSum: number; priced: number };

type PlatformTotals = { wins: number; losses: number; impliedSum: number; priced: number };

// A plain object, so it can travel in the snapshot to the browser.
export type PlatformRates = {
  byKey: Record<string, PlatformTotals>;
  byLeagueBetType: Record<string, PlatformTotals>;
  byBetType: Record<string, PlatformTotals>;
};

export type ScoringContext = {
  leagueRecords: CapperLeagueRecords;
  // A pick with no card reads its all-leagues record from here.
  categoryRecords?: Record<string, CategoryBreakdownItem | null>;
  propMarketRecords?: Record<string, PropMarketRecord | null>;
  platformRates: PlatformRates;
  // The user's win-% lever (gate.ts), for the breakdown's gate. Absent is 55.
  minWinPct?: number;
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
export type PriceStatus = "REAL" | "REAL_SOURCE_UNKNOWN" | "UNKNOWN";
export type PriceRule =
  | "DEFAULTED"
  | "UNUSABLE_ODDS"
  | "SOURCE_RECORDED"
  | "NO_SOURCE_NOT_PLACEHOLDER"
  | "NO_SOURCE_PLACEHOLDER_SPREAD_TOTAL"
  | "NO_SOURCE_PLACEHOLDER_OTHER";

export type PriceRead = { status: PriceStatus; rule: PriceRule; label: string | null };

export type PlatformTier = "CATEGORY" | "LEAGUE_BET_TYPE" | "BET_TYPE" | "DEFAULT";
export type PlatformRate = { rate: number; n: number; tier: PlatformTier };

export type WinLoss = { wins: number; losses: number };

export type GateCheck = {
  minWinPct: number;
  // The lever as an edge: L minus the -110 break-even. Null at L = 0: no gate.
  requiredEdge: number | null;
  // The pick's: `probability` minus `breakEven`.
  edge: number;
  // The pair the edge was measured from: the model's probability, and the pick's
  // break-even, or the platform's where that was the one used.
  probability: number;
  breakEven: number;
  // The long-shot rule: the raw record against the pick's own break-even. Null when it
  // doesn't apply (L = 0, or no real price).
  raw: RawCheck | null;
  // The edge reaches the required edge AND the raw record clears (when it applies).
  passes: boolean;
};

// `bar` = min(breakEven, L / 100): what the raw record must reach.
export type RawCheck = { wins: number; decided: number; breakEven: number; bar: number; clears: boolean };

// What the long-shot rule reads: the raw record and the pick's own break-even (null: no real price).
export type RawInput = { wins: number; decided: number; breakEven: number | null };

export type ScoreModel = "edge model" | "win-rate model";

export type ScoredPick = {
  status: "SCORED";
  pickId: string;
  model: ScoreModel;
  // Why the win-rate model. Null on the edge model.
  fallback: "NO_REAL_PRICE" | "FEW_PRICED_PICKS" | null;
  // The win-probability hierarchy's answer, on either model.
  shrunkWinProb: number;
  // The chosen model's estimate for this pick: on the edge model p above; else the
  // pick's break-even plus its edge, clamped; with no real price the shrunk probability.
  estimatedWinProb: number;
  // Null: price unknown.
  breakEven: number | null;
  // Shrunk win probability minus the pick's break-even: the win-rate view of the
  // price, on either model. Null: price unknown.
  margin: number | null;
  // What the gate reads, what ranks and what the selection layer weights: one scale for every pick.
  rankScore: number;
  // The edge model's working. Null on the win-rate model.
  edgeModel: { shrunkEdge: number; historicalBreakEven: number; skill: number } | null;
  // A thin capper on a real price: both edges, and which was the worse.
  thin: { capperEdge: number; platformEdge: number; binding: "capper" | "platform" } | null;
  price: PriceRead;
  // Decided picks behind the score, in-league plus other leagues.
  decided: number;
  levels: {
    league: WinLoss;
    otherLeagues: WinLoss;
    // The other-leagues record shrunk toward the platform: this pick's prior.
    midPrior: number;
    platform: PlatformRate;
  };
  // The platform break-even, where the win-rate model read it. Null on the edge model.
  rankYardstick: number | null;
  // Real-priced picks in the category, every league.
  pricedPicks: number;
  gate: GateCheck;
  historicalBreakEven: { rate: number; n: number } | null;
  propMarket?: PropMarketKey;
};

export type UnscoredPick = { status: "NO_RECORD"; pickId: string; reason: "NO_CATEGORY" | "NO_RECORD" | "NO_PROP_MARKET_RECORD" };

export type PickScore = ScoredPick | UnscoredPick;

// ---------------------------------------------------------------------------
// Price
// ---------------------------------------------------------------------------
// A price nobody quoted is never treated as one. In order:
//   - DEFAULTED, or odds that aren't an American price: unknown.
//   - MARKET or STATED: real, even at -110.
//   - No source recorded (a pick from before the column), not -110: real, source unknown.
//   - No source, -110, spread or game total: real, source unknown.
//   - No source, -110, anything else (moneyline, NRFI, team total, prop): unknown.
export function priceOf(pick: Pick<ScoringPick, "betType" | "odds" | "oddsSource">): PriceRead {
  const unknown = (rule: PriceRule): PriceRead => ({ status: "UNKNOWN", rule, label: NO_PRICE_LABEL });
  if (pick.oddsSource === "DEFAULTED") return unknown("DEFAULTED");
  if (!hasUsablePrice(pick.odds)) return unknown("UNUSABLE_ODDS");
  if (pick.oddsSource === "MARKET" || pick.oddsSource === "STATED") return { status: "REAL", rule: "SOURCE_RECORDED", label: null };
  if (pick.odds !== PLACEHOLDER_ODDS) return { status: "REAL_SOURCE_UNKNOWN", rule: "NO_SOURCE_NOT_PLACEHOLDER", label: null };
  if (pick.betType === "SPREAD" || pick.betType === "TOTAL") return { status: "REAL_SOURCE_UNKNOWN", rule: "NO_SOURCE_PLACEHOLDER_SPREAD_TOTAL", label: null };
  return unknown("NO_SOURCE_PLACEHOLDER_OTHER");
}

// The win rate these American odds need to break even, or null for odds that
// aren't a price.
export function breakEvenOf(odds: number): number | null {
  if (!hasUsablePrice(odds)) return null;
  return odds > 0 ? 100 / (odds + 100) : -odds / (-odds + 100);
}

// ---------------------------------------------------------------------------
// Platform rates
// ---------------------------------------------------------------------------
const addTo = (map: Record<string, PlatformTotals>, key: string, row: PlatformRateRow) => {
  const t = (map[key] ??= { wins: 0, losses: 0, impliedSum: 0, priced: 0 });
  t.wins += row.wins;
  t.losses += row.losses;
  t.impliedSum += row.impliedSum;
  t.priced += row.priced;
};

const keyTier = (league: string, key: string) => league + "|" + key;
const leagueTier = (league: string, betType: string) => league + "|" + betType;

export function buildPlatformRates(rows: PlatformRateRow[]): PlatformRates {
  const rates: PlatformRates = { byKey: {}, byLeagueBetType: {}, byBetType: {} };
  for (const row of rows) {
    addTo(rates.byKey, keyTier(row.league, row.key), row);
    addTo(rates.byLeagueBetType, leagueTier(row.league, row.betType), row);
    addTo(rates.byBetType, row.betType, row);
  }
  return rates;
}

export const EMPTY_PLATFORM_RATES: PlatformRates = { byKey: {}, byLeagueBetType: {}, byBetType: {} };

// Only the totals these picks can ask for, every tier: what travels in a snapshot.
// A pick scores the same on the trimmed rates as on the whole table.
export function trimPlatformRates(rates: PlatformRates, picks: Pick<ScoringPick, "leagueName" | "betType" | "propMarket" | "category">[]): PlatformRates {
  const out: PlatformRates = { byKey: {}, byLeagueBetType: {}, byBetType: {} };
  const copy = (from: Record<string, PlatformTotals>, to: Record<string, PlatformTotals>, key: string) => {
    if (from[key]) to[key] = from[key];
  };
  for (const p of picks) {
    const key = propKeyOf(p) ?? p.category;
    if (!key) continue;
    copy(rates.byKey, out.byKey, keyTier(p.leagueName, key));
    copy(rates.byLeagueBetType, out.byLeagueBetType, leagueTier(p.leagueName, p.betType));
    copy(rates.byBetType, out.byBetType, p.betType);
  }
  return out;
}

type RateQuery = { league: string; betType: string; key: string };

const tiersOf = (rates: PlatformRates, q: RateQuery): [PlatformTier, PlatformTotals | undefined][] => [
  ["CATEGORY", rates.byKey[keyTier(q.league, q.key)]],
  ["LEAGUE_BET_TYPE", rates.byLeagueBetType[leagueTier(q.league, q.betType)]],
  ["BET_TYPE", rates.byBetType[q.betType]],
];

// The league + category's rate, or with too few picks the league's rate for the
// bet type (all NBA moneylines), then the bet type's across leagues.
export function platformRateFor(rates: PlatformRates, q: RateQuery): PlatformRate {
  for (const [tier, totals] of tiersOf(rates, q)) {
    const n = totals ? totals.wins + totals.losses : 0;
    if (totals && n >= PLATFORM_MIN_DECIDED) return { rate: totals.wins / n, n, tier };
  }
  return { rate: DEFAULT_PLATFORM_RATE, n: 0, tier: "DEFAULT" };
}

// The average break-even of the platform's priced picks, with the same fallback
// counted on priced picks: what a no-price pick is ranked against.
export function platformBreakEvenFor(rates: PlatformRates, q: RateQuery): number {
  for (const [, totals] of tiersOf(rates, q)) {
    if (totals && totals.priced >= PLATFORM_MIN_DECIDED) return totals.impliedSum / totals.priced;
  }
  return DEFAULT_BREAK_EVEN;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------
export function shrink(wins: number, losses: number, prior: number, strength: number = PRIOR_STRENGTH): number {
  return (wins + strength * prior) / (wins + losses + strength);
}

const propKeyOf = (pick: Pick<ScoringPick, "betType" | "leagueName" | "propMarket">) => propMarketKey({ betType: pick.betType, sportName: pick.leagueName, propMarket: pick.propMarket });

type Column = { wins: number; losses: number } | null | undefined;

// In-league and the rest of overall.
function splitLevels(league: Column, overall: Column): { league: WinLoss; otherLeagues: WinLoss } {
  const lg = { wins: league?.wins ?? 0, losses: league?.losses ?? 0 };
  return {
    league: lg,
    otherLeagues: { wins: Math.max(0, (overall?.wins ?? 0) - lg.wins), losses: Math.max(0, (overall?.losses ?? 0) - lg.losses) },
  };
}

function recordLevels(pick: ScoringPick, ctx: ScoringContext, propKey: PropMarketKey | null): { league: WinLoss; otherLeagues: WinLoss } | null {
  if (propKey) {
    const r = ctx.propMarketRecords?.[propMarketRecordKey(pick.capperId, pick.leagueName, propKey)];
    return r ? splitLevels(r.league, r.allTime) : null;
  }
  if (!pick.category) return null;
  const card = ctx.leagueRecords.records[leagueRecordKey(pick.capperId, pick.leagueName, pick.category)];
  return splitLevels(card?.league, card?.overall ?? ctx.categoryRecords?.[categoryRecordKey(pick.capperId, pick.category)]);
}

// The capper's real-priced picks in the record the pick reads. Null when the bundle wasn't asked for pricing.
function pricedHistory(pick: ScoringPick, ctx: ScoringContext, propKey: PropMarketKey | null): { league: PricedColumn; overall: PricedColumn } | null {
  if (propKey) {
    const p = ctx.propMarketRecords?.[propMarketRecordKey(pick.capperId, pick.leagueName, propKey)]?.priced;
    return p ? { league: p.league, overall: p.allTime } : null;
  }
  if (!pick.category) return null;
  return ctx.leagueRecords.records[leagueRecordKey(pick.capperId, pick.leagueName, pick.category)]?.priced ?? null;
}

// Sum of edges / (n + k) at each level: in-league toward other-leagues, other-leagues toward zero.
export function shrunkEdgeOf(priced: { league: PricedColumn; overall: PricedColumn }, strength: number = PRIOR_STRENGTH): number {
  const { league, overall } = priced;
  const leagueN = league.wins + league.losses;
  const otherN = Math.max(0, overall.wins + overall.losses - leagueN);
  const otherSum = otherN === 0 ? 0 : overall.wins - league.wins - (overall.impliedSum - league.impliedSum);
  const midEdge = otherSum / (otherN + strength);
  return (league.wins - league.impliedSum + strength * midEdge) / (leagueN + strength);
}

const clamp = (p: number) => Math.min(MAX_PROB, Math.max(MIN_PROB, p));
export const logit = (p: number) => Math.log(p / (1 - p));
export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

// The edge a capper earned at their historical prices, moved to this pick's price on the log-odds scale.
export function transferEdge(shrunkEdge: number, historicalBreakEven: number, pickBreakEven: number): { skill: number; probability: number } {
  const skill = logit(clamp(historicalBreakEven + shrunkEdge)) - logit(clamp(historicalBreakEven));
  return { skill, probability: sigmoid(logit(pickBreakEven) + skill) };
}

// ---------------------------------------------------------------------------
// The score
// ---------------------------------------------------------------------------
export function scorePick(pick: ScoringPick, ctx: ScoringContext): PickScore {
  const propKey = propKeyOf(pick);
  const levels = recordLevels(pick, ctx, propKey);
  const decided = levels ? levels.league.wins + levels.league.losses + levels.otherLeagues.wins + levels.otherLeagues.losses : 0;
  // No graded pick at either level is no record: the platform rate never
  // qualifies a pick on its own.
  if (!levels || decided === 0) {
    return { status: "NO_RECORD", pickId: pick.pickId, reason: propKey ? "NO_PROP_MARKET_RECORD" : pick.category ? "NO_RECORD" : "NO_CATEGORY" };
  }

  const query: RateQuery = { league: pick.leagueName, betType: pick.betType, key: propKey ?? pick.category! };
  const platform = platformRateFor(ctx.platformRates, query);
  const midPrior = shrink(levels.otherLeagues.wins, levels.otherLeagues.losses, platform.rate);
  const shrunkWinProb = shrink(levels.league.wins, levels.league.losses, midPrior);

  const price = priceOf(pick);
  const breakEven = price.status === "UNKNOWN" ? null : breakEvenOf(pick.odds);
  const margin = breakEven === null ? null : shrunkWinProb - breakEven;
  const priced = pricedHistory(pick, ctx, propKey);
  const pricedPicks = priced ? priced.overall.wins + priced.overall.losses : 0;
  const historicalBreakEven = priced && pricedPicks > 0 ? priced.overall.impliedSum / pricedPicks : null;
  const minWinPct = ctx.minWinPct ?? GATE_DEFAULT;
  const raw: RawInput = { wins: levels.league.wins + levels.otherLeagues.wins, decided, breakEven };
  const shared = {
    status: "SCORED" as const,
    pickId: pick.pickId,
    shrunkWinProb,
    breakEven,
    margin,
    price,
    decided,
    pricedPicks,
    levels: { ...levels, midPrior, platform },
    historicalBreakEven: historicalBreakEven === null ? null : { rate: historicalBreakEven, n: pricedPicks },
    ...(propKey ? { propMarket: propKey } : {}),
  };

  if (breakEven !== null && priced && historicalBreakEven !== null && pricedPicks >= MIN_PRICED_PICKS) {
    const shrunkEdge = shrunkEdgeOf(priced);
    const { skill, probability } = transferEdge(shrunkEdge, historicalBreakEven, breakEven);
    return {
      ...shared,
      model: "edge model",
      fallback: null,
      estimatedWinProb: probability,
      rankScore: probability - breakEven,
      edgeModel: { shrunkEdge, historicalBreakEven, skill },
      thin: null,
      rankYardstick: null,
      gate: gateCheck(probability, breakEven, minWinPct, raw),
    };
  }

  const yardstick = platformBreakEvenFor(ctx.platformRates, query);
  const platformEdge = shrunkWinProb - yardstick;
  if (breakEven === null) {
    return {
      ...shared,
      model: "win-rate model",
      fallback: "NO_REAL_PRICE",
      estimatedWinProb: shrunkWinProb,
      rankScore: platformEdge,
      edgeModel: null,
      thin: null,
      rankYardstick: yardstick,
      gate: gateCheck(shrunkWinProb, yardstick, minWinPct, raw),
    };
  }
  const capperEdge = margin!;
  const binding = platformEdge < capperEdge ? "platform" : "capper";
  const edge = binding === "platform" ? platformEdge : capperEdge;
  return {
    ...shared,
    model: "win-rate model",
    fallback: "FEW_PRICED_PICKS",
    estimatedWinProb: clamp(breakEven + edge),
    rankScore: edge,
    edgeModel: null,
    thin: { capperEdge, platformEdge, binding },
    rankYardstick: yardstick,
    gate: gateCheck(shrunkWinProb, binding === "platform" ? yardstick : breakEven, minWinPct, raw),
  };
}

// passes = edge >= requiredEdge, written so the -110 break-even cancels exactly: at
// -110 the extra term is 0 and this is the plain "shrunk >= L" to the last bit, where
// subtracting the break-even from both sides could round a boundary pick the other way.
// `raw` adds the long-shot rule (see the header); without it only the edge decides.
export function gateCheck(probability: number, breakEven: number, minWinPct: number, raw?: RawInput | null): GateCheck {
  const edge = probability - breakEven;
  if (minWinPct === 0) return { minWinPct, requiredEdge: null, edge, probability, breakEven, raw: null, passes: true };
  const bar = raw && raw.breakEven !== null ? Math.min(raw.breakEven, minWinPct / 100) : null;
  const rawCheck = raw && raw.breakEven !== null && bar !== null ? { wins: raw.wins, decided: raw.decided, breakEven: raw.breakEven, bar, clears: rawRecordClears(raw.wins, raw.decided, bar) } : null;
  return {
    minWinPct,
    requiredEdge: minWinPct / 100 - DEFAULT_BREAK_EVEN,
    edge,
    probability,
    breakEven,
    raw: rawCheck,
    passes: probability * 100 >= minWinPct + (breakEven - DEFAULT_BREAK_EVEN) * 100 && (rawCheck?.clears ?? true),
  };
}

// The raw record reaches a bar: wins / decided >= bar. Both sides are one correctly rounded
// division of whole numbers (the bar is a break-even, or L / 100), so a record exactly on the
// bar (10-10 at L = 50, 1-3 at +300) clears. No decided pick never clears.
export function rawRecordClears(wins: number, decided: number, bar: number): boolean {
  return decided > 0 && wins / decided >= bar;
}

// The gate at any setting, from a score already built. A pick with no record never
// passes, at any setting (gate.ts: at 0% cappers with no record are still out).
export function passesGate(score: PickScore, minWinPct: number): boolean {
  if (score.status !== "SCORED") return false;
  const raw: RawInput = { wins: score.levels.league.wins + score.levels.otherLeagues.wins, decided: score.decided, breakEven: score.breakEven };
  return gateCheck(score.gate.probability, score.gate.breakEven, minWinPct, raw).passes;
}

// The -110 equivalent: the win rate with this edge at -110, the number the gate
// compares L to. Positive and on Wilson's scale, so the selection layer's bands and
// draw weights read it where they read Wilson. A pick's order is compareScores'.
export function selectionScore(score: ScoredPick): number {
  return Math.max(0, score.rankScore + DEFAULT_BREAK_EVEN);
}

// The one ordering: rankScore descending, then more decided picks, then pick id,
// so equal scores never depend on input order. A pick with no record is last.
export function compareScores(a: PickScore, b: PickScore): number {
  if (a.status === "SCORED" && b.status === "SCORED") {
    if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
    if (b.decided !== a.decided) return b.decided - a.decided;
  } else if (a.status !== b.status) {
    return a.status === "SCORED" ? -1 : 1;
  }
  return a.pickId < b.pickId ? -1 : a.pickId > b.pickId ? 1 : 0;
}
