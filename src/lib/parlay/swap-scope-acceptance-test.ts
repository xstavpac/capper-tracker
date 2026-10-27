// The Swap setting on Hedge and Contrarian (swap-scope.ts, generator.ts
// buildSwap): Suggested swaps only generated legs (the behavior before the
// setting), Your picks only slip legs, All any leg. Every scope comes with each
// build; the Primary is the same whichever is shown. An alternate is still
// never a slip pick or a parlay leg and never breaks a same-game rule. The
// choice is remembered per user, All by default. Pure - no DB. Run with:
//   npx tsx src/lib/parlay/swap-scope-acceptance-test.ts
import { buildGeneratedParlay, type EngineSwap, type GeneratorSettings, type GeneratorSnapshot } from "@/lib/parlay/generator";
import { inSwapScope, normalizeSwapScope, readStoredSwapScope, SWAP_SCOPE_DEFAULT, SWAP_SCOPE_OPTIONS, writeStoredSwapScope } from "@/lib/parlay/swap-scope";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { CategoryBreakdownItem, PickCategoryKey } from "@/server/data/stats";
import type { CapperLeagueRecords } from "@/server/data/picks";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const NOW = new Date("2099-06-01T12:00:00.000Z");
const START = "2099-06-01T23:00:00.000Z";
const TEAMS: [string, string, string, string][] = [
  ["New York Yankees", "Boston Red Sox", "Yankees", "Red Sox"],
  ["Toronto Blue Jays", "Tampa Bay Rays", "Blue Jays", "Rays"],
  ["Houston Astros", "Baltimore Orioles", "Astros", "Orioles"],
];

type Spec = { id: string; game: number; bet: "HOME" | "AWAY" | "OVER" | "UNDER"; wl: [number, number] };

function makeSnapshot(specs: Spec[], slip: string[]): GeneratorSnapshot {
  const categoryRecords: Record<string, CategoryBreakdownItem | null> = {};
  const leagueRecords: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };
  const byGame = new Map<number, GeneratorPick[]>();
  for (const s of specs) {
    const [home, away, homeNick, awayNick] = TEAMS[s.game];
    const detail = s.bet === "HOME" ? homeNick + " ML" : s.bet === "AWAY" ? awayNick + " ML" : s.bet === "OVER" ? "Over 8.5" : "Under 8.5";
    const category: PickCategoryKey = s.bet === "HOME" ? "FAV_ML" : s.bet === "AWAY" ? "DOG_ML" : s.bet;
    const capperId = "cap-" + s.id;
    const [wins, losses] = s.wl;
    const c = { wins, losses, pushes: 0, winPct: (wins / (wins + losses)) * 100, count: wins + losses };
    categoryRecords[capperId + "|" + category] = { key: category, label: category, ...c };
    leagueRecords.records[capperId + "|MLB|" + category] = { category, label: category, overall: c, league: c };
    const pick = {
      pickId: s.id, capperId, capperName: "Capper " + s.id, capperColorTag: null, capperIsFavorite: false, category, leagueName: "MLB",
      gameId: "G" + s.game, gameLabel: away + " @ " + home, betDetail: detail, odds: -110, units: 1, status: "PENDING",
      betType: s.bet === "OVER" || s.bet === "UNDER" ? "TOTAL" : "MONEYLINE", period: "FULL_GAME", rawBetDetail: detail, propMarket: null,
      line: s.bet === "OVER" || s.bet === "UNDER" ? 8.5 : null, homeTeam: home, awayTeam: away, gameTime: START,
      teamGroup: s.bet === "AWAY" ? "AWAY" : "HOME", teamLabel: "", teamColor: null, datePosted: "2099-05-31T00:00:00.000Z",
    } as GeneratorPick;
    byGame.set(s.game, [...(byGame.get(s.game) ?? []), pick]);
  }
  const games: GeneratorGame[] = Array.from(byGame.entries()).map(([n, picks]) => ({ gameId: "G" + n, gameLabel: TEAMS[n][1] + " @ " + TEAMS[n][0], gameTime: START, leagueName: "MLB", picks }));
  const all = games.flatMap((g) => g.picks);
  return { builtAt: NOW.toISOString(), games, slipPicks: slip.map((id) => all.find((p) => p.pickId === id)!), targets: [], leagueRecords, categoryRecords };
}

