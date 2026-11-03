// The scoring module's edge model (scoring.ts): shrunk edge, the log-odds price
// transfer, the 5-priced-pick threshold, a thin capper's worse-of-two edges, and
// how the gate at -110 compares with the old raw gate. The win-rate hierarchy,
// price rules and platform fallback are in scoring-acceptance-test.ts. Everything
// marked pinned is intended behavior. Pure - no DB. Run with:
//   npx tsx src/lib/parlay/scoring-edge-model-acceptance-test.ts
import {
  breakEvenOf,
  buildPlatformRates,
  compareScores,
  DEFAULT_BREAK_EVEN,
  MIN_PRICED_PICKS,
  passesGate,
  scorePick,
  shrunkEdgeOf,
  SCORING_VERSION,
  transferEdge,
  type PickScore,
  type PlatformRateRow,
  type PlatformRates,
  type ScoredPick,
  type ScoringContext,
  type ScoringPick,
} from "@/lib/parlay/scoring";
import type { PickCategoryKey } from "@/server/data/stats";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const pct = (x: number) => Math.round(x * 1000) / 10;
const col = (wins: number, losses: number) => ({ wins, losses, pushes: 0, winPct: wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0, count: wins + losses });
const row = (league: string, betType: string, key: string, wins: number, losses: number, impliedSum = 0, priced = 0): PlatformRateRow => ({ league, betType, key, wins, losses, impliedSum, priced });
const FLAT_52 = buildPlatformRates([row("NBA", "MONEYLINE", "FAV_ML", 520, 480)]);

function pick(over: Partial<ScoringPick> = {}): ScoringPick {
  return { pickId: "p", capperId: "c", leagueName: "NBA", category: "FAV_ML", betType: "MONEYLINE", propMarket: null, odds: -110, oddsSource: "MARKET", ...over } as ScoringPick;
}

// A capper whose every pick in this record was at `odds`, all with a real price.
function ctx(league: [number, number], odds: number, rates: PlatformRates = FLAT_52, category: PickCategoryKey = "FAV_ML"): ScoringContext {
  const lg = { wins: league[0], losses: league[1], impliedSum: (league[0] + league[1]) * breakEvenOf(odds)! };
  return {
    leagueRecords: {
      records: { ["c|NBA|" + category]: { category, label: category, league: col(...league), overall: col(...league), priced: { league: lg, overall: lg } } },
      streaks: {},
      last20: {},
    },
    platformRates: rates,
  };
}

const scored = (s: PickScore): ScoredPick => {
  if (s.status !== "SCORED") throw new Error("expected a score");
  return s;
};
const at = (league: [number, number], histOdds: number, pickOdds: number) => scored(scorePick(pick({ odds: pickOdds }), ctx(league, histOdds)));

check("the threshold is 5 real-priced picks", MIN_PRICED_PICKS, 5);
check("the version names the rules", SCORING_VERSION, "hier-k20-logit-edge-min5-ls1-v2");

// ---- Shrunk edge --------------------------------------------------------------------------
{
  const be = DEFAULT_BREAK_EVEN;
  const oneLeague = { wins: 18, losses: 4, impliedSum: 22 * be };
  check("one league: sum of edges over n + k", pct(shrunkEdgeOf({ league: oneLeague, overall: oneLeague })), 15.4);
  check("no picks is no edge", shrunkEdgeOf({ league: { wins: 0, losses: 0, impliedSum: 0 }, overall: { wins: 0, losses: 0, impliedSum: 0 } }), 0);
  const both = shrunkEdgeOf({ league: { wins: 1, losses: 1, impliedSum: 2 * be }, overall: { wins: 61, losses: 41, impliedSum: 102 * be } });
  const mid = (60 - 100 * be) / 120;
  check("in-league shrinks toward other-leagues, which shrinks toward zero", Math.abs(both - (1 - 2 * be + 20 * mid) / 22) < 1e-12, true);
  const none = shrunkEdgeOf({ league: { wins: 2, losses: 0, impliedSum: 2 * be }, overall: { wins: 2, losses: 0, impliedSum: 2 * be } });
  check("no other leagues: the prior is zero edge, not a category rate", Math.abs(none - (2 - 2 * be) / 22) < 1e-12, true);
}

