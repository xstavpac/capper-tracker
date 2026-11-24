// Fill from = Combined (generator.ts rule 7, combined-fill.ts): the parlay is manualSlots of your
// picks (ranked among themselves by the combined win %, exempt from every filter) plus the
// generator's own best for the rest, never competing with each other; conflicts and Max legs per
// game hold across both; a short pool is backfilled from the other; Regenerate rotates through
// every slip pick before any repeats. Pure - no DB. Run with:
//   npx tsx src/lib/parlay/combined-fill-acceptance-test.ts
import { buildGeneratedParlay, type GeneratedParlay, type GeneratorSettings, type GeneratorSnapshot } from "@/lib/parlay/generator";
import { createGeneratorSession, type PoolInputs } from "@/lib/parlay/generator-session";
import { scorePickByRecord } from "@/lib/parlay/record-score";
import { EMPTY_PLATFORM_RATES } from "@/lib/parlay/scoring";
import { legSetKey } from "@/lib/parlay/parlay-set";
import {
  clampManualSlots,
  defaultFillFrom,
  defaultManualSlots,
  disabledFillFrom,
  effectiveFillFrom,
  fillFromAfterSlipChange,
  maxManualSlots,
  nextRotationUsed,
  rescaleManualSlots,
} from "@/lib/parlay/combined-fill";
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
// Fixture: 30 MLB games. Slip: 20 picks, one home ML on each of G0..G19, combined
// win % 55..74 (s20 strongest). Auto candidates: an Over 8.5 at 80% on every game
// (stronger than any slip pick) and an away ML at 78% on G20..G29.
// ---------------------------------------------------------------------------
const NOW = new Date("2099-06-01T12:00:00.000Z");
const START = "2099-06-01T23:00:00.000Z";
const categoryRecords: Record<string, CategoryBreakdownItem | null> = {};
const leagueRecords: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };

// teams: real names (home, away, home nickname, away nickname), for the cases the classifier must read.
type Spec = { id: string; game: number; bet: "HOME" | "AWAY" | "OVER" | "UNDER"; winPct: number; odds?: number; favorite?: boolean; teams?: [string, string, string, string] };
function pick(spec: Spec): GeneratorPick {
  const [home, away, homeNick, awayNick] = spec.teams ?? [`Home${spec.game}`, `Away${spec.game}`, `Home${spec.game}`, `Away${spec.game}`];
  const detail = spec.bet === "HOME" ? homeNick + " ML" : spec.bet === "AWAY" ? awayNick + " ML" : `${spec.bet === "OVER" ? "Over" : "Under"} 8.5`;
  const betType = spec.bet === "HOME" || spec.bet === "AWAY" ? "MONEYLINE" : "TOTAL";
  const category: PickCategoryKey = spec.bet === "HOME" ? "FAV_ML" : spec.bet === "AWAY" ? "DOG_ML" : spec.bet;
  const capperId = "cap-" + spec.id;
  const rec = { wins: spec.winPct, losses: 100 - spec.winPct, pushes: 0, winPct: spec.winPct, count: 100 };
  categoryRecords[capperId + "|" + category] = { key: category, label: category, ...rec };
  leagueRecords.records[capperId + "|MLB|" + category] = { category, label: category, overall: rec, league: rec };
  return {
    pickId: spec.id, capperId, capperName: "Capper " + spec.id, capperColorTag: null, capperIsFavorite: spec.favorite === true, category, leagueName: "MLB",
    gameId: "G" + spec.game, gameLabel: away + " @ " + home, betDetail: detail, odds: spec.odds ?? -110, units: 1, status: "PENDING", betType, period: "FULL_GAME",
    rawBetDetail: detail, propMarket: null, line: betType === "MONEYLINE" ? null : 8.5, homeTeam: home, awayTeam: away,
    gameTime: START, teamGroup: spec.bet === "AWAY" ? "AWAY" : "HOME", teamLabel: "", teamColor: null, datePosted: "2099-05-31T00:00:00.000Z",
  } as GeneratorPick;
}