const SETTINGS: GeneratorSettings = { legCount: 2, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE" };
const view = (s: EngineSwap) => s.legs.map((l) => [l.original.pick.pickId, l.swap ? l.swap.pick.pickId : l.unchangedReason]);

// ============================================================================
// The helpers
// ============================================================================
check("labels, in order", SWAP_SCOPE_OPTIONS.map((o) => o.label), ["Suggested", "Your picks", "All"]);
check("default: All", SWAP_SCOPE_DEFAULT, "ALL");
check("normalize: known values kept, anything else is All", ["SUGGESTED", "YOUR_PICKS", "ALL", "nope", null, 3].map(normalizeSwapScope), ["SUGGESTED", "YOUR_PICKS", "ALL", "ALL", "ALL", "ALL"]);
check(
  "inSwapScope: [slip, generated] per scope",
  (["SUGGESTED", "YOUR_PICKS", "ALL"] as const).map((s) => [inSwapScope(s, "SLIP"), inSwapScope(s, "GENERATED")]),
  [[false, true], [true, false], [true, true]]
);

// Remembered per user, like the gate (a stand-in localStorage).
{
  const store = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
  };
  check("nothing stored: All", readStoredSwapScope("u1"), "ALL");
  writeStoredSwapScope("u1", "YOUR_PICKS");
  check("stored per user", [readStoredSwapScope("u1"), readStoredSwapScope("u2"), store.get("parlay-swap-scope:u1")], ["YOUR_PICKS", "ALL", "YOUR_PICKS"]);
  writeStoredSwapScope("u1", "ALL");
  check("the default is not stored", store.has("parlay-swap-scope:u1"), false);
  store.set("parlay-swap-scope:u1", "garbage");
  check("a bad stored value is All", readStoredSwapScope("u1"), "ALL");
  (globalThis as unknown as { window: unknown }).window = { get localStorage(): never { throw new Error("blocked"); } };
  check("storage unavailable: All, and writing doesn't throw", [readStoredSwapScope("u1"), (writeStoredSwapScope("u1", "SUGGESTED"), "ok")], ["ALL", "ok"]);
  delete (globalThis as unknown as { window?: unknown }).window;
}