// ---- The log-odds transfer: pinned ----------------------------------------------------------
{
  const base = at([18, 4], -110, -110);
  check("18-4 at -110 passes, edge close to the old model's +15.2", [pct(base.rankScore), base.gate.passes, base.model], [15.4, true, "edge model"]);

  const dear = at([18, 4], -110, -2000);
  check("18-4 history at -110 on a -2000 pick: edge around +2", pct(dear.rankScore), 2.2);
  check("and it fails at 55", dear.gate.passes, false);
  check("and ranks below the same capper at -110", [{ ...dear, pickId: "a" }, { ...base, pickId: "b" }].sort(compareScores).map((s) => s.pickId), ["b", "a"]);

  const dog = at([18, 4], -110, 150);
  check("the same capper on a +150 dog has a larger edge than at -110", [pct(dog.rankScore), dog.rankScore > base.rankScore], [16.1, true]);

  check("at the capper's own price the transfer gives back the shrunk edge", Math.abs(transferEdge(0.154, DEFAULT_BREAK_EVEN, DEFAULT_BREAK_EVEN).probability - DEFAULT_BREAK_EVEN - 0.154) < 1e-12, true);
  check("no edge transfers as no edge at any price", [-2000, -110, 400].every((o) => Math.abs(transferEdge(0, DEFAULT_BREAK_EVEN, breakEvenOf(o)!).probability - breakEvenOf(o)!) < 1e-12), true);
  check("histP clamps, so an extreme edge stays finite", Number.isFinite(transferEdge(0.9, 0.5, 0.5).skill), true);
  check("the estimate stays a probability at any price", [-100000, -2000, 100000].every((o) => { const p = at([18, 4], -110, o).estimatedWinProb; return p > 0 && p < 1; }), true);
  check("the breakdown shows the working", [pct(base.edgeModel!.shrunkEdge), pct(base.edgeModel!.historicalBreakEven), base.edgeModel!.skill > 0, base.fallback, base.thin], [15.4, 52.4, true, null, null]);
  check("estimated win prob is the transferred p", base.estimatedWinProb, base.gate.probability);

  // Pinned so nobody is surprised: the transfer shrinks the edge at a dear price, it doesn't remove it.
  const line = (o: number) => [pct(at([18, 4], -110, o).rankScore), at([18, 4], -110, o).gate.passes];
  check("18-4 history at -110 on a -300 pick still passes", line(-300), [10.2, true]);
  check("18-4 history at -110 on a -500 pick still passes", line(-500), [7.2, true]);
  check("18-4 history at -110 on a -1000 pick still passes", line(-1000), [4.1, true]);
  check("18-4 history at -110 on a +400 pick passes", line(400), [12.4, true]);

  const pinned = at([12, 8], 150, 150);
  check("12-8 at +150 passes on the edge model", [pct(pinned.rankScore), pinned.gate.passes, pinned.model], [10, true, "edge model"]);
  const zeroFive = at([0, 5], 400, 400);
  check("0-5 at +400 fails on the edge model", [pct(zeroFive.rankScore), zeroFive.gate.passes, zeroFive.model], [-4, false, "edge model"]);
  check("18-4 earned at -300 is worth less than 18-4 earned at -110", at([18, 4], -300, -110).rankScore < base.rankScore, true);
  check("a losing priced record has a negative edge", at([4, 18], -110, -110).rankScore < 0, true);
}

// ---- Which model ----------------------------------------------------------------------------
{
  const twoOfMany = ctx([18, 4], -110);
  twoOfMany.leagueRecords.records["c|NBA|FAV_ML"]!.priced = { league: { wins: 2, losses: 0, impliedSum: 1 }, overall: { wins: 2, losses: 0, impliedSum: 1 } };
  const s = scored(scorePick(pick(), twoOfMany));
  check("a capper with 2 priced picks uses the win-rate model", [s.model, s.fallback, s.pricedPicks], ["win-rate model", "FEW_PRICED_PICKS", 2]);
  check("their unpriced picks still count toward the win rate", pct(s.shrunkWinProb), 67.6);
  const five = ctx([3, 1], -110);
  five.leagueRecords.records["c|NBA|FAV_ML"]!.priced = { league: { wins: 3, losses: 1, impliedSum: 2 }, overall: { wins: 4, losses: 1, impliedSum: 2.5 } };
  check("exactly 5 across leagues is the edge model", scored(scorePick(pick(), five)).model, "edge model");
  const four = ctx([3, 1], -110);
  check("4 is not", scored(scorePick(pick(), four)).model, "win-rate model");
  const noPrice = scored(scorePick(pick({ oddsSource: "DEFAULTED" }), ctx([18, 4], -110)));
  check("no real price on the pick: win-rate, whatever the history", [noPrice.model, noPrice.fallback, noPrice.price.label, noPrice.margin], ["win-rate model", "NO_REAL_PRICE", "no price data", null]);
  const noPricing: ScoringContext = { leagueRecords: { records: { "c|NBA|FAV_ML": { category: "FAV_ML", label: "", league: col(18, 4), overall: col(18, 4) } }, streaks: {}, last20: {} }, platformRates: FLAT_52 };
  check("records read without pricing: no edge model, nothing thrown", [scored(scorePick(pick(), noPricing)).model, scored(scorePick(pick(), noPricing)).pricedPicks], ["win-rate model", 0]);
}

