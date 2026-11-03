// How the engine reads scoring.ts: the gate's -110 threshold, Hedge and Contrarian on scores (PR 7), slip
// ranking, the selection scale, the trimmed rates, the run log and its intake, and Hybrid's snapshot call.
// Pure - no DB.
//   npx tsx src/lib/parlay/scoring-wiring-acceptance-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GeneratorPick } from "@/lib/parlay/auto-generate";
import { buildGeneratedParlay, GENERATOR_RULES, WILSON_RULES, type GeneratorSettings } from "@/lib/parlay/generator";
import { reconcileTrace, scoringVersionOf, standardScoringVersion, TraceCollector } from "@/lib/parlay/run-trace";
import { sanitizeClientTrace } from "@/lib/parlay/run-trace-validate";
import { noPlatformRates } from "@/lib/parlay/run-view";
import { recordForGate } from "@/lib/parlay/pick-record";
import { buildPlatformRates, compareScores, DEFAULT_BREAK_EVEN, EMPTY_PLATFORM_RATES, gateCheck, passesGate, scorePick, selectionScore, shrink, trimPlatformRates, type ScoringContext } from "@/lib/parlay/scoring";
import { buildSnapshot, NOW, pickOf, RATE_ROWS, SPECS } from "@/lib/parlay/scoring-switch-fixture";

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
};
const BASE: GeneratorSettings = { legCount: 6, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE" };
const ids = (legs: { pick: { pickId: string } }[]) => legs.map((l) => l.pick.pickId);
const ctxOf = (snap = buildSnapshot(), minWinPct = 55): ScoringContext => ({
  leagueRecords: snap.leagueRecords,
  categoryRecords: snap.categoryRecords,
  propMarketRecords: snap.propMarketRecords,
  platformRates: snap.platformRates ?? EMPTY_PLATFORM_RATES,
  minWinPct,
});

// ---- The -110 threshold ------------------------------------------------------
{
  const shrunk = [0.4, 0.5, 0.52, 0.5499999, 0.55, 0.5500001, 0.6, 0.65, 0.7, 0.75, 0.8];
  const gates = [5, 10, 25, 50, 55, 60, 65, 70, 75];
  const bad = gates.flatMap((L) => shrunk.filter((p) => gateCheck(p, DEFAULT_BREAK_EVEN, L).passes !== p * 100 >= L));
  check("at the -110 break-even the gate is exactly shrunk >= L, every lever", bad, []);
  check("L = 0 is no gate", [gateCheck(0.01, DEFAULT_BREAK_EVEN, 0).passes, gateCheck(0.01, DEFAULT_BREAK_EVEN, 0).requiredEdge], [true, null]);
  check("the required edge is L minus the -110 break-even", gateCheck(0.6, DEFAULT_BREAK_EVEN, 55).requiredEdge, 0.55 - DEFAULT_BREAK_EVEN);
}

// ---- Gate at -110: threshold only (not the old pass list) ---------------------
{
  const snap = buildSnapshot();
  const parlay = buildGeneratedParlay(snap, { ...BASE, legCount: 6 }, null, NOW);
  const old = buildGeneratedParlay(snap, { ...BASE, legCount: 6 }, null, NOW, WILSON_RULES);
  const score = (id: string) => scorePick(pickOf(SPECS.find((s) => s.id === id)!), ctxOf(snap));
  check("6-4 at -110: raw 60% passed, shrunk fails", passesGate(score("g0-small-spread"), 55), false);
  check("55-45 at -110: raw 55.0 passed, shrunk fails", passesGate(score("g1-55-45"), 55), false);
  check("a 50% capper with history and a pick at +200 passes on edge", passesGate(score("g1-longshot"), 55), true);
  const thin = scorePick(pickOf({ ...SPECS.find((s) => s.id === "g3-thin")!, category: "FAV_ML", betType: "MONEYLINE", detail: "Lions ML", line: undefined }), { ...ctxOf(snap), leagueRecords: { ...snap.leagueRecords, records: { ...snap.leagueRecords.records, "c-g3-thin|NFL|FAV_ML": { category: "FAV_ML", label: "FAV_ML", overall: { wins: 3, losses: 1, pushes: 0, winPct: 75, count: 4 }, league: { wins: 3, losses: 1, pushes: 0, winPct: 75, count: 4 } } } } });
  check("thin at a real -110 in a category priced above -110: the platform yardstick binds", thin.status === "SCORED" && thin.thin?.binding, "platform");
  check("the fixture shows both engines differ", JSON.stringify(ids(parlay.legs)) !== JSON.stringify(ids(old.legs)), true);
}

// ---- A record for the display <=> a score ----------------------------------
{
  const snap = buildSnapshot();
  const mismatched = SPECS.map((s) => pickOf(s)).filter((p) => (recordForGate(p, snap.leagueRecords, snap.categoryRecords, undefined, snap.propMarketRecords) !== null) !== (scorePick(p, ctxOf(snap)).status === "SCORED"));
  check("a pick has a shown record exactly when it has a score", mismatched.map((p) => p.pickId), []);
  const noPairs = { ...snap, categoryRecords: {} };
  const parlayA = buildGeneratedParlay(snap, BASE, null, NOW);
  const parlayB = buildGeneratedParlay(noPairs, BASE, null, NOW);
  check("dropping categoryPairs changes nothing: a card already holds that record", JSON.stringify(parlayA), JSON.stringify(parlayB));
}

// ---- Engine: legs ---------------------------------------------------------------
{
  const snap = buildSnapshot();
  const p = buildGeneratedParlay(snap, BASE, null, NOW);
  check("Generate is deterministic", JSON.stringify(buildGeneratedParlay(snap, BASE, null, NOW)), JSON.stringify(p));
  const scoresOk = p.legs.every((l) => {
    const s = scorePick(l.pick, ctxOf(snap));
    return passesGate(s, 55) && s.status === "SCORED" && l.score === s.rankScore * 100;
  });
  check("every generated leg passes the gate and carries its edge in points (selection.ts reads it, no -110 shim)", scoresOk, true);
  check("a leg still shows the record recordForGate reads", p.legs.every((l) => l.record !== null && l.basis !== null), true);
  check("no gate still leaves out a pick with no record", buildGeneratedParlay(snap, { ...BASE, minWinPct: 0, legCount: 25, maxLegsPerGame: 5 }, null, NOW).legs.some((l) => l.pick.pickId === "g4-no-record"), false);
  const empty = buildSnapshot(undefined, [], []);
  const onDefaults = scorePick(pickOf(SPECS.find((s) => s.id === "g3-no-price")!), ctxOf(empty));
  check("an empty rates table scores on the defaults", onDefaults.status === "SCORED" && onDefaults.levels.platform.tier, "DEFAULT");
  check("an engine with an absent rates field still builds", buildGeneratedParlay({ ...snap, platformRates: undefined, platformRateRows: undefined }, BASE, null, NOW).legs.length > 0, true);
}

// ---- selectionScore (the -110 equivalent): nothing in selection reads it any more (PR 5); kept until PR 9 ----
{
  const snap = buildSnapshot();
  const scale = selectionScore({ rankScore: -2 } as never);
  check("selectionScore never goes negative (Wilson^8 would turn it positive)", scale, 0);
  const s = scorePick(pickOf(SPECS.find((x) => x.id === "g0-elite-spread")!), ctxOf(snap));
  check("it is rankScore plus the -110 break-even", s.status === "SCORED" && selectionScore(s) === s.rankScore + DEFAULT_BREAK_EVEN, true);
  const history = [ids(buildGeneratedParlay(snap, { ...BASE, legCount: 3 }, null, NOW).legs)];
  const draws = [1, 2, 3, 4, 5, 6].map((seed) => buildGeneratedParlay(snap, { ...BASE, legCount: 3 }, { seed, history }, NOW));
  check("Regenerate still varies", draws.some((d) => d.variety === "VARIED"), true);
  check("Regenerate never draws outside the gate", draws.every((d) => d.legs.every((l) => passesGate(scorePick(l.pick, ctxOf(snap)), 55))), true);
  const subset = buildSnapshot(undefined, ["g1-55-45", "g2-heavy-fav", "g3-thin", "g0-small-spread", "g5-away", "g4-no-record"]);
  const your: GeneratorSettings = { ...BASE, legCount: 2, fillFrom: "YOUR_PICKS_ONLY" };
  const g = buildGeneratedParlay(subset, your, null, NOW);
  check("Your picks only, Generate: the two strongest by score", ids(g.legs).sort(), ["g2-heavy-fav", "g5-away"].sort());
  const seen = new Set<string>();
  for (let seed = 1; seed <= 40; seed++) for (const l of buildGeneratedParlay(subset, your, { seed, history: [] }, NOW).legs) seen.add(l.pick.pickId);
  check("Your picks only, Regenerate: scored picks all appear", ["g1-55-45", "g2-heavy-fav", "g3-thin", "g0-small-spread", "g5-away"].every((id) => seen.has(id)), true);
}

// ---- Slip ranking -------------------------------------------------------------
{
  // Two slip picks that can't both be legs: the better score stays, whatever the raw win %.
  const heavy = { id: "s-heavy", game: 0, category: "FAV_ML" as const, betType: "MONEYLINE", detail: "Chiefs ML", odds: -2000, source: "MARKET" as const, lg: [9, 1] as [number, number], hist: -110 };
  const fair = { id: "s-fair", game: 0, category: "DOG_ML" as const, betType: "MONEYLINE", detail: "Chargers ML", odds: -110, source: "STATED" as const, lg: [13, 7] as [number, number], hist: -110 };
  const snap = buildSnapshot([heavy, fair], ["s-heavy", "s-fair"]);
  const scored = buildGeneratedParlay(snap, { ...BASE, legCount: 2, maxLegsPerGame: 2 }, null, NOW);
  const old = buildGeneratedParlay(snap, { ...BASE, legCount: 2, maxLegsPerGame: 2 }, null, NOW, WILSON_RULES);
  check("opposing slip picks: old keeps the better win %", ids(old.legs), ["s-heavy"]);
  check("opposing slip picks: scoring keeps the better edge", ids(scored.legs), ["s-fair"]);
  check("the loser is named in dropped", scored.dropped.map((d) => [d.pickId, d.reason, d.against?.pickId]), [["s-heavy", "opposes", "s-fair"]]);
  const noRec = { ...fair, id: "s-none", lg: [0, 0] as [number, number], hist: null };
  const withNone = buildSnapshot([heavy, noRec], ["s-heavy", "s-none"]);
  const r = buildGeneratedParlay(withNone, { ...BASE, legCount: 2, maxLegsPerGame: 2 }, null, NOW);
  check("a slip pick with no record ranks below any score", ids(r.legs), ["s-heavy"]);
  const gated = buildGeneratedParlay(buildSnapshot([fair], ["s-fair"]), { ...BASE, legCount: 1, minWinPct: 75 }, null, NOW);
  check("slip picks are never gated", ids(gated.legs), ["s-fair"]);
}

// ---- Hedge and Contrarian score (Contrarian since PR 7; WILSON_RULES keeps the old path) ----
{
  const snap = buildSnapshot();
  const settings = { ...BASE, legCount: 1 };
  const scored = buildGeneratedParlay(snap, settings, null, NOW);
  const old = buildGeneratedParlay(snap, settings, null, NOW, WILSON_RULES);
  check("the same primary on both engines (the comparison below needs it)", ids(scored.legs), ids(old.legs));
  // A slate where the two engines would pick different alternates, so "the same" can't pass by accident. Primary:
  // Nuggets -5 on both. On the other side: the best Wilson (40-25, no real price), the best score (22-12 at -105),
  // a raw 55.0 the scored gate refuses, and a 50% at +150 only the scored gate admits.
  const home = SPECS.find((s) => s.id === "g5-home")!;
  const side = (id: string, detail: string, line: number, odds: number, source: "STATED" | "MARKET" | "DEFAULTED", lg: [number, number], hist: number | null) =>
    ({ id, game: 5, category: "SPREAD_PLUS" as const, betType: "SPREAD", detail, line, odds, source, lg, hist });
  const opposing = [
    side("c-best-wilson", "Suns +5.5", 5.5, -110, "DEFAULTED", [40, 25], null),
    side("c-best-score", "Suns +5", 5, -105, "MARKET", [22, 12], -105),
    side("c-raw-only", "Suns +4.5", 4.5, -110, "STATED", [55, 45], -110),
    side("c-score-only", "Suns +6", 6, 150, "MARKET", [10, 10], 150),
  ];
  const cSnap = buildSnapshot([home, ...opposing]);
  const cScored = buildGeneratedParlay(cSnap, { ...BASE, legCount: 1 }, null, NOW);
  const cOld = buildGeneratedParlay(cSnap, { ...BASE, legCount: 1 }, null, NOW, WILSON_RULES);
  check("Contrarian slate: the same primary on both engines", [ids(cScored.legs), ids(cOld.legs)], [["g5-home"], ["g5-home"]]);
  // Every opposite pick is Suns at +4.5..+6 against Nuggets -5: within the NBA spread tolerance (1 point), so all four
  // are the other side of the same bet and only the score decides.
  check("Contrarian (SCORING): the best score on the other side of the bet", cScored.contrarian.ALL.legs[0].swap?.pick.pickId, "c-best-score");
  check("...as a SAME_BET swap with its market and line gap", [cScored.contrarian.ALL.legs[0].swap?.rule, cScored.contrarian.ALL.legs[0].swap?.contrarian], ["SAME_BET", { market: "SPREAD", lineGap: 0 }]);
  check("Contrarian (WILSON_RULES rollback): still the best Wilson", cOld.contrarian.ALL.legs[0].swap?.pick.pickId, "c-best-wilson");
  const scoreRanked = opposing.map((s) => pickOf(s)).map((p) => scorePick(p, ctxOf(cSnap))).filter((s) => passesGate(s, 55)).sort(compareScores).map((s) => s.pickId);
  check("...which is not what the scores would pick: the slate tells the engines apart", scoreRanked[0], "c-best-score");
  check("...and the scored gate would have refused the raw-only pick and admitted the score-only one", [scoreRanked.includes("c-raw-only"), scoreRanked.includes("c-score-only")], [false, true]);
  const rawSnap = buildSnapshot([home, opposing[2]]);
  const cRawGate = buildGeneratedParlay(rawSnap, { ...BASE, legCount: 1 }, null, NOW);
  check("Contrarian refuses a raw 55.0 the scored gate refuses", [cRawGate.contrarian.ALL.legs[0].swap, cRawGate.contrarian.ALL.legs[0].unchangedReason], [null, "NO_QUALIFYING_CONTRARIAN"]);
  check("...which WILSON_RULES still takes", buildGeneratedParlay(rawSnap, { ...BASE, legCount: 1 }, null, NOW, WILSON_RULES).contrarian.ALL.legs[0].swap?.pick.pickId, "c-raw-only");
  const noRawSnap = buildSnapshot([home, opposing[3]]);
  const cNoRaw = buildGeneratedParlay(noRawSnap, { ...BASE, legCount: 1 }, null, NOW);
  check("Contrarian takes a raw 50% at +150 the scored gate admits", cNoRaw.contrarian.ALL.legs[0].swap?.pick.pickId, "c-score-only");
  check("...which WILSON_RULES still refuses", buildGeneratedParlay(noRawSnap, { ...BASE, legCount: 1 }, null, NOW, WILSON_RULES).contrarian.ALL.legs[0].swap, null);
  // Game 0 hedges to a total: 14-2 no-source -110 and 60-40 stated -110.
  const hedgeOf = (p: typeof scored) => p.hedge.ALL.legs[0].swap?.pick.pickId ?? null;
  check("Hedge reads scores: the alternate passes the gate", (() => {
    const id = hedgeOf(scored);
    const pick = id ? snap.games.flatMap((g) => g.picks).find((x: GeneratorPick) => x.pickId === id)! : null;
    return pick ? passesGate(scorePick(pick, ctxOf(snap)), 55) : null;
  })(), true);
  const raised = buildSnapshot();
  const strict = buildGeneratedParlay(raised, { ...BASE, legCount: 6, minWinPct: 65 }, null, NOW);
  check("Hedge honours the lever on the score", strict.hedge.ALL.legs.every((l) => !l.swap || passesGate(scorePick(l.swap.pick, ctxOf(raised, 65)), 65)), true);
  check("Contrarian honours the lever on the score", strict.contrarian.ALL.legs.every((l) => !l.swap || passesGate(scorePick(l.swap.pick, ctxOf(raised, 65)), 65)), true);
}

// ---- Trimmed rates ----------------------------------------------------------------
{
  const whole = buildPlatformRates(RATE_ROWS);
  const picks = SPECS.map((s) => pickOf(s));
  const trimmed = trimPlatformRates(whole, picks);
  const snap = buildSnapshot();
  const same = picks.filter((p) => JSON.stringify(scorePick(p, { ...ctxOf(snap), platformRates: whole })) !== JSON.stringify(scorePick(p, { ...ctxOf(snap), platformRates: trimmed })));
  check("a pick scores the same on trimmed rates as on the whole table", same.map((p) => p.pickId), []);
  const one = trimPlatformRates(whole, [pickOf(SPECS[0])]);
  check("trimming keeps only what the picks can ask for", [Object.keys(one.byKey), Object.keys(one.byLeagueBetType), Object.keys(one.byBetType)], [["NFL|SPREAD_MINUS"], ["NFL|SPREAD"], ["SPREAD"]]);
  check("the shrink levels read as specified: k = 20 toward the platform", shrink(0, 0, 0.52), 0.52);
}

// ---- Run log -----------------------------------------------------------------------
{
  const snap = buildSnapshot();
  const meta = { mode: "STANDARD" as const, trigger: "GENERATE" as const, origin: "CLIENT" as const, scoringVersion: standardScoringVersion(GENERATOR_RULES), settings: {} };
  const trace = new TraceCollector(meta, true);
  const traced = buildGeneratedParlay(snap, BASE, null, NOW, GENERATOR_RULES, trace);
  const plain = buildGeneratedParlay(snap, BASE, null, NOW, GENERATOR_RULES);
  const t = trace.finish();
  check("the same parlay with or without a collector", JSON.stringify(traced), JSON.stringify(plain));
  check("the funnel reconciles", [reconcileTrace(t), t.failed], [[], false]);
  const version = standardScoringVersion(GENERATOR_RULES);
  check("the new version string (selection layer sel-v1, Contrarian same-bet model)", version, "standard/hier-k20-logit-edge-min5-ls1-v2/sel-v1/contra-samebet-v1");
  check("it fits the intake's 80 characters", version.length <= 80, true);
  check("Hybrid's version string is unchanged", scoringVersionOf(GENERATOR_RULES, true), "hybrid/LEAGUE_FIRST/z1.5/no-headcount/prop-market-records");
  check("every full version string fits 80: Standard 65, Hybrid 57", [version.length, scoringVersionOf(GENERATOR_RULES, true).length], [65, 57]);
  const s = t.extras.scoring!;
  check("extras.scoring holds the rate row count", s.platformRows, RATE_ROWS.length);
  const legRoles = s.legs.filter((l) => l.role !== "HEDGE").map((l) => l.id);
  check("one entry per leg", legRoles, ids(traced.legs));
  check("one entry per Hedge alternate", s.legs.filter((l) => l.role === "HEDGE").map((l) => l.id), traced.hedge.ALL.legs.flatMap((l) => (l.swap ? [l.swap.pick.pickId] : [])));
  const first = s.legs[0];
  check("each entry names model, level, tier, price and gate", [typeof first.model, typeof first.level, typeof first.tier, typeof first.shrunkWin, typeof first.edge, typeof first.price, typeof first.gatePass], ["string", "string", "string", "number", "number", "string", "boolean"]);
  check("WILSON_RULES writes no scoring block", (() => {
    const w = new TraceCollector(meta, true);
    buildGeneratedParlay(snap, BASE, null, NOW, WILSON_RULES, w);
    return w.finish().extras.scoring;
  })(), undefined);

  // The intake rebuilds a browser's trace from a schema.
  const clean = sanitizeClientTrace(JSON.parse(JSON.stringify(t)))!;
  check("the intake keeps extras.scoring", JSON.stringify(clean.extras.scoring), JSON.stringify(s));
  check("the intake keeps the whole version string", clean.scoringVersion, version);
  const hostile = sanitizeClientTrace({
    ...JSON.parse(JSON.stringify(t)),
    extras: {
      scoring: {
        platformRows: 3,
        extra: "x",
        legs: [
          { id: "a", role: "GENERATED", model: "EDGE", edge: 0.1, price: "REAL", junk: { deep: 1 } },
          { id: "b", role: "BOSS", model: "EDGE" },
          { id: "c", role: "HEDGE", model: "NO_RECORD", edge: 0.5 },
          { id: "d", role: "SLIP", model: "WIN_RATE", edge: "1; drop table", price: "<b>", shrunkWin: 1e9 },
          ...Array.from({ length: 80 }, (_, i) => ({ id: "n" + i, role: "SLIP", model: "NO_RECORD" })),
        ],
      },
    },
  })!;
  const hs = hostile.extras.scoring!;
  check("the intake drops unknown fields and bad rows", hs.legs.slice(0, 3), [{ id: "a", role: "GENERATED", model: "EDGE", edge: 0.1, price: "REAL" }, { id: "c", role: "HEDGE", model: "NO_RECORD" }, { id: "d", role: "SLIP", model: "WIN_RATE" }]);
  check("the intake caps the legs", hs.legs.length <= 50, true);
  check("the intake drops a scoring block with no row count", sanitizeClientTrace({ ...JSON.parse(JSON.stringify(t)), extras: { scoring: { legs: [] } } })!.extras.scoring, undefined);
  check("no gate survives the intake as null", sanitizeClientTrace({ ...JSON.parse(JSON.stringify(t)), extras: { scoring: { platformRows: 1, legs: [{ id: "z", role: "SLIP", model: "EDGE", requiredEdge: null }] } } })!.extras.scoring!.legs[0].requiredEdge, null);

  const emptyTrace = new TraceCollector(meta, true);
  buildGeneratedParlay(buildSnapshot(undefined, [], []), BASE, null, NOW, GENERATOR_RULES, emptyTrace);
  const e = emptyTrace.finish();
  check("an empty table logs 0 rows", e.extras.scoring!.platformRows, 0);
  check("the admin view flags it", noPlatformRates({ extras: e.extras as never }), true);
  check("the admin view doesn't flag rows, or a run from before scoring", [noPlatformRates({ extras: t.extras as never }), noPlatformRates({ extras: {} as never }), noPlatformRates({ extras: null })], [false, false, false]);
}

// ---- Who asks for scoring ----------------------------------------------------------
{
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  check("Standard's action asks the loader for scoring", read("src/server/actions/parlay-generate.ts").includes("{ scoring: true }"), true);
  const hybrid = read("src/server/actions/parlay-hybrid.ts");
  check("Hybrid's action doesn't", [hybrid.includes("scoring: true"), hybrid.includes("loadGeneratorSnapshot(user.id, scope, now, trace)")], [false, true]);
  const consensus = read("src/lib/parlay/consensus.ts");
  check("Consensus doesn't import scoring.ts", consensus.includes("parlay/scoring"), false);
  const list = read("src/server/data/generator-runs-view.ts");
  check("the admin list query leaves the per-leg rows out", (list.match(/#- '\{scoring,legs\}'/g) ?? []).length, 2);
  check("...and selection's per-leg rows (PR 5)", [(list.match(/#- '\{selection,legs\}'/g) ?? []).length, (list.match(/#- '\{selection,hedge\}'/g) ?? []).length], [2, 2]);
}

console.log(failures > 0 ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures > 0 ? 1 : 0);
