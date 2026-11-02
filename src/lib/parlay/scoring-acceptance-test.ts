// The Parlay Generator's scoring module (scoring.ts): the hierarchical record and
// its sanity targets, the price rules, the win-rate model, the gate and the
// platform-rate fallback. These picks have no priced history, so they are on the
// win-rate model; the edge model is in scoring-edge-model-acceptance-test.ts. Pure - no DB. Run with:
//   npx tsx src/lib/parlay/scoring-acceptance-test.ts
import {
  breakEvenOf,
  buildPlatformRates,
  compareScores,
  DEFAULT_BREAK_EVEN,
  DEFAULT_PLATFORM_RATE,
  gateCheck,
  NO_PRICE_LABEL,
  passesGate,
  platformBreakEvenFor,
  platformRateFor,
  PLATFORM_MIN_DECIDED,
  priceOf,
  PRIOR_STRENGTH,
  SCORING_VERSION,
  scorePick,
  shrink,
  type PickScore,
  type PlatformRateRow,
  type PlatformRates,
  type ScoredPick,
  type ScoringContext,
  type ScoringPick,
} from "@/lib/parlay/scoring";
import type { CapperLeagueRecords, PropMarketRecord } from "@/server/data/picks";
import type { CategoryBreakdownItem, PickCategoryKey } from "@/server/data/stats";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

// Percentage points, one decimal.
const pct = (x: number) => Math.round(x * 1000) / 10;
const col = (wins: number, losses: number, pushes = 0) => ({ wins, losses, pushes, winPct: wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0, count: wins + losses + pushes });

const row = (league: string, betType: string, key: string, wins: number, losses: number, impliedSum = 0, priced = 0): PlatformRateRow => ({ league, betType, key, wins, losses, impliedSum, priced });
// A 52% platform: the sanity targets' premise.
const FLAT_52 = buildPlatformRates([row("NBA", "MONEYLINE", "FAV_ML", 520, 480), row("NBA", "SPREAD", "SPREAD_MINUS", 520, 480)]);

function pick(over: Partial<ScoringPick> = {}): ScoringPick {
  return { pickId: "p", capperId: "c", leagueName: "NBA", category: "FAV_ML", betType: "MONEYLINE", propMarket: null, odds: -110, oddsSource: "MARKET", ...over } as ScoringPick;
}

// A capper with this in-league record and, by default, nothing elsewhere.
function ctx(league: [number, number], other: [number, number] = [0, 0], rates: PlatformRates = FLAT_52, category: PickCategoryKey = "FAV_ML"): ScoringContext {
  const records: CapperLeagueRecords["records"] = {
    ["c|NBA|" + category]: { category, label: category, league: col(...league), overall: col(league[0] + other[0], league[1] + other[1]) },
  };
  return { leagueRecords: { records, streaks: {}, last20: {} }, platformRates: rates };
}

const scored = (s: PickScore): ScoredPick => {
  if (s.status !== "SCORED") throw new Error("expected a score for " + s.pickId + ": " + s.reason);
  return s;
};
const shrunk = (league: [number, number], other?: [number, number]) => pct(scored(scorePick(pick(), ctx(league, other))).shrunkWinProb);

// ---- Sanity targets (52% platform, prior strength 20) ---------------------------------
check("prior strength is 20", PRIOR_STRENGTH, 20);
check("8-0 scores well above 55", shrunk([8, 0]), 65.7);
check("1-0 counts partially, ~54", shrunk([1, 0]), 54.3);
check("18-4 is ~68", shrunk([18, 4]), 67.6);
check("550-450 is ~55", shrunk([550, 450]), 54.9);
{
  const a = scorePick(pick({ pickId: "a" }), ctx([15, 4]));
  const b = scorePick(pick({ pickId: "b" }), ctx([550, 450]));
  check("15-4 ranks above 550-450", [a, b].sort(compareScores).map((s) => s.pickId), ["a", "b"]);
  check("15-4 is 65.1", pct(scored(a).shrunkWinProb), 65.1);
}

