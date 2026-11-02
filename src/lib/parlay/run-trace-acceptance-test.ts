// The Parlay Generator's run log (run-trace.ts) is diagnostics only. Pinned here:
//   1. ZERO DIFF - buildGeneratedParlay returns exactly the same parlay with a
//      collector, with a collector that throws on every call, and without one, for
//      Generate, targets, Include Picks, a Pick Mix, a slip with every kind of
//      conflict, Your picks only, and Regenerate (seeded, with history).
//   2. RECONCILES - in every chain each stage = the previous stage minus the drops
//      tallied at it, and the stages the engine counted itself agree with the parlay.
//   3. COVERAGE - every removal path in the engine shows up under a reason code in
//      the vocabulary, and no run reports a code outside it.
//   4. A collector failure never breaks the build, and is reported on the trace.
//   5. Detail: on for Generate, off for Regenerate; capped with detailTruncated while
//      the tallies stay complete.
//   6. The browser's trace is validated (strict schema, forced origin, bounded) and
//      rate limited; the session emits traces without changing its results.
// Pure - no DB. Run with:
//   npx tsx src/lib/parlay/run-trace-acceptance-test.ts
import { buildGeneratedParlay, GENERATOR_RULES, type GeneratedParlay, type GeneratorSettings, type GeneratorSnapshot, type Variation } from "@/lib/parlay/generator";
import { createGeneratorSession } from "@/lib/parlay/generator-session";
import { traceModeOf, traceSettings } from "@/lib/parlay/generator-trace";
import { MAX_DETAIL_ENTRIES, REASON_CODES, reconcileTrace, scoringVersionOf, TraceCollector, type RunTrace } from "@/lib/parlay/run-trace";
import { allowTrace, RATE_LIMIT_PER_MINUTE, sanitizeClientTrace } from "@/lib/parlay/run-trace-validate";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { CategoryBreakdownItem, PickCategoryKey } from "@/server/data/stats";
import type { CapperLeagueRecords } from "@/server/data/picks";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}
const ok = (label: string, cond: boolean, detail = "") => check(label + (detail && !cond ? " " + detail : ""), cond, true);

// ---------------------------------------------------------------------------
// Fixture: 5 NFL games ahead of NOW, one that is over, and a slate of cappers
// that trips every gate: a good favorite / over / spread capper, a bad dog
// capper (below the gate), a capper with no record, a pick with no category, and
// a player prop with no per-market record.
// ---------------------------------------------------------------------------
const NOW = new Date("2026-10-15T14:00:00.000Z");
const col = (wins: number, losses: number) => ({ wins, losses, pushes: 0, winPct: (wins / (wins + losses)) * 100, count: wins + losses });
const TEAMS: [string, string, string][] = [
  ["Kansas City Chiefs", "Los Angeles Chargers", "Chiefs"],
  ["Buffalo Bills", "Miami Dolphins", "Bills"],
  ["Philadelphia Eagles", "Dallas Cowboys", "Eagles"],
  ["Detroit Lions", "Chicago Bears", "Lions"],
  ["Baltimore Ravens", "Cincinnati Bengals", "Ravens"],
  ["San Francisco 49ers", "Seattle Seahawks", "49ers"],
];
const RECORDS: Record<string, [number, number]> = { fav: [14, 6], fav2: [13, 5], over: [13, 7], dog: [6, 14], spread: [11, 4], prop: [12, 4] };

