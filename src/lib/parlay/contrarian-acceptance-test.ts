// Contrarian through the engine (PR 7): the other side of the same bet, gated by scoring.ts at its own price,
// chosen by selection.ts. Every Regenerate seed here is pinned (1..200 per mode). Pure - no DB.
import { buildGeneratedParlay, GENERATOR_RULES, WILSON_RULES, type EngineSwap, type GeneratedParlay, type GeneratorSettings, type Variation } from "@/lib/parlay/generator";
import { buildSnapshot, NOW, pickOf, type FixtureGame, type Spec } from "@/lib/parlay/scoring-switch-fixture";
import { EMPTY_PLATFORM_RATES, passesGate, scorePick, type ScoringContext } from "@/lib/parlay/scoring";
import { SELECTION_MODES } from "@/lib/parlay/selection";
import { sameGameConflict } from "@/lib/parlay/same-game-rules";
import { toParlayCandidate, toParlayLeg } from "@/lib/parlay/qualification-core";
import { betCategory } from "@/lib/parlay/bet-category";
import { standardScoringVersion, TraceCollector } from "@/lib/parlay/run-trace";
import { sanitizeClientTrace } from "@/lib/parlay/run-trace-validate";
import type { GeneratorPick } from "@/lib/parlay/auto-generate";
import type { GeneratorSnapshot } from "@/lib/parlay/generator";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

const GAMES: FixtureGame[] = [
  { league: "NBA", home: "Chicago Bulls", away: "Indiana Pacers", nick: "Bulls" },
  { league: "NBA", home: "Boston Celtics", away: "New York Knicks", nick: "Celtics" },
  { league: "MLB", home: "New York Yankees", away: "Boston Red Sox", nick: "Yankees" },
  { league: "NFL", home: "Kansas City Chiefs", away: "Los Angeles Chargers", nick: "Chiefs" },
];
const s = (x: Omit<Spec, "source" | "hist"> & { hist?: number | null; source?: Spec["source"] }): Spec => ({ source: "MARKET", hist: x.odds, ...x });
const snap = (specs: Spec[], slip: string[] = []) => buildSnapshot(specs, slip, [], GAMES);
const one: GeneratorSettings = { legCount: 1, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "YOUR_PICKS_ONLY" };
const ctxOf = (sn: GeneratorSnapshot, gate = 55): ScoringContext => ({
  leagueRecords: sn.leagueRecords,
  categoryRecords: sn.categoryRecords,
  propMarketRecords: sn.propMarketRecords,
  platformRates: sn.platformRates ?? EMPTY_PLATFORM_RATES,
  minWinPct: gate,
});
const alt = (p: GeneratedParlay, scope: keyof GeneratedParlay["contrarian"] = "ALL", i = 0) => p.contrarian[scope].legs[i].swap?.pick.pickId ?? p.contrarian[scope].legs[i].unchangedReason;
const asCandidate = (p: GeneratorPick) => toParlayCandidate(toParlayLeg(p));

// The example: Bulls ML by a 60% favorite-ML capper -> Pacers ML by a 58% underdog-ML capper.
const bulls = s({ id: "bulls-ml", game: 0, category: "FAV_ML", betType: "MONEYLINE", detail: "Bulls ML", odds: -150, lg: [30, 20] });
const pacers = s({ id: "pacers-ml", game: 0, category: "DOG_ML", betType: "MONEYLINE", detail: "Pacers ML", odds: 130, lg: [29, 21] });

// ---- The example -------------------------------------------------------------------
{
  const sn = snap([bulls, pacers], ["bulls-ml"]);
  const p = buildGeneratedParlay(sn, one, null, NOW);
  check("Bulls ML (60% fav-ML capper) -> Pacers ML (58% dog-ML capper)", alt(p), "pacers-ml");
  check("...as the other side of the same bet: SAME_BET, ML, no line", [p.contrarian.ALL.legs[0].swap?.rule, p.contrarian.ALL.legs[0].swap?.contrarian], ["SAME_BET", { market: "ML", lineGap: null }]);
  check("...the alternate shows its own record (29-21)", p.contrarian.ALL.legs[0].swap?.record.wins + "-" + p.contrarian.ALL.legs[0].swap?.record.losses, "29-21");
  check("WILSON_RULES (rollback) still runs the classifier path", buildGeneratedParlay(sn, one, null, NOW, WILSON_RULES).contrarian.ALL.legs[0].swap?.rule, "R2");
}