const SLIP = Array.from({ length: 20 }, (_, i) => pick({ id: `s${i + 1}`, game: i, bet: "HOME", winPct: 55 + i }));
const AUTO = [
  ...Array.from({ length: 30 }, (_, g) => pick({ id: `o${g}`, game: g, bet: "OVER", winPct: 80 })),
  ...Array.from({ length: 10 }, (_, k) => pick({ id: `a${20 + k}`, game: 20 + k, bet: "AWAY", winPct: 78 })),
];
const gamesOf = (all: GeneratorPick[]): GeneratorGame[] => {
  const byGame = new Map<string, GeneratorPick[]>();
  for (const p of all) byGame.set(p.gameId, [...(byGame.get(p.gameId) ?? []), p]);
  return Array.from(byGame.entries()).map(([gameId, picks]) => ({ gameId, gameLabel: picks[0].gameLabel, gameTime: START, leagueName: "MLB", picks }));
};
const snapshotOf = (slip: GeneratorPick[], extra: GeneratorPick[] = AUTO): GeneratorSnapshot => ({
  builtAt: NOW.toISOString(),
  games: gamesOf([...slip, ...extra]),
  slipPicks: slip,
  targets: [],
  leagueRecords,
  categoryRecords,
});
const settingsOf = (legCount: number, manualSlots: number | undefined, more: Partial<GeneratorSettings> = {}): GeneratorSettings => ({
  legCount,
  maxLegsPerGame: 1,
  include: "ALL",
  mix: null,
  fillFrom: "COMBINED",
  ...(manualSlots !== undefined ? { manualSlots } : {}),
  ...more,
});
const slipIds = (p: GeneratedParlay) => p.legs.filter((l) => l.source === "SLIP").map((l) => l.pick.pickId).sort();
const autoIds = (p: GeneratedParlay) => p.legs.filter((l) => l.source === "GENERATED").map((l) => l.pick.pickId).sort();
const maxOnOneGame = (p: GeneratedParlay) => Math.max(0, ...Array.from(p.legs.reduce((m, l) => m.set(l.gameId, (m.get(l.gameId) ?? 0) + 1), new Map<string, number>()).values()));
const combinedPct = (p: GeneratorPick) => {
  const s = scorePickByRecord(p, { leagueRecords, categoryRecords, platformRates: EMPTY_PLATFORM_RATES, minWinPct: 55 });
  return s.status === "SCORED" ? s.rankScore * 100 : -1;
};

// ============================================================================
// Split and defaults (combined-fill.ts)
// ============================================================================
check("defaults: half the legs, capped at the slip", [defaultManualSlots(10, 20), defaultManualSlots(5, 20), defaultManualSlots(10, 3), defaultManualSlots(10, 0)], [5, 3, 3, 0]);
check("slider max = min(Total legs, slip size); slip of 1 -> 1", [maxManualSlots(10, 20), maxManualSlots(10, 3), maxManualSlots(10, 1)], [10, 3, 1]);
check("clamp", [clampManualSlots(12, 10, 20), clampManualSlots(-1, 10, 20), clampManualSlots(5, 10, 3)], [10, 0, 3]);
check("Total legs 10 -> 6 keeps the proportion (3 of 10 -> 2 of 6); re-capped at the slip", [rescaleManualSlots(10, 6, 3, 20), rescaleManualSlots(4, 12, 2, 3)], [2, 3]);
check("Fill from: empty slip disables Combined and Your picks only", disabledFillFrom(0), ["COMBINED", "YOUR_PICKS_ONLY"]);
check("Fill from: any picks enables all three", disabledFillFrom(3), []);
check("Fill from default: Combined with picks, Best available without", [defaultFillFrom(1), defaultFillFrom(0)], ["COMBINED", "BEST_AVAILABLE"]);
check(
  "clearing the slip while in Combined / Your picks only falls back to Best available",
  [fillFromAfterSlipChange(5, 0, "COMBINED"), fillFromAfterSlipChange(5, 0, "YOUR_PICKS_ONLY"), effectiveFillFrom(0, "COMBINED")],
  ["BEST_AVAILABLE", "BEST_AVAILABLE", "BEST_AVAILABLE"]
);
check("first pick makes Combined the default; later changes keep the choice", [fillFromAfterSlipChange(0, 1, "BEST_AVAILABLE"), fillFromAfterSlipChange(2, 3, "BEST_AVAILABLE")], ["COMBINED", "BEST_AVAILABLE"]);
check("rotation restart: 4 picks, 3 a build -> ABC, DAB, CDA, BCD, ABC", (() => {
  const elig = ["A", "B", "C", "D"];
  let used = new Set<string>();
  const out: string[] = [];
  for (let b = 0; b < 5; b++) {
    const order = [...elig.filter((x) => !used.has(x)), ...elig.filter((x) => used.has(x))];
    const taken = order.slice(0, 3);
    out.push(taken.join(""));
    used = nextRotationUsed(elig, used, taken);
  }
  return out;
})(), ["ABC", "DAB", "CDA", "BCD", "ABC"]);