function fixture(): { snapshot: GeneratorSnapshot; slip: GeneratorPick[] } {
  const categoryRecords: Record<string, CategoryBreakdownItem | null> = {};
  const leagueRecords: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };
  const make = (id: string, i: number, capper: string, category: PickCategoryKey | null, betType: string, detail: string, line: number | null, extra: Partial<GeneratorPick> = {}): GeneratorPick => {
    const [home, away] = TEAMS[i];
    const rec = RECORDS[capper];
    if (rec && category) {
      const r = col(...rec);
      categoryRecords[capper + "|" + category] = { key: category, label: category, ...r };
      leagueRecords.records[capper + "|NFL|" + category] = { category, label: category, overall: r, league: r };
    }
    const gameTime = i === 5 ? new Date(NOW.getTime() - 8 * 3600_000).toISOString() : new Date(NOW.getTime() + (3 + i) * 3600_000).toISOString();
    return {
      pickId: id, capperId: capper, capperName: "Capper " + capper, capperColorTag: null, capperIsFavorite: false, category,
      leagueName: "NFL", gameId: "g" + i, gameLabel: away + " @ " + home, betDetail: detail, odds: -110, units: 1, status: "PENDING", betType, period: "FULL_GAME",
      rawBetDetail: detail, propMarket: null, line, homeTeam: home, awayTeam: away, gameTime, teamGroup: "HOME", teamLabel: "", teamColor: null,
      datePosted: new Date(NOW.getTime() - 2 * 3600_000).toISOString(), gameNumber: null, ...extra,
    } as unknown as GeneratorPick;
  };
  const games: GeneratorGame[] = TEAMS.map(([home, away, nick], i) => {
    const picks = [
      make(`p${i}-fav`, i, "fav", "FAV_ML", "MONEYLINE", nick + " ML", null),
      make(`p${i}-over`, i, "over", "OVER", "TOTAL", "Over 44.5", 44.5),
      make(`p${i}-dog`, i, "dog", "DOG_ML", "MONEYLINE", away.split(" ").pop() + " ML", null),
      make(`p${i}-spread`, i, "spread", "SPREAD_MINUS", "SPREAD", nick + " -3", -3),
    ];
    if (i === 0) {
      picks.push(make("p0-norec", 0, "ghost", "OVER", "TOTAL", "Over 45.5", 45.5));
      picks.push(make("p0-nocat", 0, "nocat", null, "MONEYLINE", nick + " ML (unreadable)", null));
      picks.push(make("p0-prop", 0, "prop", "PASS_YDS_PROP", "PLAYER_PROP", "Patrick Mahomes Over 275.5 Passing Yards", 275.5, { propMarket: "PASS_YDS" } as Partial<GeneratorPick>));
    }
    return { gameId: "g" + i, gameLabel: away + " @ " + home, gameTime: picks[0].gameTime, leagueName: "NFL", picks };
  });
  // Slip: a duplicate of g2's favorite, the other side of it, a g3 pair that max legs per game 1 splits, and a pick on the game that is over.
  const slip = [
    make("s-fav", 2, "fav", "FAV_ML", "MONEYLINE", "Eagles ML", null),
    make("s-dup", 2, "fav2", "FAV_ML", "MONEYLINE", "Eagles ML", null),
    make("s-opp", 2, "dog", "DOG_ML", "MONEYLINE", "Cowboys ML", null),
    make("s-g3a", 3, "fav", "FAV_ML", "MONEYLINE", "Lions ML", null),
    make("s-g3b", 3, "over", "OVER", "TOTAL", "Over 44.5", 44.5),
    make("s-over", 5, "over", "OVER", "TOTAL", "Over 44.5", 44.5),
  ];
  // The slip's first pick is also on the board (the engine skips it as a candidate).
  games[2].picks.push(slip[0]);
  return { snapshot: { builtAt: NOW.toISOString(), games, slipPicks: [], targets: [], leagueRecords, categoryRecords }, slip };
}

