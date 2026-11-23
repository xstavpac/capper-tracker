// Parlay Generator variety: Generate draws (a fresh seed per click, the mode's beta, no exposure
// penalty), Regenerate weighs down every bet and game this result card has shown (count-based, in
// memory), and the run log says how each build varied. Pure - no DB. Fixed seeds throughout.
//   npx tsx src/lib/parlay/generator-variety-acceptance-test.ts
//
//   1. The fixture pools (variety-pools.ts: (a) game-bound 12 games / 12 legs; (b) 17 / 14; (c) 16 / 12;
//      (d) 41 picks / 16 games / 12 legs; (e) 16 / 8; Max legs per game 1, scores on the measured prod
//      curve): Generate + 10 Regenerates per mode on 5 cards, and 10 independent Generates, against the
//      numbers origin/main gave (BEFORE, eb31d89 - scripts/variety-harness/measure.ts).
//   2. Generate: the request's draw is checked; slip picks are in every draw; never shorter than the
//      rank order; Your picks only's subset stays the strongest.
//   3. Exposure: card-scoped (reset by Generate), a slip pick's game is never weighed down, the game
//      identity is the server's (sport + teams either way + Eastern date + game number).
//   4. The run log: how each build varied (outcome), through sanitizeClientTrace.
import { buildGeneratedParlay, generateVariation, historyGameKeysOf, parseGenerateDraw, type GeneratorSettings, type GeneratorSnapshot } from "@/lib/parlay/generator";
import { createGeneratorSession, type GenerateCall } from "@/lib/parlay/generator-session";
import { gameExposureKey, type SelectionTrace } from "@/lib/parlay/selection";
import { sanitizeClientTrace } from "@/lib/parlay/run-trace-validate";
import type { RunTrace } from "@/lib/parlay/run-trace";
import { MLB_TEAMS, makePool, NOW, POOLS, settingsFor } from "@/lib/parlay/__fixtures__/variety-pools";
import { ids, measure, varietyTable, type Mode, type VarietyRow } from "@/lib/parlay/__fixtures__/variety-measure";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

// origin/main (eb31d89), same harness: Regenerate's mean share of legs the same as the parlay before
// it and its mean leg score, per pool and mode. Generate was the rank order every time (100% shared).
const BEFORE: Record<string, Record<Mode, { same: number; score: number }>> = {
  a: { BEST: { same: 0.63, score: 62.16 }, DIVERSIFIED: { same: 0.48, score: 61.56 }, EXPLORE: { same: 0.44, score: 61.06 } },
  b: { BEST: { same: 0.72, score: 62.87 }, DIVERSIFIED: { same: 0.42, score: 61.74 }, EXPLORE: { same: 0.26, score: 60.26 } },
  c: { BEST: { same: 0.61, score: 62.12 }, DIVERSIFIED: { same: 0.34, score: 61.22 }, EXPLORE: { same: 0.23, score: 59.96 } },
  d: { BEST: { same: 0.69, score: 63.37 }, DIVERSIFIED: { same: 0.44, score: 62.31 }, EXPLORE: { same: 0.26, score: 60.61 } },
  e: { BEST: { same: 0.65, score: 65.05 }, DIVERSIFIED: { same: 0.35, score: 63.27 }, EXPLORE: { same: 0.15, score: 60.91 } },
};
const r2 = (x: number) => Math.round(x * 100) / 100;

