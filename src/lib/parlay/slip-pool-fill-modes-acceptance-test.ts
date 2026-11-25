// The slip is a pool, never a must-include list, and Best available never reads it (generator.ts rule 0,
// snapshotForFill). Fill from, final:
//   Best available  - 100% auto: no slip pick is forced in, ranked or offered in the Swap modal; the slip
//                     itself is untouched.
//   Your picks only - 100% manual: Total legs of the slip, best combined win % first; Regenerate rotates in
//                     unused picks.
//   Combined        - round(Total legs x Manual %) from the slip, the rest auto; Regenerate rotates.
// Total legs is 1..25 in every mode, whatever the slip holds. Pure - no DB. Run with:
//   npx tsx src/lib/parlay/slip-pool-fill-modes-acceptance-test.ts
import { applyLegSwap, buildGeneratedParlay, legSwapOptions, SWAP_TAB_KEYS, type GeneratedParlay, type GeneratorSettings, type GeneratorSnapshot } from "@/lib/parlay/generator";
import { createGeneratorSession, type PoolInputs } from "@/lib/parlay/generator-session";
import { scorePickByRecord } from "@/lib/parlay/record-score";
import { EMPTY_PLATFORM_RATES } from "@/lib/parlay/scoring";
import { legSetKey } from "@/lib/parlay/parlay-set";
import { disabledFillFrom, effectiveFillFrom, effectiveManualSlots } from "@/lib/parlay/combined-fill";
import { legRange } from "@/lib/parlay/subset-ui";
import { MAX_PARLAY_LEGS } from "@/lib/parlay/leg-cap";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { CategoryBreakdownItem, PickCategoryKey } from "@/server/data/stats";
import type { CapperLeagueRecords } from "@/server/data/picks";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

// ---------------------------------------------------------------------------
// Fixture: 30 MLB games. Slip: 20 home MLs on G0..G19, combined win % 55..74 (s20 strongest). Auto
// candidates: an Over at 80% on every game and an away ML at 78% on G20..G29. Plus, for conflicts, an
// away ML on G19 (opposes s20) at 60% that can be pinned too.
// ---------------------------------------------------------------------------
const NOW = new Date("2099-06-01T12:00:00.000Z");
const START = "2099-06-01T23:00:00.000Z";
const categoryRecords: Record<string, CategoryBreakdownItem | null> = {};
const leagueRecords: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };

type Spec = { id: string; game: number; bet: "HOME" | "AWAY" | "OVER"; winPct: number };
function pick(spec: Spec): GeneratorPick {
  const home = `Home${spec.game}`;
  const away = `Away${spec.game}`;
  const detail = spec.bet === "HOME" ? home + " ML" : spec.bet === "AWAY" ? away + " ML" : "Over 8.5";
  const betType = spec.bet === "OVER" ? "TOTAL" : "MONEYLINE";
  const category: PickCategoryKey = spec.bet === "HOME" ? "FAV_ML" : spec.bet === "AWAY" ? "DOG_ML" : "OVER";
  const capperId = "cap-" + spec.id;
  const rec = { wins: spec.winPct, losses: 100 - spec.winPct, pushes: 0, winPct: spec.winPct, count: 100 };
  categoryRecords[capperId + "|" + category] = { key: category, label: category, ...rec };
  leagueRecords.records[capperId + "|MLB|" + category] = { category, label: category, overall: rec, league: rec };
  return {
    pickId: spec.id, capperId, capperName: "Capper " + spec.id, capperColorTag: null, capperIsFavorite: false, category, leagueName: "MLB",
    gameId: "G" + spec.game, gameLabel: away + " @ " + home, betDetail: detail, odds: -110, units: 1, status: "PENDING", betType, period: "FULL_GAME",
    rawBetDetail: detail, propMarket: null, line: betType === "MONEYLINE" ? null : 8.5, homeTeam: home, awayTeam: away,
    gameTime: START, teamGroup: spec.bet === "AWAY" ? "AWAY" : "HOME", teamLabel: "", teamColor: null, datePosted: "2099-05-31T00:00:00.000Z",
  } as GeneratorPick;
}