// ---- A higher-scoring original still swaps -------------------------------------------------
{
  const elite = { ...bulls, lg: [80, 20] as [number, number] };
  const sn = snap([elite, pacers], ["bulls-ml"]);
  const ctx = ctxOf(sn);
  const [a, b] = [scorePick(pickOf(elite, GAMES), ctx), scorePick(pickOf(pacers, GAMES), ctx)];
  check("the original scores higher than the alternate", a.status === "SCORED" && b.status === "SCORED" && a.rankScore > b.rankScore, true);
  check("...and Contrarian still swaps (a hedge, not an upgrade)", alt(buildGeneratedParlay(sn, one, null, NOW)), "pacers-ml");
}

// ---- Nothing qualifies -------------------------------------------------------------------
{
  const cold = { ...pacers, lg: [10, 30] as [number, number] };
  const sn = snap([bulls, cold], ["bulls-ml"]);
  check("the only opposite pick fails the gate", passesGate(scorePick(pickOf(cold, GAMES), ctxOf(sn)), 55), false);
  const p = buildGeneratedParlay(sn, one, null, NOW);
  check("-> NO_QUALIFYING_CONTRARIAN, the leg kept", [p.contrarian.ALL.legs[0].swap, p.contrarian.ALL.legs[0].unchangedReason, p.contrarian.ALL.legs[0].original.pick.pickId], [null, "NO_QUALIFYING_CONTRARIAN", "bulls-ml"]);
  check("no opposite pick at all -> NO_QUALIFYING_CONTRARIAN too", alt(buildGeneratedParlay(snap([bulls], ["bulls-ml"]), one, null, NOW)), "NO_QUALIFYING_CONTRARIAN");
  check("an opposite pick with no record never qualifies", alt(buildGeneratedParlay(snap([bulls, { ...pacers, lg: [0, 0] }], ["bulls-ml"]), one, null, NOW)), "NO_QUALIFYING_CONTRARIAN");
  check("a raised gate (70) refuses the 58% alternate", alt(buildGeneratedParlay(snap([bulls, pacers], ["bulls-ml"]), { ...one, minWinPct: 70 }, null, NOW)), "NO_QUALIFYING_CONTRARIAN");
}

