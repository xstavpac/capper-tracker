// The Parlay Generator's record score: a pick's combined win %, from its capper's
// records alone. The Standard generator gates and ranks on it (generator.ts
// scorerFor); odds no longer affect whether a pick passes or where it ranks, they
// only set the payout. Pure and client-safe: it reads only what the snapshot
// already holds (generator-snapshot.ts's one record bundle).
//
// Decided picks only (pushes out), K and F from RECORD_SCORE_CONFIG:
//   p_other  = (W_cat - W_lg + K * prior) / (N_cat - N_lg + K)
//                                                       the capper's record in the pick's category
//                                                       in their OTHER leagues (all-time minus this league)
//   p_league = (W_lg + K * p_other) / (N_lg + K)        this league's record shrunk toward it;
//                                                       no league record: p_league = p_other
// Each pick counts once. The middle level is all-time minus the league, never all-time:
// shrinking the league record toward an all-time record that already holds it counts the
// league picks twice (3-0 in-league scored 70.4% that way, against 61.5% counted once). So a
// record scores the same whether it sits in this league or elsewhere (scoring.ts has the same
// rule for its middle level).
//   combined = (1 - F) * p_league + F * last20          last20: the capper's Last 20 win %
//                                                       (every category and league); none: p_league
// A player prop with a market key reads its per-market record (all-time = the market's
// sport family, league = this league), exactly as the shown record does. No decided pick
// in the category: no record, never eligible.
//
// Gate: combined >= the user's gate % (55 means 55%). 0 is no gate. Ranking:
// combined descending, then the larger N_cat, then pick id (scoring.ts compareScores,
// which reads rankScore = combined and decided = N_cat).
//
// The edge model (scoring.ts scorePick) is kept, unused by the Standard generator,
// so the two can be compared (scripts/t2-harness/record-score-backtest.sql).
import { breakEvenOf, priceOf, type PickScore, type ScoredPick, type ScoringContext, type ScoringPick, type WinLoss } from "@/lib/parlay/scoring";
import { propMarketKey } from "@/lib/prop-market-key";
import { categoryRecordKey, leagueRecordKey, propMarketRecordKey } from "@/lib/record-keys";

export type RecordScoreConfig = {
  // Prior strength, in picks, at both levels.
  k: number;
  // The Last 20 weight.
  f: number;
  // What a capper with no category history is shrunk toward.
  prior: number;
};

// K = 15, F = 0.10, on the 30-day backtest (scripts/t2-harness/record-score-backtest.sql) over
// K = 10 / 15 / 20 x F = 0.10 / 0.20. K = 10 ties 1-0 with 19-15 exactly (6/11 = 24/44); K > 10 breaks it.
export const RECORD_SCORE_CONFIG: Readonly<RecordScoreConfig> = Object.freeze({ k: 15, f: 0.1, prior: 0.5 });

export const RECORD_SCORING_VERSION = "record-other-k15-f10-p50-v2";

export type CombinedInput = { category: WinLoss; league: WinLoss | null; last20: WinLoss | null };
// pOther: the other-leagues level (the league's prior). nCat: decided picks in the category, every league.
export type CombinedWinProb = { pOther: number; pLeague: number; last20: number | null; combined: number; nCat: number };

const decidedOf = (r: WinLoss | null | undefined) => (r ? r.wins + r.losses : 0);

// The formula alone, on win-loss records (pushes already out).
export function combinedWinProb(input: CombinedInput, cfg: RecordScoreConfig = RECORD_SCORE_CONFIG): CombinedWinProb {
  const nCat = decidedOf(input.category);
  const lgWins = input.league?.wins ?? 0;
  const nLg = decidedOf(input.league);
  // Other leagues = all-time minus this league (never below zero: a league column can't exceed all-time).
  const otherWins = Math.max(0, input.category.wins - lgWins);
  const otherN = Math.max(0, nCat - nLg);
  const pOther = (otherWins + cfg.k * cfg.prior) / (otherN + cfg.k);
  const pLeague = nLg > 0 ? (lgWins + cfg.k * pOther) / (nLg + cfg.k) : pOther;
  const n20 = decidedOf(input.last20);
  const last20 = input.last20 && n20 > 0 ? input.last20.wins / n20 : null;
  const combined = last20 === null ? pLeague : (1 - cfg.f) * pLeague + cfg.f * last20;
  return { pOther, pLeague, last20, combined, nCat };
}