// ============================================================================
// The engine
// ============================================================================
// G0: your pick (home ML) with an Over (Hedge) and an away ML (Contrarian) beside it,
//     and a second slip pick (the Under) that is never an alternate.
// G1: a generated leg (home ML) with its own Over and away ML.
{
  const specs: Spec[] = [
    { id: "slipMl", game: 0, bet: "HOME", wl: [70, 30] },
    { id: "g0Over", game: 0, bet: "OVER", wl: [64, 36] },
    { id: "g0Away", game: 0, bet: "AWAY", wl: [62, 38] },
    { id: "genMl", game: 1, bet: "HOME", wl: [66, 34] },
    { id: "g1Over", game: 1, bet: "OVER", wl: [60, 40] },
    { id: "g1Away", game: 1, bet: "AWAY", wl: [58, 42] },
  ];
  const snap = makeSnapshot(specs, ["slipMl"]);
  const r = buildGeneratedParlay(snap, SETTINGS, null, NOW);
  check("Primary: your pick plus one generated leg", r.legs.map((l) => [l.pick.pickId, l.source]), [["slipMl", "SLIP"], ["genMl", "GENERATED"]]);
  check("Hedge · Suggested: generated leg only (today's behavior)", view(r.hedge.SUGGESTED), [["slipMl", "OUT_OF_SCOPE"], ["genMl", "g1Over"]]);
  check("Hedge · Your picks: your pick only", view(r.hedge.YOUR_PICKS), [["slipMl", "g0Over"], ["genMl", "OUT_OF_SCOPE"]]);
  check("Hedge · All: both", view(r.hedge.ALL), [["slipMl", "g0Over"], ["genMl", "g1Over"]]);
  check("Contrarian · Suggested", view(r.contrarian.SUGGESTED), [["slipMl", "OUT_OF_SCOPE"], ["genMl", "g1Away"]]);
  check("Contrarian · Your picks", view(r.contrarian.YOUR_PICKS), [["slipMl", "g0Away"], ["genMl", "OUT_OF_SCOPE"]]);
  check("Contrarian · All", view(r.contrarian.ALL), [["slipMl", "g0Away"], ["genMl", "g1Away"]]);
  check(
    "swap counts follow the scope",
    (["SUGGESTED", "YOUR_PICKS", "ALL"] as const).map((s) => [r.hedge[s].swapCount, r.contrarian[s].swapCount]),
    [[1, 1], [1, 1], [2, 2]]
  );
  check("a swap keeps its original leg (the Primary is untouched)", r.hedge.ALL.legs.map((l) => l.original.pick.pickId), r.legs.map((l) => l.pick.pickId));

  // "Your picks only": the tabs used to be empty; now Your picks / All swap the slip.
  const mine = buildGeneratedParlay(makeSnapshot(specs, ["slipMl", "genMl"]), { ...SETTINGS, fillFrom: "YOUR_PICKS_ONLY" }, null, NOW);
  check("Fill from Your picks only: every leg is yours", mine.legs.map((l) => l.source), ["SLIP", "SLIP"]);
  check("...Suggested has nothing to swap", [mine.hedge.SUGGESTED.swapCount, mine.contrarian.SUGGESTED.swapCount], [0, 0]);
  check("...Your picks and All swap every leg", [mine.hedge.YOUR_PICKS.swapCount, mine.hedge.ALL.swapCount, mine.contrarian.ALL.swapCount], [2, 2, 2]);

  // A slip pick is never an alternate: G0's Under is in your slip, so Contrarian
  // for the ML can't take it, and Hedge for it takes the Over.
  const withUnder = makeSnapshot([...specs, { id: "slipUnder", game: 0, bet: "UNDER", wl: [90, 10] }], ["slipMl"]);
  withUnder.slipPicks.push(withUnder.games[0].picks.find((p) => p.pickId === "slipUnder")!);
  const u = buildGeneratedParlay(withUnder, { ...SETTINGS, maxLegsPerGame: 1 }, null, NOW);
  check("the second slip pick on G0 is left out (max 1 per game)", u.dropped.map((d) => [d.pickId, d.reason]), [["slipMl", "left_out"]]);
  check("...and no swap ever lands on a slip pick", [...Object.values(u.hedge), ...Object.values(u.contrarian)].flatMap((s) => s.legs).some((l) => l.swap && ["slipMl", "slipUnder"].includes(l.swap.pick.pickId)), false);
}

// Two legs on one game under All: each swap respects the other leg as it stands.
{
  const snap = makeSnapshot(
    [
      { id: "slipMl", game: 0, bet: "HOME", wl: [70, 30] },
      { id: "genOver", game: 0, bet: "OVER", wl: [68, 32] },
      { id: "g0Away", game: 0, bet: "AWAY", wl: [64, 36] },
      { id: "g0Under", game: 0, bet: "UNDER", wl: [63, 37] },
    ],
    ["slipMl"]
  );
  const r = buildGeneratedParlay(snap, { ...SETTINGS, legCount: 2, maxLegsPerGame: 2 }, null, NOW);
  check("an SGP: your ML and a generated Over", r.legs.map((l) => l.pick.pickId), ["slipMl", "genOver"]);
  const c = r.contrarian.ALL;
  check("Contrarian · All: both flipped", view(c), [["slipMl", "g0Away"], ["genOver", "g0Under"]]);
  check("...two different alternates, neither one of the parlay's own legs", [new Set(c.legs.map((l) => l.swap?.pick.pickId)).size, c.legs.some((l) => ["slipMl", "genOver"].includes(l.swap?.pick.pickId ?? ""))], [2, false]);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