// ---- The middle level is other leagues, never overall ---------------------------------
{
  // Counting the in-league picks twice would give 56.5 / 75.1.
  check("a one-league capper's picks count once: 1-0", shrunk([1, 0]) === 56.5, false);
  check("a one-league capper's picks count once: 18-4", shrunk([18, 4]) === 75.1, false);
  check("strong other leagues lift a thin in-league record", shrunk([1, 0], [60, 40]), 60.6);
  check("strong other leagues, thin bad in-league record", shrunk([1, 2], [60, 40]), 55.4);
  check("weak other leagues pull down 8-0", shrunk([8, 0], [2, 10]), 56.3);
  const s = scored(scorePick(pick(), ctx([18, 4], [60, 40])));
  check("the breakdown splits the two records", [s.levels.league, s.levels.otherLeagues], [{ wins: 18, losses: 4 }, { wins: 60, losses: 40 }]);
  check("midPrior is other leagues shrunk toward the platform", pct(s.levels.midPrior), pct(shrink(60, 40, 0.52)));
  check("decided counts both levels", s.decided, 122);
  // A league column ahead of its overall (a record maps read at different moments) is no negative record.
  const bad: ScoringContext = { leagueRecords: { records: { "c|NBA|FAV_ML": { category: "FAV_ML", label: "", league: col(5, 5), overall: col(3, 3) } }, streaks: {}, last20: {} }, platformRates: FLAT_52 };
  check("other leagues never go negative", scored(scorePick(pick(), bad)).levels.otherLeagues, { wins: 0, losses: 0 });
}

// ---- Which record ---------------------------------------------------------------------
{
  const categoryRecords: Record<string, CategoryBreakdownItem | null> = { "c|FAV_ML": { key: "FAV_ML", label: "", ...col(18, 4) } };
  const noCard: ScoringContext = { leagueRecords: { records: {}, streaks: {}, last20: {} }, categoryRecords, platformRates: FLAT_52 };
  const s = scored(scorePick(pick(), noCard));
  check("no card: the all-leagues record is the other-leagues level", [s.levels.league, s.levels.otherLeagues], [{ wins: 0, losses: 0 }, { wins: 18, losses: 4 }]);

  const prop = pick({ betType: "PLAYER_PROP", category: "TD_PROP", propMarket: "POINTS", odds: -115, oddsSource: "MARKET" });
  const pr: PropMarketRecord = { key: "BASKETBALL:POINTS", league: col(10, 5), allTime: col(14, 7) };
  const withProp: ScoringContext = { ...ctx([100, 0], [0, 0], FLAT_52, "TD_PROP"), propMarketRecords: { "c|NBA|BASKETBALL:POINTS": pr } };
  const ps = scored(scorePick(prop, withProp));
  check("a prop with a market key reads its per-market record, not the category", [ps.levels.league, ps.levels.otherLeagues, ps.propMarket], [{ wins: 10, losses: 5 }, { wins: 4, losses: 2 }, "BASKETBALL:POINTS"]);
  check("no per-market record is no record, whatever the category says", scorePick(prop, ctx([100, 0], [0, 0], FLAT_52, "TD_PROP")), { status: "NO_RECORD", pickId: "p", reason: "NO_PROP_MARKET_RECORD" });
  const noKey = scored(scorePick({ ...prop, propMarket: null }, ctx([9, 3], [0, 0], FLAT_52, "TD_PROP")));
  check("a prop with no key keeps the category path", noKey.levels.league, { wins: 9, losses: 3 });

  check("no category", scorePick(pick({ category: null }), ctx([9, 3])), { status: "NO_RECORD", pickId: "p", reason: "NO_CATEGORY" });
  check("no card and no all-leagues record", scorePick(pick({ category: "DOG_ML" }), ctx([9, 3])), { status: "NO_RECORD", pickId: "p", reason: "NO_RECORD" });
  check("0-0 at both levels: the platform rate alone never scores a pick", scorePick(pick(), ctx([0, 0])), { status: "NO_RECORD", pickId: "p", reason: "NO_RECORD" });
  const pushes: ScoringContext = { leagueRecords: { records: { "c|NBA|FAV_ML": { category: "FAV_ML", label: "", league: col(0, 0, 4), overall: col(0, 0, 4) } }, streaks: {}, last20: {} }, platformRates: FLAT_52 };
  check("pushes only is no record", scorePick(pick(), pushes).status, "NO_RECORD");
}