// ============================================================================
// 20 slip picks, 10 legs, slider 3: 3 manual (the slip's top 3) + 7 auto
// ============================================================================
{
  const snap = snapshotOf(SLIP);
  const p = buildGeneratedParlay(snap, settingsOf(10, 3), null, NOW);
  check("20/10/3: 10 legs, 3 manual + 7 auto", [p.legs.length, slipIds(p).length, autoIds(p).length], [10, 3, 7]);
  check("20/10/3: the 3 are the slip's top 3 by combined win %", slipIds(p), ["s18", "s19", "s20"]);
  check("20/10/3: every auto leg out-scores the slip's best (the pools never compete)", Math.min(...p.legs.filter((l) => l.source === "GENERATED").map((l) => combinedPct(l.pick))) > combinedPct(SLIP[19]), true);
  check("20/10/3: combined result", [p.combined?.manualSlots, p.combined?.autoSlots, p.combined?.manual, p.combined?.auto, p.combined?.backfillNote, p.combined?.rotation.build], [3, 7, 3, 7, null, 1]);
  check("20/10/3: rotation says 17 left, next uses 3", [p.combined?.rotation.unusedLeft, p.combined?.rotation.nextUses, p.combined?.rotation.slipSize], [17, 3, 20]);
  check("20/10/3: max 1 leg per game across both pools", maxOnOneGame(p), 1);
  check("20/10/3: the 17 unused are not_selected, the slip untouched", [p.dropped.length, p.dropped.every((d) => d.reason === "not_selected"), snap.slipPicks.length], [17, true, 20]);
  check("default split (no manualSlots): half of 10 = 5", slipIds(buildGeneratedParlay(snap, settingsOf(10, undefined), null, NOW)).length, 5);
}

// ============================================================================
// Slip picks exempt from the gate, the -250 cap, Bet Types, favorites only
// ============================================================================
{
  const exempt = [
    pick({ id: "x-low", game: 0, bet: "HOME", winPct: 40 }),
    pick({ id: "x-short", game: 1, bet: "HOME", winPct: 60, odds: -400 }),
    pick({ id: "x-ml", game: 2, bet: "HOME", winPct: 62 }),
  ];
  // A generated -400 at 90% on its own game: the cap holds for auto legs.
  const capped = pick({ id: "auto-short", game: 25, bet: "UNDER", winPct: 90, odds: -400, favorite: true });
  const favOvers = AUTO.map((p) => ({ ...p, capperIsFavorite: true }));
  const snap = snapshotOf(exempt, [...favOvers, capped]);
  const s = settingsOf(6, 3, { include: ["TOTALS"], favoritesOnly: true, minWinPct: 70 });
  const p = buildGeneratedParlay(snap, s, null, NOW);
  check("exempt: below the gate, shorter than -250 and outside Bet Types all take manual slots", slipIds(p), ["x-low", "x-ml", "x-short"]);
  check("exempt: the auto half still obeys Bet Types (Totals only) and the cap", [autoIds(p).length, p.legs.filter((l) => l.source === "GENERATED").every((l) => l.pick.betType === "TOTAL"), autoIds(p).includes("auto-short")], [3, true, false]);
}