// ============================================================================
// 1. The fixture pools, before vs after
// ============================================================================
async function pools() {
  for (const spec of POOLS) {
    const m = await measure(spec);
    console.log("\n" + varietyTable(m) + "\n");
    const key = spec.name[0];
    const row = (mode: Mode) => m.rows.find((r) => r.mode === mode)!;
    const [best, div, exp] = (["BEST", "DIVERSIFIED", "EXPLORE"] as const).map(row) as [VarietyRow, VarietyRow, VarietyRow];
    const was = BEFORE[key];
    const L = `(${spec.name})`;

    // Generate varies; Best stays closest to the top parlay, at almost no cost.
    check(`${L} Generate: Best shares >= 80% with the top parlay`, best.genTop >= 0.8, true);
    check(`${L} Generate: closeness to the top parlay Best > Diversified > Explore`, best.genTop > div.genTop && div.genTop > exp.genTop, true);
    check(`${L} Generate: first parlays differ across clicks (pairs share <= 70% Diversified, <= 55% Explore)`, [div.genPair <= 0.7, exp.genPair <= 0.55], [true, true]);
    check(`${L} Generate: mean leg score within 0.5 of the top parlay (Best), 2.0 (Diversified)`, [m.topScore - best.genScore <= 0.5, m.topScore - div.genScore <= 2.0], [true, true]);
    check(`${L} Regenerate: never NO_ALTERNATIVE`, m.rows.map((r) => r.noAlt), [0, 0, 0]);

    if (key === "a") {
      // Game-bound: every game is in every parlay, so only the leg within a game can change - the
      // structural ceiling. Reported; it must not get worse.
      check(`${L} game-bound: every parlay uses every game`, m.rows.map((r) => r.regenGamesSame), [1, 1, 1]);
      check(`${L} game-bound: Regenerate no stickier than before (Diversified)`, div.regenSame <= was.DIVERSIFIED.same + 0.05, true);
      continue;
    }
    // More games than legs: overlap drops, games rotate, the quality cost stays modest.
    check(`${L} Regenerate: Diversified overlap down >= 5 points (${r2(was.DIVERSIFIED.same)} -> ${r2(div.regenSame)})`, div.regenSame <= was.DIVERSIFIED.same - 0.05, true);
    check(`${L} Regenerate: Best overlap down (${r2(was.BEST.same)} -> ${r2(best.regenSame)})`, best.regenSame < was.BEST.same, true);
    check(`${L} Regenerate: Explore no stickier (it was near the random floor already: ${r2(was.EXPLORE.same)} -> ${r2(exp.regenSame)})`, exp.regenSame <= was.EXPLORE.same + 0.02, true);
    check(`${L} Regenerate: overlap Best > Diversified > Explore`, best.regenSame > div.regenSame && div.regenSame > exp.regenSame, true);
    // A uniform random choice of `legs` of `games` games shares legs/games of them with the last parlay.
    const randomGames = spec.legs / spec.games;
    check(`${L} Regenerate: Diversified's games rotate at least as much as a random choice of games (+6 points)`, div.regenGamesSame <= randomGames + 0.06, true);
    check(`${L} Regenerate: every game is used on a card (Diversified, Explore)`, [div.regenDistinctGames, exp.regenDistinctGames], [spec.games, spec.games]);
    check(
      `${L} Regenerate: mean leg score down at most 0.6 (Best) / 2.0 (Diversified) / 1.0 (Explore) from before`,
      [was.BEST.score - best.regenScore <= 0.6, was.DIVERSIFIED.score - div.regenScore <= 2.0, was.EXPLORE.score - exp.regenScore <= 1.0],
      [true, true, true]
    );
    if (key === "e") check(`${L} near-disjoint: a Regenerate shares at most 1 of 8 legs with the parlay before it (Diversified, Explore)`, [div.regenMinSame <= 0.125, exp.regenMinSame <= 0.125], [true, true]);
  }
}

// ============================================================================
// 2. Generate
// ============================================================================
function generate() {
  // The request's draw: whole seeds in uint32, known modes; anything else is the rank order.
  check("parseGenerateDraw: a valid draw", parseGenerateDraw({ seed: 4294967295, mode: "EXPLORE" }), { seed: 4294967295, mode: "EXPLORE" });
  check(
    "parseGenerateDraw: bad seeds, modes and shapes are null",
    [{ seed: -1, mode: "BEST" }, { seed: 1.5, mode: "BEST" }, { seed: 2 ** 32, mode: "BEST" }, { seed: "1", mode: "BEST" }, { seed: 1, mode: "LOUD" }, { seed: 1 }, null, "x", 7].map(parseGenerateDraw),
    [null, null, null, null, null, null, null, null, null]
  );

  // Slip picks are in every draw, the same ones; a draw is never shorter than the rank order.
  const spec = POOLS[4];
  const base = makePool(spec);
  const all = base.games.flatMap((g) => g.picks);
  const slip = [all.find((p) => p.gameId === "G0")!, all.find((p) => p.gameId === "G5")!];
  const snap: GeneratorSnapshot = { ...base, slipPicks: slip };
  const settings: GeneratorSettings = { ...settingsFor(spec), maxLegsPerGame: 2 };
  const top = buildGeneratedParlay(snap, settings, null, NOW);
  const slipEvery: boolean[] = [];
  const lengths = new Set<number>();
  const firsts = new Set<string>();
  for (let seed = 1; seed <= 40; seed++) {
    for (const mode of ["BEST", "DIVERSIFIED", "EXPLORE"] as const) {
      const p = buildGeneratedParlay(snap, settings, generateVariation({ seed, mode }), NOW);
      slipEvery.push(slip.every((s) => p.legs.some((l) => l.source === "SLIP" && l.pick.pickId === s.pickId)));
      lengths.add(p.legs.length);
      firsts.add(p.generatedKey);
    }
  }
  check("Generate draws: both slip picks in every one", slipEvery.every(Boolean), true);
  check("Generate draws: always the rank order's length", [...lengths], [top.legs.length]);
  check("Generate draws: they vary", firsts.size > 10, true);

  // Your picks only with more picks than Total legs: Generate stays the strongest subset, whatever the seed.
  const ypoSnap: GeneratorSnapshot = { ...base, slipPicks: all.filter((p) => p.pickId.endsWith("-HML")).slice(0, 10) };
  const ypo: GeneratorSettings = { ...settingsFor(spec), legCount: 4, fillFrom: "YOUR_PICKS_ONLY" };
  const strongest = buildGeneratedParlay(ypoSnap, ypo, null, NOW).generatedKey;
  const ypoKeys = new Set([1, 2, 3, 4, 5].map((seed) => buildGeneratedParlay(ypoSnap, ypo, generateVariation({ seed, mode: "EXPLORE" }), NOW).generatedKey));
  check("Your picks only: Generate is the strongest subset for every seed", [...ypoKeys], [strongest]);
}

