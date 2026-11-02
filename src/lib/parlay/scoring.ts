// The Parlay Generator's one scoring module: a pick goes in, a score and its
// breakdown come out. Nothing calls it yet - the generator paths (Standard, Your
// picks only, Hedge, Contrarian, Consensus Hybrid) switch to it in later PRs, and
// until then best-of-two and Wilson (pick-record.ts, qualification-core.ts) still
// decide every parlay. Pure and client-safe: the engine runs in the browser, so
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
// Score: the shrunk probability minus the break-even of the pick's own price
// (`margin`), so a heavy favorite doesn't float to the top.
//
// Price unknown (priceOf): no break-even and no margin, and the label says "no
// price data". Its rankScore is the shrunk probability minus the platform's
// average break-even for the league + category. That is a yardstick and not its
// price: it only puts the pick on the same scale as a margin. Ranked on the raw
// probability (~0.56 against a margin of ~0.15) a no-price pick would beat every
// priced one.
//
// Gate: the user's win-% lever L keeps its label but means "the edge a capper at
// L% has at -110". A pick passes when its edge (rankScore: margin, or the no-price
// yardstick's) reaches L minus the -110 break-even, so at -110 it is exactly the
// plain "shrunk probability >= L". L = 0 is no gate; a pick with no record never
// passes.
//
// A capper's historical break-even (their average implied probability across
// priced picks in the category) is carried in the breakdown for the run log. It
// does not change the score.
import type { ExpanderPick } from "@/components/live/game-picks-expander";
import { hasUsablePrice } from "@/lib/parlay/combine-odds";
import { GATE_DEFAULT } from "@/lib/parlay/gate";
import { propMarketKey, type PropMarketKey } from "@/lib/prop-market-key";
import { categoryRecordKey, leagueRecordKey, propMarketRecordKey } from "@/lib/record-keys";
import type { CapperLeagueRecords, PropMarketRecord } from "@/server/data/picks";
import type { CategoryBreakdownItem } from "@/server/data/stats";

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
// Names these rules in the run log. Any change to a constant above changes it.
export const SCORING_VERSION = "hier-k20-edge-gate-v1";

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
  // Keyed by scoreRecordKey. Absent or missing is null in the breakdown.
  historicalBreakEven?: Record<string, { rate: number; n: number } | null>;
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
  // The pick's: the shrunk probability minus `breakEven`.
  edge: number;
  // The pick's break-even, or the platform's yardstick when its price is unknown.
  breakEven: number;
  passes: boolean;
};

export type ScoredPick = {
  status: "SCORED";
  pickId: string;
  // The gate's input, 0..1.
  shrunkWinProb: number;
  // Null: price unknown.
  breakEven: number | null;
  margin: number | null;
  // What ranks and what the selection layer weights: one scale for every pick.
  rankScore: number;
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
  // The yardstick a no-price pick was ranked against. Null for a priced pick.
  rankYardstick: number | null;
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

const propKeyOf = (pick: ScoringPick) => propMarketKey({ betType: pick.betType, sportName: pick.leagueName, propMarket: pick.propMarket });

// What ScoringContext.historicalBreakEven is keyed by. Null when the pick has no
// record to look up.
export function scoreRecordKey(pick: ScoringPick): string | null {
  const key = propKeyOf(pick);
  if (key) return propMarketRecordKey(pick.capperId, pick.leagueName, key);
  return pick.category ? leagueRecordKey(pick.capperId, pick.leagueName, pick.category) : null;
}

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
  const rankYardstick = margin === null ? platformBreakEvenFor(ctx.platformRates, query) : null;
  const gateBreakEven = breakEven ?? rankYardstick!;
  const recordKey = scoreRecordKey(pick);

  return {
    status: "SCORED",
    pickId: pick.pickId,
    shrunkWinProb,
    breakEven,
    margin,
    rankScore: margin ?? shrunkWinProb - rankYardstick!,
    price,
    decided,
    levels: { ...levels, midPrior, platform },
    rankYardstick,
    gate: gateCheck(shrunkWinProb, gateBreakEven, ctx.minWinPct ?? GATE_DEFAULT),
    historicalBreakEven: (recordKey && ctx.historicalBreakEven?.[recordKey]) || null,
    ...(propKey ? { propMarket: propKey } : {}),
  };
}

// passes = edge >= requiredEdge, written so the -110 break-even cancels exactly: at
// -110 the extra term is 0 and this is the plain "shrunk >= L" to the last bit, where
// subtracting the break-even from both sides could round a boundary pick the other way.
export function gateCheck(shrunkWinProb: number, breakEven: number, minWinPct: number): GateCheck {
  const edge = shrunkWinProb - breakEven;
  if (minWinPct === 0) return { minWinPct, requiredEdge: null, edge, breakEven, passes: true };
  return {
    minWinPct,
    requiredEdge: minWinPct / 100 - DEFAULT_BREAK_EVEN,
    edge,
    breakEven,
    passes: shrunkWinProb * 100 >= minWinPct + (breakEven - DEFAULT_BREAK_EVEN) * 100,
  };
}

// The gate at any setting, from a score already built. A pick with no record never
// passes, at any setting (gate.ts: at 0% cappers with no record are still out).
export function passesGate(score: PickScore, minWinPct: number): boolean {
  return score.status === "SCORED" && gateCheck(score.shrunkWinProb, score.gate.breakEven, minWinPct).passes;
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