// ---- A thin capper on a real price: the worse of the two edges: pinned ------------------------
{
  // NBA win rates from prod. The 42% and 62% average break-evens are assumed: the prod query for them hasn't been run.
  const rates = buildPlatformRates([row("NBA", "MONEYLINE", "DOG_ML", 19, 31, 21, 50), row("NBA", "MONEYLINE", "FAV_ML", 118, 75, 119.66, 193)]);
  const thin = (league: [number, number], odds: number, category: PickCategoryKey) => scored(scorePick(pick({ category, odds }), ctx(league, odds, rates, category)));

  const longShot = thin([0, 1], 200, "DOG_ML");
  check("0-1 at +200 fails, on the platform's edge", [longShot.gate.passes, pct(longShot.thin!.capperEdge), pct(longShot.thin!.platformEdge), longShot.thin!.binding], [false, 2.9, -5.8, "platform"]);
  check("0-3 at +300 fails", [thin([0, 3], 300, "DOG_ML").gate.passes, thin([0, 3], 300, "DOG_ML").model], [false, "win-rate model"]);
  const heavy = thin([2, 0], -500, "FAV_ML");
  check("2-0 at -500 fails, on the capper's edge", [heavy.gate.passes, pct(heavy.thin!.capperEdge), pct(heavy.thin!.platformEdge), heavy.thin!.binding], [false, -18.7, 2.7, "capper"]);
  check("0-1 favorite at -200 fails", [thin([0, 1], -200, "FAV_ML").gate.passes, pct(thin([0, 1], -200, "FAV_ML").rankScore)], [false, -8.4]);
  check("the gate and ranking both read the worse edge", [heavy.rankScore, heavy.gate.edge].every((e) => e === heavy.thin!.capperEdge), true);
  check("the estimate is the pick's break-even plus that edge", pct(longShot.estimatedWinProb), pct(1 / 3 + longShot.thin!.platformEdge));
  check("the estimate clamps", thin([0, 4], 3000, "DOG_ML").estimatedWinProb, 0.01);
}

// ---- -110 and the old raw gate ----------------------------------------------------------------
{
  const oldRawGate = (p: number, L: number) => p * 100 >= L;
  const spreads = (rate: number, be: number) => buildPlatformRates([row("NBA", "SPREAD", "SPREAD_MINUS", Math.round(rate * 1000), 1000 - Math.round(rate * 1000), be * 1000, 1000)]);
  const noRows = buildPlatformRates([row("NBA", "SPREAD", "SPREAD_MINUS", 520, 480)]);
  const spread = pick({ betType: "SPREAD", category: "SPREAD_MINUS", odds: -110 });
  const grid = (build: (w: number, l: number) => ScoringContext, minN: number, maxN: number, L: number) => {
    let total = 0;
    let newlyPass = 0;
    let newlyFail = 0;
    for (let w = 0; w <= 60; w++) {
      for (let l = 0; l <= 60; l++) {
        if (w + l < minN || w + l > maxN) continue;
        const s = scored(scorePick(spread, build(w, l)));
        const before = oldRawGate(s.shrunkWinProb, L);
        total++;
        if (passesGate(s, L) && !before) newlyPass++;
        if (!passesGate(s, L) && before) newlyFail++;
      }
    }
    return { total, newlyPass, newlyFail };
  };
  const thinCtx = (rates: PlatformRates) => (w: number, l: number) => ctx([w, l], -110, rates, "SPREAD_MINUS");

  // Pinned: the win-rate model on the default break-even IS the old gate, at every setting.
  for (const L of [55, 52, 60, 0]) {
    const g = grid(thinCtx(noRows), 1, 4, L);
    check(`win-rate model, default break-even, L=${L}: identical to the old raw gate`, [g.total, g.newlyPass, g.newlyFail], [14, 0, 0]);
  }

  // Reported, not pinned to zero.
  for (const be of [0.5245, 0.53, 0.54]) {
    for (const L of [52, 55, 60]) {
      const g = grid(thinCtx(spreads(0.52, be)), 1, 4, L);
      console.log(`REPORT win-rate model, platform break-even ${pct(be)}, L=${L}: ${g.newlyPass + g.newlyFail} of ${g.total} differ from the raw gate (+${g.newlyPass} / -${g.newlyFail})`);
    }
  }
  for (const rate of [0.46, 0.5, 0.52, 0.55, 0.58]) {
    for (const L of [52, 55, 60]) {
      const g = grid(thinCtx(spreads(rate, DEFAULT_BREAK_EVEN)), 5, 120, L);
      console.log(`REPORT edge model at -110, platform rate ${pct(rate)}, L=${L}: ${g.newlyPass + g.newlyFail} of ${g.total} differ from the raw gate (+${g.newlyPass} / -${g.newlyFail})`);
    }
  }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