// ---- Price rules ----------------------------------------------------------------------
{
  const cases: [string, Partial<ScoringPick>, string, string][] = [
    ["MARKET", { oddsSource: "MARKET", odds: -135 }, "REAL", "SOURCE_RECORDED"],
    ["STATED", { oddsSource: "STATED", odds: 120 }, "REAL", "SOURCE_RECORDED"],
    ["MARKET at -110", { oddsSource: "MARKET", odds: -110 }, "REAL", "SOURCE_RECORDED"],
    ["STATED at -110 on a prop", { oddsSource: "STATED", odds: -110, betType: "PLAYER_PROP" }, "REAL", "SOURCE_RECORDED"],
    ["no source, not -110", { oddsSource: null, odds: -125 }, "REAL_SOURCE_UNKNOWN", "NO_SOURCE_NOT_PLACEHOLDER"],
    ["no source, not -110, on a prop", { oddsSource: null, odds: -125, betType: "PLAYER_PROP" }, "REAL_SOURCE_UNKNOWN", "NO_SOURCE_NOT_PLACEHOLDER"],
    ["no source, -110, spread", { oddsSource: null, odds: -110, betType: "SPREAD" }, "REAL_SOURCE_UNKNOWN", "NO_SOURCE_PLACEHOLDER_SPREAD_TOTAL"],
    ["no source, -110, total", { oddsSource: null, odds: -110, betType: "TOTAL" }, "REAL_SOURCE_UNKNOWN", "NO_SOURCE_PLACEHOLDER_SPREAD_TOTAL"],
    ["no source, -110, moneyline", { oddsSource: null, odds: -110, betType: "MONEYLINE" }, "UNKNOWN", "NO_SOURCE_PLACEHOLDER_OTHER"],
    ["no source, -110, NRFI", { oddsSource: null, odds: -110, betType: "NRFI" }, "UNKNOWN", "NO_SOURCE_PLACEHOLDER_OTHER"],
    ["no source, -110, team total", { oddsSource: null, odds: -110, betType: "TEAM_TOTAL" }, "UNKNOWN", "NO_SOURCE_PLACEHOLDER_OTHER"],
    ["no source, -110, prop", { oddsSource: null, odds: -110, betType: "PLAYER_PROP" }, "UNKNOWN", "NO_SOURCE_PLACEHOLDER_OTHER"],
    ["undefined source reads as no source", { oddsSource: undefined, odds: -110, betType: "MONEYLINE" }, "UNKNOWN", "NO_SOURCE_PLACEHOLDER_OTHER"],
    ["DEFAULTED spread", { oddsSource: "DEFAULTED", odds: -110, betType: "SPREAD" }, "UNKNOWN", "DEFAULTED"],
    ["DEFAULTED total", { oddsSource: "DEFAULTED", odds: -110, betType: "TOTAL" }, "UNKNOWN", "DEFAULTED"],
    ["DEFAULTED at any price", { oddsSource: "DEFAULTED", odds: 150 }, "UNKNOWN", "DEFAULTED"],
    ["odds 0", { oddsSource: "MARKET", odds: 0 }, "UNKNOWN", "UNUSABLE_ODDS"],
    ["odds inside +/-100", { oddsSource: null, odds: 50 }, "UNKNOWN", "UNUSABLE_ODDS"],
  ];
  for (const [label, over, status, rule] of cases) {
    const p = priceOf(pick(over));
    check("price: " + label, [p.status, p.rule, p.label], [status, rule, status === "UNKNOWN" ? NO_PRICE_LABEL : null]);
  }
}

// ---- The price-aware score ------------------------------------------------------------
{
  check("break-even at -110, -300, +130, +100", [-110, -300, 130, 100].map((o) => pct(breakEvenOf(o)!)), [52.4, 75, 43.5, 50]);
  check("no break-even for odds that aren't a price", breakEvenOf(0), null);
  const at = (odds: number, league: [number, number] = [18, 4]) => scored(scorePick(pick({ odds, oddsSource: "MARKET" }), ctx(league)));
  check("18-4 at -110: margin 15.2", pct(at(-110).margin!), 15.2);
  check("18-4 at -300: margin -7.4", pct(at(-300).margin!), -7.4);
  check("18-4 at +130: margin 24.1", pct(at(130).margin!), 24.1);
  check("at -110 on the default break-even a thin capper ranks on its margin", at(-110).rankScore, at(-110).margin);
  check("price never moves the win probability", at(-300).shrunkWinProb, at(130).shrunkWinProb);
  const heavy = scorePick(pick({ pickId: "heavy", odds: -500 }), ctx([18, 4]));
  const thin = scorePick(pick({ pickId: "thin", odds: -110 }), ctx([550, 450]));
  check("a heavy favorite doesn't float to the top: 18-4 at -500 ranks below 550-450 at -110", [heavy, thin].sort(compareScores).map((s) => s.pickId), ["thin", "heavy"]);
}