const SLIP = Array.from({ length: 20 }, (_, i) => pick({ id: `s${i + 1}`, game: i, bet: "HOME", winPct: 55 + i }));
const OPPOSES_S20 = pick({ id: "x19", game: 19, bet: "AWAY", winPct: 60 });
const AUTO = [
  ...Array.from({ length: 30 }, (_, g) => pick({ id: `o${g}`, game: g, bet: "OVER", winPct: 80 })),
  ...Array.from({ length: 10 }, (_, k) => pick({ id: `a${20 + k}`, game: 20 + k, bet: "AWAY", winPct: 78 })),
];
const gamesOf = (all: GeneratorPick[]): GeneratorGame[] => {
  const byGame = new Map<string, GeneratorPick[]>();
  for (const p of all) byGame.set(p.gameId, [...(byGame.get(p.gameId) ?? []), p]);
  return Array.from(byGame.entries()).map(([gameId, picks]) => ({ gameId, gameLabel: picks[0].gameLabel, gameTime: START, leagueName: "MLB", picks }));
};
const ALL = [...SLIP, OPPOSES_S20, ...AUTO];
const snapshotOf = (slip: GeneratorPick[]): GeneratorSnapshot => ({ builtAt: NOW.toISOString(), games: gamesOf(ALL), slipPicks: slip, targets: [], leagueRecords, categoryRecords });
const settingsOf = (fillFrom: GeneratorSettings["fillFrom"], legCount: number, more: Partial<GeneratorSettings> = {}): GeneratorSettings => ({
  legCount,
  maxLegsPerGame: 1,
  include: "ALL",
  mix: null,
  fillFrom,
  ...more,
});
const fromSlip = (p: GeneratedParlay) => p.legs.filter((l) => l.source === "SLIP").map((l) => l.pick.pickId).sort();
const generated = (p: GeneratedParlay) => p.legs.filter((l) => l.source === "GENERATED").map((l) => l.pick.pickId).sort();
const maxOnOneGame = (p: GeneratedParlay) => Math.max(0, ...Array.from(p.legs.reduce((m, l) => m.set(l.gameId, (m.get(l.gameId) ?? 0) + 1), new Map<string, number>()).values()));
const combinedPct = (p: GeneratorPick) => {
  const s = scorePickByRecord(p, { leagueRecords, categoryRecords, platformRates: EMPTY_PLATFORM_RATES, minWinPct: 55 });
  return s.status === "SCORED" ? s.rankScore * 100 : -1;
};
const ids = (ps: GeneratorPick[]) => ps.map((p) => p.pickId).sort();

// A card: the session over this fixture (no requests leave it).
function sessionOver(slip: GeneratorPick[]) {
  const session = createGeneratorSession({
    generate: async (req) => {
      const snap = snapshotOf(slip.filter((p) => req.slipPickIds.includes(p.pickId)));
      return { snapshot: snap, parlay: buildGeneratedParlay(snap, req.settings, null, NOW) };
    },
    now: () => NOW,
    firstSeed: 11,
  });
  const pool: PoolInputs = { leagues: ["MLB"], slipPickIds: slip.map((p) => p.pickId), targets: [] };
  return { session, pool };
}
async function generateAndRegenerate(slip: GeneratorPick[], settings: GeneratorSettings, regenerates: number): Promise<GeneratedParlay[]> {
  const { session, pool } = sessionOver(slip);
  const out: GeneratedParlay[] = [];
  const first = await session.generate(pool, settings);
  if ("error" in first) throw new Error(first.error);
  out.push(first.parlay);
  for (let i = 0; i < regenerates; i++) {
    const r = await session.regenerate(pool, settings);
    if ("error" in r) throw new Error(r.error);
    out.push(r.parlay);
  }
  return out;
}

// ============================================================================
// Total legs: 1..25 whatever the slip holds (the stepper below the slip count)
// ============================================================================
function totalLegs() {
  check("stepper range: from 1, not the slip's 20 (not built yet)", legRange({ capacity: MAX_PARLAY_LEGS }), { min: 1, max: MAX_PARLAY_LEGS });
  check("Fill from: a 20-pick slip leaves all three open", disabledFillFrom(20), []);
  check("Fill from: a 60-pick slip leaves Best available open too (it never reads the slip)", [disabledFillFrom(60), effectiveFillFrom(60, "BEST_AVAILABLE")], [[], "BEST_AVAILABLE"]);
  for (const mode of ["BEST_AVAILABLE", "COMBINED", "YOUR_PICKS_ONLY"] as const) {
    const lens = [1, 5, 10].map((n) => buildGeneratedParlay(snapshotOf(SLIP), settingsOf(mode, n, mode === "COMBINED" ? { manualSlots: effectiveManualSlots(null, n, 20) } : {}), null, NOW).legs.length);
    check(`${mode}: 20 slip picks, Total legs 1 / 5 / 10 build 1 / 5 / 10 legs (never pushed up to 20)`, lens, [1, 5, 10]);
  }
}