// ============================================================================
// Rotation: Generate + 7 Regenerates, 20 picks at 3 manual
// ============================================================================
async function rotation() {
  const session = createGeneratorSession({
    generate: async (req) => {
      const slip = SLIP.filter((p) => req.slipPickIds.includes(p.pickId));
      const snap = snapshotOf(slip);
      return { snapshot: snap, parlay: buildGeneratedParlay(snap, req.settings, null, NOW) };
    },
    now: () => NOW,
    firstSeed: 7,
  });
  const pool: PoolInputs = { leagues: ["MLB"], slipPickIds: SLIP.map((p) => p.pickId), targets: [] };
  const settings = settingsOf(10, 3);
  const builds: GeneratedParlay[] = [];
  const first = await session.generate(pool, settings);
  if ("error" in first) throw new Error(first.error);
  builds.push(first.parlay);
  for (let i = 0; i < 7; i++) {
    const r = await session.regenerate(pool, settings);
    if ("error" in r) throw new Error(r.error);
    builds.push(r.parlay);
  }
  const manual = builds.map(slipIds);
  check("rotation: build 1 is the top 3", manual[0], ["s18", "s19", "s20"]);
  check("rotation: builds numbered 1..8", builds.map((b) => b.combined?.rotation.build), [1, 2, 3, 4, 5, 6, 7, 8]);
  check("rotation: every build 3 manual + 7 auto", builds.map((b) => [slipIds(b).length, autoIds(b).length].join("+")), Array(8).fill("3+7"));
  const firstSix = manual.slice(0, 6).flat();
  check("rotation: builds 1-6 never repeat a slip pick (18 distinct)", new Set(firstSix).size, 18);
  check("rotation: by build 7 every one of the 20 has been used", new Set(manual.slice(0, 7).flat()).size, 20);
  check("rotation: build 7 takes the last 2 unused (s1, s2) before any repeat", manual[6].filter((id) => id === "s1" || id === "s2"), ["s1", "s2"]);
  check("rotation: build 2 takes the next best (s15-s17)", manual[1], ["s15", "s16", "s17"]);
  check("rotation: never the same manual set twice in a row", manual.every((m, i) => i === 0 || legSetKey(m) !== legSetKey(manual[i - 1])), true);
  check("rotation: the auto half changes every Regenerate", builds.every((b, i) => i === 0 || legSetKey(autoIds(b)) !== legSetKey(autoIds(builds[i - 1]))), true);
  check("rotation: every build is VARIED after the first", builds.slice(1).map((b) => b.variety), Array(7).fill("VARIED"));
  check("rotation: K left counts down 17, 14, 11, 8, 5, 2", builds.slice(0, 6).map((b) => b.combined?.rotation.unusedLeft), [17, 14, 11, 8, 5, 2]);

  // Hand swap: a manual leg swapped for an unused slip pick. The swapped-out pick is unused again.
  const shown = builds[1];
  const legIndex = shown.legs.findIndex((l) => l.source === "SLIP");
  const out = shown.legs[legIndex].pick.pickId;
  const options = session.swapOptions(shown, legIndex, settings);
  const firstOther = options.OTHER_GAMES[0];
  check("swap on a manual leg: your unused picks are offered first", [firstOther?.source, SLIP.some((p) => p.pickId === firstOther?.pick.pickId)], ["SLIP", true]);
  const firstGenerated = options.OTHER_GAMES.findIndex((o) => o.source === "GENERATED");
  const lastSlip = options.OTHER_GAMES.map((o) => o.source).lastIndexOf("SLIP");
  check("swap on a manual leg: every slip pick before any generated pick", firstGenerated === -1 || lastSlip < firstGenerated, true);
  const unusedBefore = new Set(SLIP.map((p) => p.pickId).filter((id) => !(session.rotation()?.used ?? []).includes(id)));
  const into = options.OTHER_GAMES.find((o) => o.source === "SLIP" && unusedBefore.has(o.pick.pickId))!;
  // The session's card is on the last build; swap on that one.
  const last = builds[builds.length - 1];
  const lastIdx = last.legs.findIndex((l) => l.source === "SLIP");
  const lastOut = last.legs[lastIdx].pick.pickId;
  const lastOpts = session.swapOptions(last, lastIdx, settings);
  const lastInto = lastOpts.OTHER_GAMES.find((o) => o.source === "SLIP")!;
  const swapped = session.swapLeg(last, lastIdx, lastInto.pick.pickId, settings);
  check("hand swap: applied", swapped !== null, true);
  const used = new Set(session.rotation()?.used ?? []);
  check("hand swap: the swapped-out pick is back in the unused line, the swapped-in one is used", [used.has(lastOut), used.has(lastInto.pick.pickId)], [false, true]);
  void out;
  void into;

  // A changed slip resets the rotation: the next build starts from the top.
  const smaller: PoolInputs = { ...pool, slipPickIds: pool.slipPickIds.filter((id) => id !== "s1") };
  const reset = await session.regenerate(smaller, settings);
  if ("error" in reset) throw new Error(reset.error);
  check("slip change: rotation restarts at build 1 with the top 3", [reset.parlay.combined?.rotation.build, slipIds(reset.parlay)], [1, ["s18", "s19", "s20"]]);
}