// ---- Price unknown --------------------------------------------------------------------
{
  const noPrice = scored(scorePick(pick({ oddsSource: "DEFAULTED" }), ctx([18, 4])));
  check("no break-even, no margin, labelled", [noPrice.breakEven, noPrice.margin, noPrice.price.label], [null, null, "no price data"]);
  check("the win probability is the plain shrunk rate", pct(noPrice.shrunkWinProb), 67.6);
  check("thin yardstick: ranked against -110", noPrice.rankYardstick, DEFAULT_BREAK_EVEN);

  // 56% with no price must not bury 18-4 at -110: the raw probability would.
  const a = scorePick(pick({ pickId: "no-price", oddsSource: "DEFAULTED" }), ctx([8, 5]));
  const b = scorePick(pick({ pickId: "priced", odds: -110, oddsSource: "MARKET" }), ctx([18, 4]));
  check("a mediocre no-price pick doesn't outrank a strong priced one", [a, b].sort(compareScores).map((s) => s.pickId), ["priced", "no-price"]);
  check("same record, same -110-shaped yardstick: the two scales agree", pct(scored(scorePick(pick({ oddsSource: "DEFAULTED" }), ctx([18, 4]))).rankScore), pct(scored(scorePick(pick({ odds: -110 }), ctx([18, 4]))).rankScore));

  const rates = buildPlatformRates([row("NBA", "MONEYLINE", "FAV_ML", 60, 40, 60, 100)]);
  const s = scored(scorePick(pick({ oddsSource: "DEFAULTED" }), ctx([18, 4], [0, 0], rates)));
  check("a platform yardstick with enough priced picks is used", s.rankYardstick, 0.6);
  check("its rank score is the shrunk rate minus the yardstick", s.rankScore, s.shrunkWinProb - 0.6);
  check("still no margin: the yardstick isn't its price", [s.breakEven, s.margin], [null, null]);
}