// ============================================================================
// Your picks only: 20-pick slip, 10 legs
// ============================================================================
async function yourPicksOnly() {
  const settings = settingsOf("YOUR_PICKS_ONLY", 10);
  const p = buildGeneratedParlay(snapshotOf(SLIP), settings, null, NOW);
  check("Your picks only, 20 picks, 10 legs: 10 legs, every one from the slip", [p.legs.length, fromSlip(p).length, generated(p).length], [10, 10, 0]);
  const best10 = ids([...SLIP].sort((a, b) => combinedPct(b) - combinedPct(a)).slice(0, 10));
  check("...Generate takes the 10 best by combined win % (s11..s20)", fromSlip(p), best10);
  check("...Max legs per game holds", maxOnOneGame(p), 1);
  check("...the other 10 are not_selected, still on the slip", [p.dropped.filter((d) => d.reason === "not_selected").length, p.slipTotal], [10, 20]);

  // Regenerate: 3 taps, each a different combination, none 'No other parlays'.
  const builds = await generateAndRegenerate(SLIP, settings, 3);
  const keys = builds.map((b) => legSetKey(b.legs.map((l) => l.pick.pickId)));
  check("Your picks only: Generate + 3 Regenerates are 4 different combinations", new Set(keys).size, 4);
  check("...every Regenerate VARIED (never 'No other parlays')", builds.slice(1).map((b) => b.variety), ["VARIED", "VARIED", "VARIED"]);
  check("...every build 10 legs, all from the slip, max 1 per game", builds.map((b) => [b.legs.length, fromSlip(b).length, maxOnOneGame(b)].join("/")), Array(4).fill("10/10/1"));
  check("...Regenerate rotates unused slip picks in (more than the first 10 appear)", new Set(builds.flatMap(fromSlip)).size > 10, true);

  // Conflicts: an opposing pair is either/or, never a prompt; the higher-ranked side goes first.
  const withConflict = [...SLIP, OPPOSES_S20];
  const c = buildGeneratedParlay(snapshotOf(withConflict), settings, null, NOW);
  check("Your picks only, opposing pair on G19 (s20 74% vs x19 60%): 10 legs, s20 kept, x19 left for another build", [c.legs.length, fromSlip(c).includes("s20"), fromSlip(c).includes("x19"), maxOnOneGame(c)], [10, true, false, 1]);

  // Slip picks stay exempt from the win-% gate (a 99% gate leaves every slip pick usable).
  const gated = buildGeneratedParlay(snapshotOf(SLIP), settingsOf("YOUR_PICKS_ONLY", 10, { minWinPct: 99 }), null, NOW);
  check("Your picks only: slip picks ignore the win-% gate (10 legs at a 99% gate)", gated.legs.length, 10);
}