// ---- What counts as the other side, through the engine --------------------------------------------
{
  const cases: [string, Spec, Spec, string][] = [
    ["ML vs the other team's spread: no (same betType only)", bulls, s({ id: "pacers-sp", game: 0, category: "SPREAD_PLUS", betType: "SPREAD", detail: "Pacers +4.5", line: 4.5, odds: -110, lg: [30, 15] }), "NO_QUALIFYING_CONTRARIAN"],
    ["full-game ML vs a 1H ML: no (period)", bulls, s({ id: "pacers-1h", game: 0, category: "FIRST_HALF_ML", betType: "MONEYLINE", detail: "Pacers 1H ML", odds: 140, lg: [30, 15], period: "FIRST_HALF" }), "NO_QUALIFYING_CONTRARIAN"],
    ["1H spread vs the 1H other side: yes", s({ id: "bulls-1h", game: 0, category: "FIRST_HALF_SPREAD", betType: "SPREAD", detail: "Bulls -2.5", line: -2.5, odds: -110, lg: [30, 20], period: "FIRST_HALF" }), s({ id: "pacers-1h-sp", game: 0, category: "FIRST_HALF_SPREAD", betType: "SPREAD", detail: "Pacers +3", line: 3, odds: -110, lg: [30, 15], period: "FIRST_HALF" }), "pacers-1h-sp"],
    ["Bulls -5 vs Pacers +4.5: yes", s({ id: "bulls-sp", game: 0, category: "SPREAD_MINUS", betType: "SPREAD", detail: "Bulls -5", line: -5, odds: -110, lg: [30, 20] }), s({ id: "pacers-45", game: 0, category: "SPREAD_PLUS", betType: "SPREAD", detail: "Pacers +4.5", line: 4.5, odds: -110, lg: [30, 15] }), "pacers-45"],
    ["Bulls -5 vs Pacers +6.5: no (line)", s({ id: "bulls-sp", game: 0, category: "SPREAD_MINUS", betType: "SPREAD", detail: "Bulls -5", line: -5, odds: -110, lg: [30, 20] }), s({ id: "pacers-65", game: 0, category: "SPREAD_PLUS", betType: "SPREAD", detail: "Pacers +6.5", line: 6.5, odds: -110, lg: [30, 15] }), "NO_QUALIFYING_CONTRARIAN"],
    ["Over 220.5 vs Under 221: yes", s({ id: "over", game: 1, category: "OVER", betType: "TOTAL", detail: "Over 220.5", line: 220.5, odds: -110, lg: [30, 20] }), s({ id: "under", game: 1, category: "UNDER", betType: "TOTAL", detail: "Under 221", line: 221, odds: -110, lg: [30, 15] }), "under"],
    ["Tatum Over 27.5 vs Tatum Under 28 Points: yes", s({ id: "t-over", game: 1, category: "TD_PROP", betType: "PLAYER_PROP", detail: "Jayson Tatum Over 27.5 Points", line: 27.5, odds: -115, lg: [30, 20], propMarket: "POINTS" }), s({ id: "t-under", game: 1, category: "TD_PROP", betType: "PLAYER_PROP", detail: "Jayson Tatum Under 28 Points", line: 28, odds: -110, lg: [30, 15], propMarket: "POINTS" }), "t-under"],
    ["NRFI vs YRFI: yes", s({ id: "nrfi", game: 2, category: "NRFI", betType: "NRFI", detail: "NRFI", odds: -120, lg: [30, 20] }), s({ id: "yrfi", game: 2, category: "YRFI", betType: "NRFI", detail: "YRFI", odds: 100, lg: [30, 15] }), "yrfi"],
    ["Yankees team total Over 4.5 vs Under 4.5: yes", s({ id: "tt-o", game: 2, category: "TEAM_TOTAL", betType: "TEAM_TOTAL", detail: "Yankees Over 4.5", line: 4.5, odds: -110, lg: [30, 20] }), s({ id: "tt-u", game: 2, category: "TEAM_TOTAL", betType: "TEAM_TOTAL", detail: "Yankees Under 4.5", line: 4.5, odds: -110, lg: [30, 15] }), "tt-u"],
    ["run line -1.5 vs +2.5: no (exact only)", s({ id: "rl", game: 2, category: "SPREAD_MINUS", betType: "SPREAD", detail: "Yankees -1.5", line: -1.5, odds: 130, lg: [30, 20] }), s({ id: "rl-alt", game: 2, category: "SPREAD_PLUS", betType: "SPREAD", detail: "Red Sox +2.5", line: 2.5, odds: -250, lg: [40, 5] }), "NO_QUALIFYING_CONTRARIAN"],
    ["anytime TD: never", s({ id: "td", game: 3, category: "TD_PROP", betType: "PLAYER_PROP", detail: "Travis Kelce Anytime TD", odds: 120, lg: [30, 20], propMarket: "TD" }), s({ id: "td2", game: 3, category: "TD_PROP", betType: "PLAYER_PROP", detail: "Travis Kelce Anytime TD", odds: 125, lg: [30, 15], propMarket: "TD" }), "NO_QUALIFYING_CONTRARIAN"],
  ];
  for (const [label, leg, other, want] of cases) check(label, alt(buildGeneratedParlay(snap([leg, other], [leg.id]), one, null, NOW)), want);
}

// ---- Among several qualifiers: Generate = top score; Regenerate = a draw among them -------------------------
const crowd: Spec[] = [
  bulls,
  s({ id: "pacers-a", game: 0, category: "DOG_ML", betType: "MONEYLINE", detail: "Pacers ML", odds: 130, lg: [40, 20] }),
  s({ id: "pacers-b", game: 0, category: "DOG_ML", betType: "MONEYLINE", detail: "Pacers ML", odds: 135, lg: [29, 21] }),
  s({ id: "pacers-c", game: 0, category: "DOG_ML", betType: "MONEYLINE", detail: "Pacers ML", odds: 125, lg: [27, 23] }),
];
{
  const sn = snap(crowd, ["bulls-ml"]);
  const ctx = ctxOf(sn);
  const ranked = crowd.slice(1).map((x) => [x.id, scorePick(pickOf(x, GAMES), ctx)] as const).filter(([, sc]) => passesGate(sc, 55)).sort((a, b) => (b[1].status === "SCORED" ? b[1].rankScore : 0) - (a[1].status === "SCORED" ? a[1].rankScore : 0));
  check("all three Pacers MLs qualify", ranked.length, 3);
  check("Generate takes the top score", alt(buildGeneratedParlay(sn, one, null, NOW)), ranked[0][0]);
  check("Generate is deterministic", alt(buildGeneratedParlay(sn, one, null, NOW)), alt(buildGeneratedParlay(snap(crowd, ["bulls-ml"]), one, null, NOW)));
  for (const mode of SELECTION_MODES) {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) seen.add(String(alt(buildGeneratedParlay(sn, one, { seed, history: [], mode }, NOW))));
    check(`Regenerate (${mode}, seeds 1..200): only qualifiers are drawn`, [...seen].every((id) => ranked.some(([r]) => r === id)), true);
    if (mode === "EXPLORE") check("Regenerate (EXPLORE) varies the alternate", seen.size > 1, true);
  }
  const v: Variation = { seed: 7, history: [], mode: "DIVERSIFIED" };
  const scopes = buildGeneratedParlay(sn, one, v, NOW).contrarian;
  check("a Regenerate's alternate is the same under every Swap setting that searches the leg", [scopes.ALL.legs[0].swap?.pick.pickId, scopes.YOUR_PICKS.legs[0].swap?.pick.pickId], [scopes.ALL.legs[0].swap?.pick.pickId, scopes.ALL.legs[0].swap?.pick.pickId]);
}