// ---- The gate: L is the edge a capper at L% has at -110 ----------------------------------
{
  const s = scorePick(pick(), ctx([18, 4]));
  check("clears 55 and 65, not 70", [55, 65, 70].map((g) => passesGate(s, g)), [true, true, false]);
  check("the shrunk rate decides, not the raw 75%: 3-1 is 55.8", [pct(scored(scorePick(pick(), ctx([3, 1]))).shrunkWinProb), passesGate(scorePick(pick(), ctx([3, 1])), 55)], [55.8, true]);
  check("1-0 at 54.3 stays below a 55 gate", passesGate(scorePick(pick(), ctx([1, 0])), 55), false);
  check("the worse edge decides: 18-4 at -500 and -300 fail, -110 and +300 pass", [-500, -300, -110, 300].map((odds) => passesGate(scorePick(pick({ odds }), ctx([18, 4])), 55)), [false, false, true, true]);
  check("L = 0 is no gate: a losing record at a bad price passes", passesGate(scorePick(pick({ odds: -500 }), ctx([0, 9])), 0), true);
  check("no record never passes, even at 0", passesGate(scorePick(pick({ category: null }), ctx([9, 3])), 0), false);

  // In the breakdown.
  const g = scored(scorePick(pick({ odds: 150 }), { ...ctx([12, 8]), minWinPct: 60 })).gate;
  check("the breakdown shows the required edge and the pick's", [g.minWinPct, pct(g.requiredEdge!), pct(g.edge), pct(g.breakEven)], [60, 7.6, 3.6, 52.4]);
  check("absent L in the context is 55", scored(scorePick(pick(), ctx([18, 4]))).gate.minWinPct, 55);
  check("L = 0 has no required edge", scored(scorePick(pick(), { ...ctx([18, 4]), minWinPct: 0 })).gate.requiredEdge, null);
  check("the breakdown agrees with passesGate", [scored(scorePick(pick({ odds: -500 }), ctx([18, 4]))).gate.passes, passesGate(scorePick(pick({ odds: -500 }), ctx([18, 4])), 55)], [false, false]);
  const priced = scored(scorePick(pick({ odds: 150 }), ctx([12, 8])));
  const noPrice = scored(scorePick(pick({ oddsSource: "DEFAULTED" }), ctx([12, 8])));
  check("the gate's edge is the score ranking reads, priced and not", [priced.gate.edge === priced.rankScore, noPrice.gate.edge === noPrice.rankScore], [true, true]);

  // At -110 on the default break-even it must be the old raw gate exactly, boundaries included.
  const oldRawGate = (shrunkProb: number, L: number) => shrunkProb * 100 >= L;
  check("the -110 break-even is exactly the reference", breakEvenOf(-110) === DEFAULT_BREAK_EVEN, true);
  let compared = 0;
  let differs = 0;
  for (const L of [55, 52, 60, 0]) {
    for (let w = 0; w <= 40; w++) {
      for (let l = 0; l <= 40; l++) {
        if (w + l === 0) continue;
        for (const source of ["MARKET", null] as const) {
          const sc = scored(scorePick(pick({ betType: "SPREAD", category: "SPREAD_MINUS", odds: -110, oddsSource: source }), ctx([w, l], [0, 0], FLAT_52, "SPREAD_MINUS")));
          compared++;
          if (passesGate(sc, L) !== oldRawGate(sc.shrunkWinProb, L)) differs++;
        }
      }
    }
  }
  check("-110 spreads: same pass/fail as the raw gate at 55, 52, 60, 0 over every record to 40-40", [compared, differs], [13440, 0]);
  // Probabilities sitting on a boundary, where rounding would show.
  const edges = [0.55, 0.52, 0.6, 0.5238095238095238, 0.55 + 1e-16, 0.55 - 1e-16, 0.6000000000000001, 0.5999999999999999];
  check("-110 boundaries: identical to the last bit", edges.flatMap((p) => [55, 52, 60].map((L) => gateCheck(p, DEFAULT_BREAK_EVEN, L).passes === oldRawGate(p, L))).every(Boolean), true);

  // A price unknown gates on the platform's break-even, same fallback.
  const dear = buildPlatformRates([row("NBA", "MONEYLINE", "FAV_ML", 60, 40, 72, 100)]);
  const onPlatform = scored(scorePick(pick({ oddsSource: "DEFAULTED" }), ctx([18, 4], [0, 0], dear)));
  check("no price: the gate's break-even is the platform's", [pct(onPlatform.gate.breakEven), onPlatform.breakEven, onPlatform.margin], [72, null, null]);
  check("no price: a dear platform break-even fails the pick at 55", onPlatform.gate.passes, false);
  const thinPriced = buildPlatformRates([row("NBA", "MONEYLINE", "FAV_ML", 60, 40, 7.2, 10), row("NBA", "MONEYLINE", "DOG_ML", 30, 30, 18, 40)]);
  check("no price: under 30 priced picks falls back the same way", pct(scored(scorePick(pick({ oddsSource: "DEFAULTED" }), ctx([18, 4], [0, 0], thinPriced))).gate.breakEven), pct(25.2 / 50));
  const none = scored(scorePick(pick({ oddsSource: "DEFAULTED" }), ctx([18, 4])));
  check("no price, no priced picks anywhere: -110, so the plain rate decides", [none.gate.breakEven === DEFAULT_BREAK_EVEN, passesGate(none, 65), passesGate(none, 70)], [true, true, false]);
}