// ============================================================================
// Edge cases
// ============================================================================
{
  const three = SLIP.slice(17);
  const p = buildGeneratedParlay(snapshotOf(three), settingsOf(10, 3), null, NOW);
  check("3 picks, 10 legs, slider max 3: 3 manual + 7 auto", [slipIds(p).length, autoIds(p).length], [3, 7]);
  const over = buildGeneratedParlay(snapshotOf(three), settingsOf(10, 8), null, NOW);
  check("slider above the slip clamps to it", [over.combined?.manualSlots, slipIds(over).length, autoIds(over).length], [3, 3, 7]);
  const five = buildGeneratedParlay(snapshotOf(three), settingsOf(5, 3), null, NOW);
  check("3 picks, 5 legs, slider max: those 3 + 2 auto", [slipIds(five), autoIds(five).length], [["s18", "s19", "s20"], 2]);
}
{
  const p = buildGeneratedParlay(snapshotOf(SLIP), settingsOf(10, 0), null, NOW);
  check("slider 0: no slip picks used, 10 generated", [slipIds(p).length, autoIds(p).length, p.combined?.backfillNote], [0, 10, null]);
}
{
  // Auto pool short: favorites only with just 2 favorite candidates -> backfill from unused slip picks.
  const favTwo = AUTO.map((p, i) => ({ ...p, capperIsFavorite: i < 2 }));
  const p = buildGeneratedParlay(snapshotOf(SLIP, favTwo), settingsOf(10, 3, { favoritesOnly: true }), null, NOW);
  check("auto short: 10 legs = 3 manual + 2 auto + 5 backfilled slip picks", [p.legs.length, slipIds(p).length, autoIds(p).length], [10, 8, 2]);
  check("auto short: the note", p.combined?.backfillNote, "Generator found 2 of 7 — filled 5 from your picks");
  check("auto short: no shortfall line", p.shortfall, []);
  // Both pools exhausted.
  const tiny = buildGeneratedParlay(snapshotOf(SLIP.slice(0, 2), favTwo.slice(0, 1)), settingsOf(10, 2, { favoritesOnly: true }), null, NOW);
  check("both exhausted: short with one line", [tiny.legs.length, tiny.shortfall], [2, ["Built 2 of 10 — no other eligible picks"]]);
}
{
  // Two conflicting slip picks: s-strong (Home0 ML 74%) and s-weak (Away0 ML 72%) oppose on G0.
  const nyy: [string, string, string, string] = ["New York Yankees", "Boston Red Sox", "Yankees", "Red Sox"];
  const strong = pick({ id: "c-strong", game: 0, bet: "HOME", winPct: 74, teams: nyy });
  const weak = pick({ id: "c-weak", game: 0, bet: "AWAY", winPct: 72, teams: nyy });
  const next = pick({ id: "c-next", game: 1, bet: "HOME", winPct: 60 });
  const p = buildGeneratedParlay(snapshotOf([strong, weak, next]), settingsOf(4, 2, { maxLegsPerGame: 2 }), null, NOW);
  check("conflicting slip picks: stronger chosen, weaker skipped, next slip pick takes the slot", slipIds(p), ["c-next", "c-strong"]);
  check("conflicting slip picks: the slip is never modified", p.dropped.map((d) => d.pickId), ["c-weak"]);
}
{
  // Max legs per game 2 across both pools: a manual leg on G0 leaves room for 1 auto leg there, never 2.
  const p = buildGeneratedParlay(snapshotOf(SLIP), settingsOf(25, 20, { maxLegsPerGame: 2 }), null, NOW);
  check("max legs per game 2: never over across both pools", maxOnOneGame(p) <= 2, true);
  const p1 = buildGeneratedParlay(snapshotOf(SLIP), settingsOf(25, 20, { maxLegsPerGame: 1 }), null, NOW);
  check("max legs per game 1: 30 games -> 20 manual + 5 auto, one per game", [maxOnOneGame(p1), slipIds(p1).length, autoIds(p1).length], [1, 20, 5]);
}
{
  // An auto candidate identical to a slip pick (same bet, another capper, 95%): never generated,
  // even when its slip pick isn't one of the manual picks this time.
  const twin = pick({ id: "twin-of-s1", game: 0, bet: "HOME", winPct: 95 });
  const p = buildGeneratedParlay(snapshotOf(SLIP, [...AUTO, twin]), settingsOf(10, 3), null, NOW);
  check("identical to a slip pick: excluded from the auto pool", [autoIds(p).includes("twin-of-s1"), slipIds(p).includes("s1")], [false, false]);
  const best = buildGeneratedParlay(snapshotOf([], [...AUTO, twin]), settingsOf(10, 3), null, NOW);
  check("empty slip in Combined builds as Best available (no split)", [best.combined, best.legs.length, autoIds(best).includes("twin-of-s1")], [undefined, 10, true]);
}

void rotation().then(
  () => {
    if (failures > 0) {
      console.log(`\n${failures} FAILED`);
      process.exit(1);
    }
    console.log("\nAll Combined fill checks passed.");
  },
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