// ============================================================================
// 3. Exposure
// ============================================================================
async function exposure() {
  check(
    "game identity: either team order, case and spacing alike",
    gameExposureKey({ leagueName: "NBA", homeTeam: "Boston Celtics", awayTeam: " new york knicks", gameTime: "2099-01-02T00:30:00.000Z" }),
    gameExposureKey({ leagueName: "NBA", homeTeam: "New York Knicks", awayTeam: "boston celtics ", gameTime: "2099-01-02T00:30:00.000Z" })
  );
  check(
    "game identity: the Eastern date (7:30 PM ET on Jan 1 is Jan 2 in UTC) and the game number",
    [
      gameExposureKey({ leagueName: "NBA", homeTeam: "A", awayTeam: "B", gameTime: "2099-01-02T00:30:00.000Z" }),
      gameExposureKey({ leagueName: "MLB", homeTeam: "A", awayTeam: "B", gameTime: "2099-06-01T17:00:00.000Z", gameNumber: 2 }),
    ],
    ["NBA|a|b|2099-01-01|0", "MLB|a|b|2099-06-01|2"]
  );

  // A card on real MLB games: one slip pick (the home ML on the game with the most picks), Total legs past the
  // games and Max legs per game 2, so generated legs join its game. Its game is never weighed down - never in the
  // card's game exposure, never gameReused - and a new Generate resets the card.
  const spec = { name: "slip", games: 6, picks: 26, legs: 9, seed: 21, teams: MLB_TEAMS };
  const base = makePool(spec);
  const slipGame = [...base.games].sort((a, b) => b.picks.length - a.picks.length)[0];
  const slipPick = slipGame.picks[0];
  const generate: GenerateCall = async (req) => {
    const snap: GeneratorSnapshot = { ...base, slipPicks: req.slipPickIds.map((id) => base.games.flatMap((g) => g.picks).find((p) => p.pickId === id)!) };
    return { snapshot: snap, parlay: buildGeneratedParlay(snap, req.settings, req.draw ? generateVariation(req.draw) : null, NOW) };
  };
  const traces: RunTrace[] = [];
  const s = createGeneratorSession({ generate, now: () => NOW, firstSeed: 9, onTrace: (t) => void traces.push(t) });
  const inputs = { leagues: ["MLB"], slipPickIds: [slipPick.pickId], targets: [] };
  const settings: GeneratorSettings = { ...settingsFor(spec), maxLegsPerGame: 2 };
  const shown = [] as Awaited<ReturnType<typeof s.generate>>[];
  shown.push(await s.generate(inputs, settings, { reseed: true }));
  for (let i = 0; i < 8; i++) shown.push(await s.regenerate(inputs, settings, "EXPLORE"));
  const parlays = shown.flatMap((r) => ("error" in r ? [] : [r.parlay]));
  const slipKey = gameExposureKey(slipPick);
  check("slip game: generated legs did land on it (the check has teeth)", parlays.some((p) => p.legs.some((l) => l.gameId === slipGame.gameId && l.source === "GENERATED")), true);
  check("slip game: never in a parlay's game exposure", parlays.some((p) => historyGameKeysOf(p).includes(slipKey)), false);
  const regenSel = traces.filter((t) => t.trigger === "REGENERATE").map((t) => t.extras.selection!);
  const onSlipGame = new Set(slipGame.picks.map((p) => p.pickId));
  check("slip game: no leg on it is ever gameReused", regenSel.some((sel) => sel.legs.some((l) => onSlipGame.has(l.id) && l.gameReused)), false);
  check("other games: weighed down once shown (gameReuseHits)", regenSel.some((sel) => (sel.gameReuseHits ?? 0) > 0), true);

  // Generate resets the card: the next Regenerate weighs down only that Generate's bets.
  const again = await s.generate(inputs, settings, { reseed: true });
  traces.length = 0;
  await s.regenerate(inputs, settings, "EXPLORE");
  const gen = "error" in again ? [] : ids(again.parlay);
  const sel = traces[0].extras.selection!;
  check("Generate resets the card: only its legs count as shown", sel.legs.every((l) => (l.reused === true) === gen.includes(l.id)), true);
}