// ---- Platform-rate fallback -------------------------------------------------------------
{
  const q = (key: string, betType = "MONEYLINE", league = "NBA") => ({ league, betType, key });
  check("the floor is 30 decided picks", PLATFORM_MIN_DECIDED, 30);

  const rates = buildPlatformRates([
    row("NBA", "MONEYLINE", "FAV_ML", 118, 75),
    row("NBA", "MONEYLINE", "DOG_ML", 19, 31),
    row("NBA", "MONEYLINE", "FIRST_QUARTER_ML", 0, 1),
    row("NBA", "SPREAD", "SPREAD_MINUS", 200, 200),
    row("NCAAF", "MONEYLINE", "FAV_ML", 221, 151),
    row("WNBA", "MONEYLINE", "FIRST_QUARTER_ML", 2, 3),
    row("WNBA", "TEAM_TOTAL", "TEAM_TOTAL", 3, 2),
    row("NFL", "TEAM_TOTAL", "TEAM_TOTAL", 10, 10),
    row("NCAAF", "TEAM_TOTAL", "TEAM_TOTAL", 15, 10),
  ]);
  const own = platformRateFor(rates, q("FAV_ML"));
  check("enough picks: the category's own rate", [own.tier, pct(own.rate), own.n], ["CATEGORY", 61.1, 193]);

  const nba = platformRateFor(rates, q("FIRST_QUARTER_ML"));
  check("NBA FIRST_QUARTER_ML 0-1 falls back to all NBA moneylines", [nba.tier, nba.n, pct(nba.rate)], ["LEAGUE_BET_TYPE", 244, pct(137 / 244)]);
  check("the league tier never mixes in another bet type", platformRateFor(rates, q("FIRST_QUARTER_ML")).n === 244 + 400, false);

  const allLeagues = platformRateFor(rates, q("TEAM_TOTAL", "TEAM_TOTAL", "WNBA"));
  check("a thin league falls back to the bet type across leagues", [allLeagues.tier, allLeagues.n, pct(allLeagues.rate)], ["BET_TYPE", 50, 56]);

  const none = platformRateFor(buildPlatformRates([row("WNBA", "NRFI", "NRFI", 5, 5)]), q("NRFI", "NRFI", "WNBA"));
  check("thin everywhere: the default rate, nothing invented", none, { rate: DEFAULT_PLATFORM_RATE, n: 0, tier: "DEFAULT" });
  check("no rows at all: the default rate", platformRateFor(buildPlatformRates([]), q("FAV_ML")).tier, "DEFAULT");
  check("an unknown league reaches the bet type across leagues", platformRateFor(rates, q("FAV_ML", "MONEYLINE", "MLB")).tier, "BET_TYPE");

  const boundary = (wins: number, losses: number) => platformRateFor(buildPlatformRates([row("NBA", "MONEYLINE", "FAV_ML", wins, losses), row("NCAAF", "MONEYLINE", "FAV_ML", 500, 500)]), q("FAV_ML")).tier;
  check("exactly 30 keeps its own rate", boundary(15, 15), "CATEGORY");
  check("29 falls back", boundary(15, 14), "BET_TYPE");

  const merged = buildPlatformRates([row("NBA", "MONEYLINE", "FAV_ML", 10, 10), row("NBA", "MONEYLINE", "FAV_ML", 10, 10)]);
  check("rows for one key add up", platformRateFor(merged, q("FAV_ML")).n, 40);

  // Prop keys fall back to props, never to the prop's own stored category.
  const props = buildPlatformRates([row("NBA", "PLAYER_PROP", "BASKETBALL:STEALS", 1, 2), row("NBA", "PLAYER_PROP", "BASKETBALL:POINTS", 40, 30)]);
  const steals = platformRateFor(props, q("BASKETBALL:STEALS", "PLAYER_PROP"));
  check("a thin prop market falls back to the league's props", [steals.tier, steals.n], ["LEAGUE_BET_TYPE", 73]);

  // The score carries which tier it used, and it moves the score.
  const thin = buildPlatformRates([row("NBA", "MONEYLINE", "FIRST_QUARTER_ML", 0, 1), row("NBA", "MONEYLINE", "FAV_ML", 70, 30)]);
  const s = scored(scorePick(pick({ category: "FIRST_QUARTER_ML" as PickCategoryKey }), ctx([3, 1], [0, 0], thin, "FIRST_QUARTER_ML" as PickCategoryKey)));
  check("the breakdown names the tier", [s.levels.platform.tier, s.levels.platform.n], ["LEAGUE_BET_TYPE", 101]);
  check("a 0-1 category doesn't set the prior to 0%", pct(s.levels.midPrior), pct(70 / 101));

  // The no-price yardstick falls back on PRICED picks, not decided ones.
  const be = buildPlatformRates([row("NBA", "MONEYLINE", "FAV_ML", 100, 100, 5.8, 10), row("NBA", "MONEYLINE", "DOG_ML", 50, 50, 16, 40)]);
  check("yardstick: 10 priced picks fall back to the league's, 21.8 / 50", platformBreakEvenFor(be, q("FAV_ML")), 21.8 / 50);
  check("yardstick: enough priced picks keep their own", platformBreakEvenFor(be, q("DOG_ML")), 0.4);
  check("yardstick: none anywhere is -110", platformBreakEvenFor(buildPlatformRates([]), q("FAV_ML")), 110 / 210);

  check("rates survive the wire to the browser", platformRateFor(JSON.parse(JSON.stringify(rates)), q("FAV_ML")), own);
}