// The gate on a combined probability. Written on whole-number percents so a record exactly
// on the gate (0.55 at 55) passes whatever the float rounding.
export function recordGatePasses(combined: number, minWinPct: number): boolean {
  if (minWinPct === 0) return true;
  return Math.round(combined * 1e9) / 1e7 >= minWinPct;
}

type Column = { wins: number; losses: number } | null | undefined;
const winLoss = (c: Column): WinLoss => ({ wins: c?.wins ?? 0, losses: c?.losses ?? 0 });

// The records the formula reads for this pick, from the snapshot's maps. Null: no category record.
export function recordInputs(pick: ScoringPick, ctx: Pick<ScoringContext, "leagueRecords" | "categoryRecords" | "propMarketRecords">): (CombinedInput & { propMarket?: ScoredPick["propMarket"] }) | null {
  const l20 = ctx.leagueRecords.last20?.[pick.capperId];
  const last20 = l20 ? winLoss(l20) : null;
  const propKey = propMarketKey({ betType: pick.betType, sportName: pick.leagueName, propMarket: pick.propMarket });
  if (propKey) {
    const r = ctx.propMarketRecords?.[propMarketRecordKey(pick.capperId, pick.leagueName, propKey)];
    if (!r || decidedOf(r.allTime) === 0) return null;
    return { category: winLoss(r.allTime), league: winLoss(r.league), last20, propMarket: propKey };
  }
  if (!pick.category) return null;
  const card = ctx.leagueRecords.records[leagueRecordKey(pick.capperId, pick.leagueName, pick.category)];
  const overall = card?.overall ?? ctx.categoryRecords?.[categoryRecordKey(pick.capperId, pick.category)];
  if (!overall || decidedOf(overall) === 0) return null;
  return { category: winLoss(overall), league: card ? winLoss(card.league) : null, last20 };
}

// A pick's record score, in scoring.ts's PickScore shape so the generator's gate, ranking,
// selection and trace read it unchanged. rankScore is the combined probability (0..1);
// `decided` is N_cat, compareScores' tie-break. The price is read for the breakdown only.
export function scorePickByRecord(pick: ScoringPick, ctx: ScoringContext, cfg: RecordScoreConfig = RECORD_SCORE_CONFIG): PickScore {
  const propKey = propMarketKey({ betType: pick.betType, sportName: pick.leagueName, propMarket: pick.propMarket });
  const inputs = recordInputs(pick, ctx);
  if (!inputs) return { status: "NO_RECORD", pickId: pick.pickId, reason: propKey ? "NO_PROP_MARKET_RECORD" : pick.category ? "NO_RECORD" : "NO_CATEGORY" };
  const c = combinedWinProb(inputs, cfg);
  const minWinPct = ctx.minWinPct ?? 55;
  const price = priceOf(pick);
  const breakEven = price.status === "UNKNOWN" ? null : breakEvenOf(pick.odds);
  const league = inputs.league ?? { wins: 0, losses: 0 };
  const bar = minWinPct / 100;
  return {
    status: "SCORED",
    pickId: pick.pickId,
    model: "record model",
    fallback: null,
    shrunkWinProb: c.combined,
    estimatedWinProb: c.combined,
    breakEven,
    margin: breakEven === null ? null : c.combined - breakEven,
    rankScore: c.combined,
    edgeModel: null,
    thin: null,
    price,
    decided: c.nCat,
    levels: {
      league,
      otherLeagues: { wins: Math.max(0, inputs.category.wins - league.wins), losses: Math.max(0, inputs.category.losses - league.losses) },
      midPrior: c.pOther,
      platform: { rate: cfg.prior, n: 0, tier: "DEFAULT" },
    },
    rankYardstick: null,
    pricedPicks: 0,
    // The gate as a win %: probability = combined against the gate itself; requiredEdge 0
    // (null at 0%: no gate), so `edge` is how far above or below the gate the pick sits.
    gate: { minWinPct, requiredEdge: minWinPct === 0 ? null : 0, edge: c.combined - bar, probability: c.combined, breakEven: bar, raw: null, passes: recordGatePasses(c.combined, minWinPct) },
    historicalBreakEven: null,
    record: c,
    ...(inputs.propMarket ? { propMarket: inputs.propMarket } : {}),
  };
}