// ============================================================================
// 4. The run log: how a build varied
// ============================================================================
async function runLog() {
  const spec = POOLS[2];
  const base = makePool(spec);
  const generate: GenerateCall = async (req) => ({ snapshot: base, parlay: buildGeneratedParlay(base, req.settings, req.draw ? generateVariation(req.draw) : null, NOW) });
  const traces: RunTrace[] = [];
  const s = createGeneratorSession({ generate, now: () => NOW, firstSeed: 5, onTrace: (t) => void traces.push(t) });
  const inputs = { leagues: ["MLB"], slipPickIds: [], targets: [] };
  const settings = settingsFor(spec);
  const g = await s.generate(inputs, settings, { reseed: true });
  const g2 = await s.generate(inputs, settings, { reseed: true });
  const r = await s.regenerate(inputs, settings, "DIVERSIFIED");
  if ("error" in g || "error" in g2 || "error" in r) throw new Error("build");
  const genSel = traces[0].extras.selection!;
  check("Generate (built here): GENERATE with its seed, mode and outcome", [traces[0].trigger, genSel.trigger, typeof genSel.seed, genSel.mode, genSel.outcome?.variety, genSel.outcome?.changed], ["GENERATE", "GENERATE", "number", "DIVERSIFIED", "BEST", null]);
  const regen = traces[traces.length - 1];
  const out = regen.extras.selection!.outcome!;
  const prev = new Set(ids(g2.parlay));
  check(
    "Regenerate: outcome - VARIED, legs changed against the parlay before it, games vs legs",
    out,
    { variety: "VARIED", noAlternativeReason: null, changed: ids(r.parlay).filter((id) => !prev.has(id)).length, previous: prev.size, eligibleGames: spec.games, legsNeeded: spec.legs }
  );
  const clean = sanitizeClientTrace(JSON.parse(JSON.stringify(regen)));
  check("Regenerate: outcome and game reuse survive sanitizeClientTrace", [clean?.extras.selection?.outcome, clean?.extras.selection?.gameReuseHits], [out, regen.extras.selection!.gameReuseHits]);

  // A pool with nothing else to draw: NO_ALTERNATIVE, said in the run log.
  const tiny = makePool({ name: "tiny", games: 3, picks: 3, legs: 3, seed: 3 });
  const tinyGen: GenerateCall = async (req) => ({ snapshot: tiny, parlay: buildGeneratedParlay(tiny, req.settings, req.draw ? generateVariation(req.draw) : null, NOW) });
  const t2: RunTrace[] = [];
  const s2 = createGeneratorSession({ generate: tinyGen, now: () => NOW, firstSeed: 5, onTrace: (t) => void t2.push(t) });
  const tinySettings = { ...settingsFor({ name: "tiny", games: 3, picks: 3, legs: 3, seed: 3 }) };
  await s2.generate(inputs, tinySettings, { reseed: true });
  const nr = await s2.regenerate(inputs, tinySettings);
  const noAlt = t2[t2.length - 1].extras.selection!;
  check("nothing else to draw: NO_ALTERNATIVE (NO_COMPARABLE), 0 changed, 3 games for 3 legs", ["error" in nr ? null : nr.parlay.variety, noAlt.outcome], [
    "NO_ALTERNATIVE",
    { variety: "NO_ALTERNATIVE", noAlternativeReason: "NO_COMPARABLE", changed: 0, previous: 3, eligibleGames: 3, legsNeeded: 3 },
  ]);
  check("...through sanitizeClientTrace", sanitizeClientTrace(JSON.parse(JSON.stringify(t2[t2.length - 1])))?.extras.selection?.outcome, noAlt.outcome);
  const hostile = sanitizeClientTrace({ ...JSON.parse(JSON.stringify(regen)), extras: { selection: { ...(regen.extras.selection as SelectionTrace), outcome: { variety: "LOUD", eligibleGames: 3, legsNeeded: 3 } } } });
  check("an outcome that doesn't fit is dropped, the rest kept", [hostile?.extras.selection?.outcome, hostile?.extras.selection?.trigger], [undefined, "REGENERATE"]);
}

(async () => {
  generate();
  await exposure();
  await runLog();
  await pools();
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