// ---- Swap setting ------------------------------------------------------------------------
{
  const specs = [bulls, pacers, s({ id: "over", game: 1, category: "OVER", betType: "TOTAL", detail: "Over 220.5", line: 220.5, odds: -110, lg: [40, 20] }), s({ id: "under", game: 1, category: "UNDER", betType: "TOTAL", detail: "Under 221", line: 221, odds: -110, lg: [30, 18] })];
  const p = buildGeneratedParlay(snap(specs, ["bulls-ml"]), { legCount: 2, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE" }, null, NOW);
  const view = (e: EngineSwap) => e.legs.map((l) => [l.original.pick.pickId, l.original.source, l.swap?.pick.pickId ?? l.unchangedReason]);
  check("the Primary: the slip ML and a generated total", p.legs.map((l) => [l.pick.pickId, l.source]), [["bulls-ml", "SLIP"], ["over", "GENERATED"]]);
  check("Swap = Suggested: only the generated leg", view(p.contrarian.SUGGESTED), [["bulls-ml", "SLIP", "OUT_OF_SCOPE"], ["over", "GENERATED", "under"]]);
  check("Swap = Your picks: only the slip leg", view(p.contrarian.YOUR_PICKS), [["bulls-ml", "SLIP", "pacers-ml"], ["over", "GENERATED", "OUT_OF_SCOPE"]]);
  check("Swap = All: both", view(p.contrarian.ALL), [["bulls-ml", "SLIP", "pacers-ml"], ["over", "GENERATED", "under"]]);
}

// ---- Bet Types filter ---------------------------------------------------------------------
{
  const specs = [
    bulls,
    pacers,
    s({ id: "t-over", game: 1, category: "TD_PROP", betType: "PLAYER_PROP", detail: "Jayson Tatum Over 27.5 Points", line: 27.5, odds: -115, lg: [40, 20], propMarket: "POINTS" }),
    s({ id: "t-under", game: 1, category: "TD_PROP", betType: "PLAYER_PROP", detail: "Jayson Tatum Under 28 Points", line: 28, odds: -110, lg: [30, 15], propMarket: "POINTS" }),
    s({ id: "over", game: 1, category: "OVER", betType: "TOTAL", detail: "Over 220.5", line: 220.5, odds: -110, lg: [40, 20] }),
    s({ id: "under", game: 1, category: "UNDER", betType: "TOTAL", detail: "Under 221", line: 221, odds: -110, lg: [30, 18] }),
  ];
  const props = buildGeneratedParlay(snap(specs), { legCount: 2, maxLegsPerGame: 1, include: ["PROPS"], mix: null, fillFrom: "BEST_AVAILABLE" }, null, NOW);
  const swaps = props.contrarian.ALL.legs.flatMap((l) => (l.swap ? [l.swap.pick] : []));
  check("Props only: the parlay is props", props.legs.map((l) => betCategory(l.pick)), ["PROPS"]);
  check("Props only: only prop contrarians", [swaps.length > 0, swaps.every((p) => betCategory(p) === "PROPS")], [true, true]);
  const slipMl = buildGeneratedParlay(snap(specs, ["bulls-ml"]), { legCount: 1, maxLegsPerGame: 1, include: ["PROPS"], mix: null, fillFrom: "BEST_AVAILABLE" }, null, NOW);
  check("Props only: a slip ML finds no ML contrarian (the filter holds)", slipMl.contrarian.ALL.legs.find((l) => l.original.pick.pickId === "bulls-ml")?.unchangedReason, "NO_QUALIFYING_CONTRARIAN");
}

// ---- 200 Regenerate seeds per mode: no same-game conflict, ever -----------------------------------
{
  // Two games, several qualifying contrarians per leg: a swap that would clash with a sibling (two sides, two
  // game totals, the same prop twice, a game Under beside a scorer's Over) must never be drawn. The props are
  // NFL: the same-game rules read a prop without its sport, so an NBA prop can't be stacked on its game.
  const big: Spec[] = [
    s({ id: "b-ml", game: 0, category: "FAV_ML", betType: "MONEYLINE", detail: "Bulls ML", odds: -150, lg: [40, 20] }),
    s({ id: "p-ml-1", game: 0, category: "DOG_ML", betType: "MONEYLINE", detail: "Pacers ML", odds: 130, lg: [30, 20] }),
    s({ id: "p-ml-2", game: 0, category: "DOG_ML", betType: "MONEYLINE", detail: "Pacers ML", odds: 135, lg: [29, 20] }),
    s({ id: "b-over", game: 0, category: "OVER", betType: "TOTAL", detail: "Over 230.5", line: 230.5, odds: -110, lg: [40, 22] }),
    s({ id: "b-under-1", game: 0, category: "UNDER", betType: "TOTAL", detail: "Under 230.5", line: 230.5, odds: -110, lg: [30, 20] }),
    s({ id: "b-under-2", game: 0, category: "UNDER", betType: "TOTAL", detail: "Under 231", line: 231, odds: -110, lg: [31, 20] }),
    s({ id: "c-sp", game: 3, category: "SPREAD_MINUS", betType: "SPREAD", detail: "Chiefs -3", line: -3, odds: -110, lg: [40, 20] }),
    s({ id: "k-sp-1", game: 3, category: "SPREAD_PLUS", betType: "SPREAD", detail: "Chargers +3", line: 3, odds: -110, lg: [30, 20] }),
    s({ id: "k-sp-2", game: 3, category: "SPREAD_PLUS", betType: "SPREAD", detail: "Chargers +3.5", line: 3.5, odds: -110, lg: [31, 20] }),
    s({ id: "c-over", game: 3, category: "OVER", betType: "TOTAL", detail: "Over 47.5", line: 47.5, odds: -110, lg: [40, 22] }),
    s({ id: "c-under-1", game: 3, category: "UNDER", betType: "TOTAL", detail: "Under 47.5", line: 47.5, odds: -110, lg: [30, 20] }),
    s({ id: "c-under-2", game: 3, category: "UNDER", betType: "TOTAL", detail: "Under 48", line: 48, odds: -110, lg: [31, 20] }),
    s({ id: "c-prop", game: 3, category: "PASS_YDS_PROP", betType: "PLAYER_PROP", detail: "Patrick Mahomes Over 250.5 Passing Yards", line: 250.5, odds: -110, lg: [40, 20], propMarket: "PASS_YDS" }),
    s({ id: "c-prop-u-1", game: 3, category: "PASS_YDS_PROP", betType: "PLAYER_PROP", detail: "Patrick Mahomes Under 251.5 Passing Yards", line: 251.5, odds: -110, lg: [30, 18], propMarket: "PASS_YDS" }),
    s({ id: "c-prop-u-2", game: 3, category: "PASS_YDS_PROP", betType: "PLAYER_PROP", detail: "Patrick Mahomes Under 252.5 Passing Yards", line: 252.5, odds: -110, lg: [31, 18], propMarket: "PASS_YDS" }),
  ];
  const sn = snap(big, ["b-ml", "b-over"]);
  const settings: GeneratorSettings = { legCount: 5, maxLegsPerGame: 3, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE", minWinPct: 0 };
  const gen = buildGeneratedParlay(sn, settings, null, NOW);
  check("the conflict slate: 5 legs, 3 on the NFL game", [gen.legs.length, gen.legs.filter((l) => l.gameId === "g3").length], [5, 3]);
  check("...and Contrarian swaps on it", gen.contrarian.ALL.swapCount > 0, true);
  const guard = new TraceCollector({ mode: "STANDARD", trigger: "GENERATE", origin: "CLIENT", scoringVersion: "v", settings: {} }, false);
  buildGeneratedParlay(sn, settings, null, NOW, GENERATOR_RULES, guard);
  const blocked = (guard.finish().extras.swaps ?? []).find((m) => m.mode === "CONTRARIAN" && m.scope === "ALL")?.legs.reduce((n, l) => n + l.excluded.SAME_GAME_CONFLICT, 0) ?? 0;
  check("...where the sibling check really bites (candidates blocked by a same-game rule)", blocked > 0, true);
  const conflicts = (e: EngineSwap) => {
    const final = e.legs.map((l) => ({ gameId: l.original.gameId, pick: l.swap?.pick ?? l.original.pick, swapped: !!l.swap }));
    let n = 0;
    for (let i = 0; i < final.length; i++)
      for (let j = i + 1; j < final.length; j++) {
        const [a, b] = [final[i], final[j]];
        if (a.gameId === b.gameId && (a.swapped || b.swapped) && sameGameConflict(asCandidate(a.pick), asCandidate(b.pick)) !== null) n++;
      }
    return n;
  };
  for (const mode of SELECTION_MODES) {
    let violations = 0;
    let swapped = 0;
    const alts = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) {
      const p = buildGeneratedParlay(sn, settings, { seed, history: [], mode }, NOW);
      for (const scope of ["SUGGESTED", "YOUR_PICKS", "ALL"] as const) violations += conflicts(p.contrarian[scope]);
      swapped += p.contrarian.ALL.swapCount;
      for (const l of p.contrarian.ALL.legs) if (l.swap) alts.add(l.swap.pick.pickId);
    }
    check(`Regenerate ${mode}, seeds 1..200, every Swap setting: zero same-game conflict violations`, violations, 0);
    check(`Regenerate ${mode}: swaps happened (${swapped}) across ${alts.size} alternates`, swapped > 0, true);
  }
}

// ---- Run log -----------------------------------------------------------------------------
{
  const sn = snap([...crowd, s({ id: "pacers-far", game: 0, category: "SPREAD_PLUS", betType: "SPREAD", detail: "Pacers +9", line: 9, odds: -110, lg: [30, 15] })], ["bulls-ml"]);
  const trace = new TraceCollector({ mode: "YOUR_PICKS", trigger: "REGENERATE", origin: "CLIENT", scoringVersion: standardScoringVersion(GENERATOR_RULES), settings: {} }, true);
  const p = buildGeneratedParlay(sn, one, { seed: 11, history: [], mode: "DIVERSIFIED" }, NOW, GENERATOR_RULES, trace);
  const out = trace.finish();
  const leg = out.extras.swaps?.find((m) => m.mode === "CONTRARIAN" && m.scope === "ALL")?.legs[0];
  check("the leg's trace: opposite 3, qualifying 3, the one chosen", [leg?.result, leg?.contrarian?.opposite, leg?.contrarian?.qualifying, leg?.contrarian?.chosen], ["SWAPPED", 3, 3, p.contrarian.ALL.legs[0].swap?.pick.pickId]);
  check("...paired / qualified count same-bet matches, not the classifier's R2", [leg?.paired, leg?.qualified], [3, 3]);
  check("the selection trace lists Contrarian's draw", out.extras.selection?.contrarian?.length, 1);
  const clean = sanitizeClientTrace(JSON.parse(JSON.stringify(out)));
  check("the intake keeps the contrarian block", clean?.extras.swaps?.find((m) => m.mode === "CONTRARIAN" && m.scope === "ALL")?.legs[0].contrarian, leg?.contrarian);
  check("the intake keeps the selection trace's contrarian picks", clean?.extras.selection?.contrarian?.length, 1);
  const missTrace = new TraceCollector({ mode: "YOUR_PICKS", trigger: "GENERATE", origin: "CLIENT", scoringVersion: "v", settings: {} }, true);
  buildGeneratedParlay(snap([bulls, { ...pacers, lg: [10, 30] }], ["bulls-ml"]), one, null, NOW, GENERATOR_RULES, missTrace);
  const miss = missTrace.finish().extras.swaps?.find((m) => m.mode === "CONTRARIAN" && m.scope === "ALL")?.legs[0];
  check("a miss is logged NO_QUALIFYING_CONTRARIAN with why (opposite 1, below gate 1)", [miss?.result, miss?.contrarian?.opposite, miss?.contrarian?.belowGate], ["NO_QUALIFYING_CONTRARIAN", 1, 1]);
  const version = standardScoringVersion(GENERATOR_RULES);
  check("scoringVersion names the contrarian model and fits 80", [version.endsWith("/sel-v1/contra-samebet-v1"), version.length <= 80], [true, true]);
}

console.log(failures > 0 ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
if (failures > 0) process.exit(1);