// ============================================================================
// Combined: 20-pick slip, 10 legs, Manual 50%
// ============================================================================
async function combined() {
  const manualSlots = effectiveManualSlots(null, 10, 20);
  check("Combined 50% of 10 legs: 5 manual slots (round(10 x 0.5))", manualSlots, 5);
  const settings = settingsOf("COMBINED", 10, { manualSlots });
  const p = buildGeneratedParlay(snapshotOf(SLIP), settings, null, NOW);
  check("Combined, 20 picks, 10 legs, 50/50: 5 from the slip + 5 auto", [p.legs.length, fromSlip(p).length, generated(p).length], [10, 5, 5]);
  check("...the 5 are the slip's best (s16..s20)", fromSlip(p), ["s16", "s17", "s18", "s19", "s20"]);
  check("...Max legs per game holds across both halves", maxOnOneGame(p), 1);
  check("...generated legs are never a slip pick", generated(p).some((id) => id.startsWith("s")), false);

  const builds = await generateAndRegenerate(SLIP, settings, 3);
  const keys = builds.map((b) => legSetKey(b.legs.map((l) => l.pick.pickId)));
  check("Combined: Generate + 3 Regenerates are 4 different combinations", new Set(keys).size, 4);
  check("...every build 5 + 5", builds.map((b) => `${fromSlip(b).length}+${generated(b).length}`), Array(4).fill("5+5"));
  check("...Regenerate rotates through unused slip picks (20 distinct over 4 builds, no repeats)", new Set(builds.flatMap(fromSlip)).size, 20);

  // Two slip picks that conflict: auto-resolved, the higher-ranked kept, no prompt.
  const c = buildGeneratedParlay(snapshotOf([...SLIP, OPPOSES_S20]), settings, null, NOW);
  check("Combined, opposing pair pinned: still 5 + 5, s20 kept, x19 not used", [fromSlip(c).length, generated(c).length, fromSlip(c).includes("s20"), fromSlip(c).includes("x19")], [5, 5, true, false]);

  // Exempt from the gate and from the -250 cap, as today.
  const heavy = pick({ id: "h1", game: 25, bet: "HOME", winPct: 90 });
  heavy.odds = -400;
  const h = buildGeneratedParlay(snapshotOf([heavy]), settingsOf("COMBINED", 3, { manualSlots: 1, minWinPct: 95 }), null, NOW);
  check("Combined: a -400 slip pick under a 95% gate is still a manual leg", fromSlip(h), ["h1"]);
}

// ============================================================================
// Best available: ignores the slip completely
// ============================================================================
function bestAvailable() {
  const settings = settingsOf("BEST_AVAILABLE", 10);
  const snap = snapshotOf(SLIP);
  const before = JSON.stringify(snap.slipPicks);
  const withSlip = buildGeneratedParlay(snap, settings, null, NOW);
  const noSlip = buildGeneratedParlay(snapshotOf([]), settings, null, NOW);
  check("Best available, full 20-pick slip, 10 legs: 10 legs, zero slip-sourced", [withSlip.legs.length, fromSlip(withSlip).length, withSlip.fromSlip, withSlip.slipUsed], [10, 0, 0, 0]);
  check("...nothing about the slip in the result (no dropped, no not_selected)", withSlip.dropped.length, 0);
  check("...the same parlay as with an empty slip (legs, Hedge, Contrarian)", JSON.stringify([withSlip.legs, withSlip.hedge, withSlip.contrarian]) === JSON.stringify([noSlip.legs, noSlip.hedge, noSlip.contrarian]), true);
  // Swap modal: every leg, every tab.
  let slipOptions = 0;
  for (let i = 0; i < withSlip.legs.length; i++) {
    const o = legSwapOptions(snap, settings, withSlip.legs, i, NOW);
    slipOptions += SWAP_TAB_KEYS.flatMap((t) => o[t]).filter((l) => l.source === "SLIP").length;
  }
  check("Best available: zero slip-sourced Swap options across every leg and tab", slipOptions, 0);
  check("...and a slip pick can't be swapped in as one", applyLegSwap(snap, settings, withSlip, 0, "s1", NOW)?.legs.some((l) => l.source === "SLIP") ?? false, false);
  // The slip itself is untouched by a Best available build.
  check("Best available: the slip is intact after the build (same 20 picks)", [snap.slipPicks.length, JSON.stringify(snap.slipPicks) === before], [20, true]);
  // Back to the other modes: the pins are all still there to use.
  const back = buildGeneratedParlay(snap, settingsOf("YOUR_PICKS_ONLY", 25), null, NOW);
  check("...then Your picks only on the same slip uses all 20 pins", fromSlip(back).length, 20);
  // A 60-pick slip changes nothing either.
  const big = Array.from({ length: 60 }, (_, i) => (i < 20 ? SLIP[i] : pick({ id: `b${i}`, game: i % 30, bet: "AWAY", winPct: 56 })));
  const bigBuild = buildGeneratedParlay({ ...snapshotOf(big), games: gamesOf([...ALL, ...big.slice(20)]) }, settings, null, NOW);
  check("Best available, 60-pick slip: 10 legs, zero slip-sourced", [bigBuild.legs.length, fromSlip(bigBuild).length], [10, 0]);
}

(async () => {
  totalLegs();
  await yourPicksOnly();
  await combined();
  bestAvailable();
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