const BASE: GeneratorSettings = { legCount: 3, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE" };
type Scenario = { name: string; settings: GeneratorSettings; targets?: string[]; slip?: boolean; slipIds?: string[]; variation?: Variation };
const SCENARIOS: Scenario[] = [
  { name: "Generate, 3 legs, 1 per game", settings: BASE },
  { name: "targets g0+g1, game lines, 3 per game", settings: { ...BASE, legCount: 2, maxLegsPerGame: 3, include: ["MONEYLINE", "SPREAD", "TOTALS"] }, targets: ["g0", "g1"] },
  { name: "Totals only, 60% gate", settings: { ...BASE, legCount: 2, include: ["TOTALS"], minWinPct: 60 } },
  { name: "Pick Mix ML 50 / Totals 50, 2 per game", settings: { ...BASE, legCount: 2, maxLegsPerGame: 2, include: ["MONEYLINE", "TOTALS"], mix: { MONEYLINE: 50, TOTALS: 50 } } },
  { name: "slip with every conflict", settings: { ...BASE, legCount: 5 }, slip: true },
  { name: "Your picks only, more picks than legs", settings: { ...BASE, legCount: 2, fillFrom: "YOUR_PICKS_ONLY" }, slip: true, slipIds: ["s-fav", "s-g3a", "s-g3b", "p4-over"] },
  { name: "Regenerate (seed 7, history)", settings: BASE, variation: { seed: 7, history: [["p0-fav", "p1-over", "p2-spread"]] } },
];

function run(s: Scenario, trace?: TraceCollector): GeneratedParlay {
  const { snapshot, slip } = fixture();
  const all = [...slip, ...snapshot.games.flatMap((g) => g.picks)];
  const chosen = s.slip ? (s.slipIds ? s.slipIds.map((id) => all.find((p) => p.pickId === id)!) : slip) : [];
  const snap: GeneratorSnapshot = { ...snapshot, slipPicks: chosen, targets: s.targets ?? [] };
  return buildGeneratedParlay(snap, s.settings, s.variation ?? null, NOW, GENERATOR_RULES, trace);
}
const collector = (s: Scenario, detail = true) =>
  new TraceCollector({ mode: traceModeOf({ slipPickIds: s.slip ? ["x"] : [] }, s.settings), trigger: s.variation ? "REGENERATE" : "GENERATE", origin: "CLIENT", scoringVersion: scoringVersionOf(GENERATOR_RULES), settings: {} }, detail);

// A collector whose every method throws - what a broken sink looks like to the engine.
const hostile = (): TraceCollector => {
  const boom = () => {
    throw new Error("sink exploded");
  };
  return { stage: boom, tally: boom, drop: boom, extras: boom, swapMode: boom, error: () => undefined, finish: boom, detailOn: true } as unknown as TraceCollector;
};

const seen = new Set<string>();
const traces: [Scenario, RunTrace, GeneratedParlay][] = [];

// ---- 1. Zero diff ---------------------------------------------------------
for (const s of SCENARIOS) {
  const plain = JSON.stringify(run(s));
  const c = collector(s, !s.variation);
  const traced = run(s, c);
  check(`zero diff - ${s.name}: same parlay with a collector`, JSON.stringify(traced), plain);
  check(`zero diff - ${s.name}: same parlay with a collector that throws on every call`, JSON.stringify(run(s, hostile())), plain);
  traces.push([s, c.finish(), traced]);
}

// ---- 2. Reconciliation -----------------------------------------------------
for (const [s, trace, parlay] of traces) {
  check(`reconciles - ${s.name}`, reconcileTrace(trace), []);
  const at = (key: string) => trace.stages.find((x) => x.key === key)?.count;
  check(`stage SELECTED is the parlay's generated legs - ${s.name}`, at("SELECTED"), parlay.generated);
  check(`stage SLIP_USED is the slip legs used - ${s.name}`, at("SLIP_USED"), parlay.slipUsed);
  ok(`every funnel stage was counted - ${s.name}`, trace.stages.length === 8 + 5, JSON.stringify(trace.stages.map((x) => x.key)));
  ok(`no collector failure - ${s.name}`, !trace.failed && trace.errors.length === 0);
  for (const r of trace.reasons) seen.add(r.reason);
  for (const m of trace.extras.swaps ?? []) for (const l of m.legs) seen.add(l.result);
}

// ---- 3. Coverage ------------------------------------------------------------
const known = new Set<string>(REASON_CODES);
ok("every reason the engine reported is in the vocabulary", [...seen].every((r) => known.has(r) || r === "SWAPPED"), JSON.stringify([...seen].filter((r) => !known.has(r))));
const EXPECTED = [
  "IS_SLIP_PICK", "FILTER_BET_TYPE", "NO_CATEGORY", "NO_RECORD", "NO_PROP_MARKET_RECORD", "BELOW_GATE", "SLIP_CONFLICT",
  "GAME_OVER", "NOT_TARGETED", "SAME_GAME_CONFLICT", "MAX_PER_GAME", "MIX_QUOTA", "NOT_NEEDED",
  "SLIP_GAME_OVER", "SLIP_DUPLICATE", "SLIP_OPPOSES", "SLIP_LEFT_OUT", "SLIP_NOT_SELECTED",
];
for (const code of EXPECTED) ok(`removal path reported: ${code}`, seen.has(code));

const first = traces[0][1];
const reasonCount = (t: RunTrace, reason: string) => t.reasons.filter((r) => r.reason === reason).reduce((n, r) => n + r.count, 0);
check("below the gate: the dog capper's pick on every open game", reasonCount(first, "BELOW_GATE"), 5);
check("no record: the capper with none", reasonCount(first, "NO_RECORD"), 1);
check("no category: the pick with none", reasonCount(first, "NO_CATEGORY"), 1);
check("no prop market record: the prop", reasonCount(first, "NO_PROP_MARKET_RECORD"), 1);
check("game over: all 4 of its picks leave at the scope stage", reasonCount(first, "GAME_OVER"), 4);
ok("a dropped pick is listed with its reason", !!first.detail && first.detail.drops.some(([i, stage, reason]) => first.detail!.picks[i].id === "p0-prop" && stage === "HAS_RECORD" && reason === "NO_PROP_MARKET_RECORD"));

// Hedge / Contrarian: every leg of Swap = All says what the classifier thought of the rest of its game.
const swaps = first.extras.swaps ?? [];
check("Hedge and Contrarian traced for each Swap setting", swaps.map((m) => m.mode + ":" + m.scope).sort(), ["AUTO_HEDGE:ALL", "AUTO_HEDGE:SUGGESTED", "AUTO_HEDGE:YOUR_PICKS", "CONTRARIAN:ALL", "CONTRARIAN:SUGGESTED", "CONTRARIAN:YOUR_PICKS"]);
const hedgeAll = swaps.find((m) => m.mode === "AUTO_HEDGE" && m.scope === "ALL")!;
const contrarianAll = swaps.find((m) => m.mode === "CONTRARIAN" && m.scope === "ALL")!;
check("one swap trace per leg", [hedgeAll.legs.length, contrarianAll.legs.length], [traces[0][2].legs.length, traces[0][2].legs.length]);
ok("Hedge swapped at least one leg (side <-> total)", hedgeAll.swapCount > 0 && hedgeAll.legs.some((l) => l.result === "SWAPPED" && (l.rule === "R4" || l.rule === "R5")));
ok("Contrarian legs carry the classifier's verdicts (R2 pairs the opposite side)", contrarianAll.legs.some((l) => (l.classifier.R2 ?? 0) > 0 || (l.classifier.R3 ?? 0) > 0));
ok("a leg with no alternate says why (classifier tally present)", contrarianAll.legs.every((l) => l.result === "SWAPPED" || Object.keys(l.classifier).length > 0 || l.excluded.IN_SLIP + l.excluded.ALREADY_IN_PARLAY + l.excluded.FILTER_BET_TYPE + l.excluded.SAME_GAME_CONFLICT > 0));
check("swap counts agree with the parlay", hedgeAll.swapCount, traces[0][2].hedge.ALL.swapCount);
check("contrarian swap counts agree with the parlay", contrarianAll.swapCount, traces[0][2].contrarian.ALL.swapCount);

// ---- 4. Failure isolation ----------------------------------------------------
{
  const s = SCENARIOS[4];
  const reporting = hostile();
  let threw = false;
  let out = "";
  try {
    out = JSON.stringify(run(s, reporting));
  } catch {
    threw = true;
  }
  check("a throwing collector does not break the build", [threw, out], [false, JSON.stringify(run(s))]);
  // A real collector whose storage fails reports it and stops recording; the build is unchanged.
  const c = collector(s);
  (c as unknown as { stagesOut: unknown }).stagesOut = null;
  const plain = JSON.stringify(run(s));
  check("a collector whose storage breaks leaves the parlay unchanged", JSON.stringify(run(s, c)), plain);
  const t = c.finish();
  ok("...and says it failed", t.failed && t.errors.some((e) => e.code === "TRACE_ERROR"));
}

// ---- 5. Detail ----------------------------------------------------------------
{
  const regenerate = traces.find(([s]) => s.variation)!;
  check("Regenerate keeps counts only", regenerate[1].detail, null);
  ok("...with the funnel still complete", reconcileTrace(regenerate[1]).length === 0 && regenerate[1].reasons.length > 0);
  const c = new TraceCollector({ mode: "STANDARD", trigger: "GENERATE", origin: "CLIENT", scoringVersion: "v", settings: {} }, true);
  for (let i = 0; i < MAX_DETAIL_ENTRIES + 50; i++) c.drop("INCLUDED", "FILTER_BET_TYPE", { id: "p" + i, label: "pick " + i });
  const t = c.finish();
  check("detail is capped and says so", [t.detail!.drops.length, t.detailTruncated], [MAX_DETAIL_ENTRIES, true]);
  check("...while the tally counts every drop", t.reasons[0].count, MAX_DETAIL_ENTRIES + 50);
}

// ---- 6. The browser's trace ------------------------------------------------------
{
  const [s, trace] = traces[4];
  void s;
  const wire = JSON.parse(JSON.stringify({ ...trace, userId: "someone-else", origin: "SERVER", mode: "STANDARD", extras: { ...trace.extras, buildSha: "abc" } }));
  const clean = sanitizeClientTrace(wire)!;
  ok("a well-formed trace is accepted", clean !== null);
  check("origin is forced to CLIENT", clean.origin, "CLIENT");
  ok("no userId or buildSha survives", !("userId" in clean) && !("buildSha" in clean.extras));
  check("the funnel survives intact", [clean.stages, clean.reasons], [trace.stages, trace.reasons]);
  check("a Hybrid trace from the browser is refused", sanitizeClientTrace({ ...wire, mode: "HYBRID" }), null);
  check("a server trigger from the browser is refused", sanitizeClientTrace({ ...wire, trigger: "FETCH" }), null);
  check("garbage is refused", [sanitizeClientTrace(null), sanitizeClientTrace("x"), sanitizeClientTrace({}), sanitizeClientTrace([])], [null, null, null, null]);
  const dirty = sanitizeClientTrace({
    ...wire,
    reasons: [{ stage: "INCLUDED", reason: "MADE_UP", count: 1 }, { stage: "NOPE", reason: "BELOW_GATE", count: 1 }, { stage: "INCLUDED", reason: "BELOW_GATE", count: -3 }, { stage: "INCLUDED", reason: "BELOW_GATE", count: 4 }],
    stages: [{ key: "POOL", count: 5 }, { key: "BOGUS", count: 1 }, { key: "SELECTED", count: 1.5 }],
    errors: [{ code: "FETCH_ERROR", message: "x".repeat(5000) }, { code: "WHAT", message: "no" }],
  })!;
  check("unknown codes, bad counts and bad stages are dropped", [dirty.reasons.length, dirty.stages.length, dirty.errors.length], [1, 1, 1]);
  ok("a long error message is clipped", dirty.errors[0].message.length <= 300);
  const huge = sanitizeClientTrace({ ...wire, detail: { picks: Array.from({ length: 5000 }, (_, i) => ({ id: "p" + i, label: "x".repeat(500) })), drops: Array.from({ length: 5000 }, (_, i) => [i, "INCLUDED", "FILTER_BET_TYPE"]) } })!;
  ok("detail is capped on the way in", huge.detail === null || huge.detail.drops.length <= MAX_DETAIL_ENTRIES);
  const badIdx = sanitizeClientTrace({ ...wire, detail: { picks: [{ id: "a", label: "b" }], drops: [[0, "INCLUDED", "FILTER_BET_TYPE"], [7, "INCLUDED", "FILTER_BET_TYPE"], [0, "INCLUDED", "NOPE"]] } })!;
  check("a drop pointing at no pick, or with an unknown reason, is dropped", badIdx.detail!.drops.length, 1);

  const user = "rate-test-user";
  const results = Array.from({ length: RATE_LIMIT_PER_MINUTE + 5 }, () => allowTrace(user, 1_000_000));
  check("rate limit: the first N pass, the rest don't", [results.filter(Boolean).length, results.slice(-5).some(Boolean)], [RATE_LIMIT_PER_MINUTE, false]);
  check("rate limit: another user is unaffected", allowTrace("someone-else", 1_000_000), true);
  check("rate limit: a minute later it frees up", allowTrace(user, 1_000_000 + 61_000), true);
}

// ---- 7. The session ----------------------------------------------------------------
async function sessionChecks() {
  // No game that is over: a snapshot with one is stale on arrival and reloads every time.
  const full = fixture().snapshot;
  const snapshot: GeneratorSnapshot = { ...full, games: full.games.filter((g) => g.gameId !== "g5") };
  const inputs = { leagues: ["NFL"], slipPickIds: [], targets: [] as { gameId: string; leagueName: string }[] };
  const make = (onTrace?: (t: RunTrace) => void, now = () => NOW) =>
    createGeneratorSession({ now, firstSeed: 1, onTrace, generate: async (req) => ({ snapshot, parlay: buildGeneratedParlay(snapshot, req.settings, null, NOW) }) });

  const quiet = make();
  const got: RunTrace[] = [];
  const loud = make((t) => got.push(t));
  const a1 = await quiet.generate(inputs, BASE);
  const b1 = await loud.generate(inputs, BASE); // fetched: the server traced it, so no browser trace
  check("a build fetched from the server is not traced in the browser", got.length, 0);
  const a2 = await quiet.generate(inputs, BASE);
  const b2 = await loud.generate(inputs, BASE);
  check("Generate from the held snapshot emits one GENERATE trace with detail", [got.length, got[0]?.trigger, got[0]?.detail !== null], [1, "GENERATE", true]);
  const a3 = await quiet.regenerate(inputs, BASE);
  const b3 = await loud.regenerate(inputs, BASE);
  check("Regenerate emits a REGENERATE trace with counts only", [got.length, got[1]?.trigger, got[1]?.detail], [2, "REGENERATE", null]);
  check("the session's parlays are the same with a listener", [JSON.stringify(b1), JSON.stringify(b2), JSON.stringify(b3)], [JSON.stringify(a1), JSON.stringify(a2), JSON.stringify(a3)]);
  ok("session traces reconcile", got.every((t) => reconcileTrace(t).length === 0));
  check("session traces carry the settings and the snapshot's age", [got[0].settings.legCount, got[0].extras.snapshotBuiltAt], [3, snapshot.builtAt]);
  check("scoring version names the rules", got[0].scoringVersion, "standard/hier-k20-logit-edge-min5-v1/contrarian-wilson-z1.5");

  const thrower = make(() => {
    throw new Error("listener exploded");
  });
  await thrower.generate(inputs, BASE);
  const t2 = await thrower.generate(inputs, BASE);
  check("a throwing listener does not break Generate", "error" in t2 ? "error" : "ok", "ok");
  check("trace settings are primitives", JSON.stringify(traceSettings(inputs, BASE)).includes("legCount"), true);

  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll run-trace checks passed");
}
void sessionChecks();