// ---- Realistic prod-shaped rates, 2026-11-02 ----------------------------------------------
// The plausible rows of the user's prod query, as fixtures only. They pin what the rules do
// on realistic priors; no constant is tuned to them. NHL moneylines and puck lines and MLB
// moneylines are left out on purpose: those rates look like data or grading bugs.
{
  const prod = buildPlatformRates([
    row("NBA", "MONEYLINE", "FAV_ML", 118, 75),
    row("NBA", "MONEYLINE", "DOG_ML", 19, 31),
    row("NCAAF", "MONEYLINE", "FAV_ML", 221, 151),
    row("NCAAF", "MONEYLINE", "DOG_ML", 42, 47),
    row("NFL", "MONEYLINE", "FAV_ML", 215, 161),
    row("NFL", "MONEYLINE", "DOG_ML", 53, 38),
  ]);
  const rate = (league: string, key: string) => pct(platformRateFor(prod, { league, betType: "MONEYLINE", key }).rate);
  check("fixture rates match the query", [rate("NBA", "FAV_ML"), rate("NBA", "DOG_ML"), rate("NCAAF", "FAV_ML"), rate("NCAAF", "DOG_ML"), rate("NFL", "FAV_ML"), rate("NFL", "DOG_ML")], [61.1, 38, 59.4, 47.2, 57.2, 58.2]);

  const nba = (category: PickCategoryKey, league: [number, number]) => pct(scored(scorePick(pick({ category, odds: category === "FAV_ML" ? -150 : 150 }), ctx(league, [0, 0], prod, category))).shrunkWinProb);
  check("NBA favorite ML: 0-1 shrinks to 58.2, 0-3 to 53.2", [nba("FAV_ML", [0, 1]), nba("FAV_ML", [0, 3])], [58.2, 53.2]);
  check("NBA underdog ML: 12-8 shrinks to 49.0, 18-4 to 61.0", [nba("DOG_ML", [12, 8]), nba("DOG_ML", [18, 4])], [49, 61]);
}

// ---- The ordering ---------------------------------------------------------------------
{
  const a = scorePick(pick({ pickId: "a" }), ctx([18, 4]));
  const b = scorePick(pick({ pickId: "b" }), ctx([18, 4]));
  const none = scorePick(pick({ pickId: "0-none", category: null }), ctx([9, 3]));
  check("equal scores: pick id", [b, a].sort(compareScores).map((s) => s.pickId), ["a", "b"]);
  check("no record is last, whatever its id", [none, b, a].sort(compareScores).map((s) => s.pickId), ["a", "b", "0-none"]);
  const big = { ...scored(a), pickId: "z", decided: 500 };
  check("an exact tie goes to more decided picks before the id", [a, big].sort(compareScores).map((s) => s.pickId), ["z", "a"]);
  const order = (xs: PickScore[]) => [...xs].sort(compareScores).map((s) => s.pickId);
  check("input order never matters", order([a, b, none]), order([none, b, a]));
  const none2 = scorePick(pick({ pickId: "1-none", category: null }), ctx([9, 3]));
  check("two with no record: pick id", order([none2, none]), ["0-none", "1-none"]);
}

check("the version names the rules and fits the run log's 80 characters", [SCORING_VERSION, SCORING_VERSION.length <= 80], ["hier-k20-logit-edge-min5-v1", true]);
check("the same input scores the same", JSON.stringify(scorePick(pick(), ctx([18, 4]))) === JSON.stringify(scorePick(pick(), ctx([18, 4]))), true);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll scoring checks passed.");
