// The Parlay Generator engine (generator.ts), proved on a synthetic MLB slate:
// Generate is deterministic, Regenerate varies without dropping below the
// gate, slip picks are always in (never gated, never filtered, conflicts
// settled by record then line), targets limit where legs come from, the leg
// cap (25) and max legs per game (5) hold, shortfalls are said, Hedge and
// Contrarian never touch a slip pick - and the engine's module graph never
// loads prisma or server/data, so Regenerate can run in the browser on the
// snapshot it already has. Pure - no DB. Run with:
//   npx tsx src/lib/parlay/generator-acceptance-test.ts
import {
  buildGeneratedParlay,
  snapshotIsStale,
  GAME_BAND,
  SNAPSHOT_MAX_AGE_MS,
  type GeneratedParlay,
  type GeneratorSettings,
  type GeneratorSnapshot,
} from "@/lib/parlay/generator";
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
// The engine runs client-side: nothing it loads may reach prisma or server/data.
// ---------------------------------------------------------------------------
{
  const loaded = Object.keys(require.cache).map((k) => k.split("\\").join("/"));
  check("module graph: the cache does hold the engine and its parlay imports", ["/src/lib/parlay/generator.ts", "/src/lib/parlay/qualification-core.ts", "/src/lib/parlay/same-game-rules.ts"].every((m) => loaded.some((k) => k.endsWith(m))), true);
  check("module graph: no lib/prisma", loaded.filter((k) => /\/src\/lib\/prisma\.ts$/.test(k)), []);
  check("module graph: no server/data module", loaded.filter((k) => /\/src\/server\//.test(k)), []);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------
const NOW = new Date("2099-06-01T12:00:00.000Z");
const START = "2099-06-01T23:00:00.000Z";
const TEAMS: [string, string, string, string][] = [
  ["New York Yankees", "Boston Red Sox", "Yankees", "Red Sox"],
  ["Toronto Blue Jays", "Tampa Bay Rays", "Blue Jays", "Rays"],
  ["Houston Astros", "Baltimore Orioles", "Astros", "Orioles"],
  ["Cleveland Guardians", "Detroit Tigers", "Guardians", "Tigers"],
  ["Seattle Mariners", "Texas Rangers", "Mariners", "Rangers"],
  ["Los Angeles Dodgers", "San Francisco Giants", "Dodgers", "Giants"],
  ["Chicago Cubs", "St. Louis Cardinals", "Cubs", "Cardinals"],
  ["Atlanta Braves", "New York Mets", "Braves", "Mets"],
];

type Spec = { id: string; game: number; bet: "HOME" | "AWAY" | "OVER" | "UNDER" | "PROP"; wl: [number, number]; line?: number; player?: string; capper?: string };

function makeSlate(specs: Spec[], start = START) {
  const categoryRecords: Record<string, CategoryBreakdownItem | null> = {};
  const leagueRecords: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };
  const byGame = new Map<number, GeneratorPick[]>();
  const picks = new Map<string, GeneratorPick>();
  for (const s of specs) {
    const [home, away, homeNick, awayNick] = TEAMS[s.game];
    const line = s.line ?? 8.5;
    const detail =
      s.bet === "HOME" ? homeNick + " ML" : s.bet === "AWAY" ? awayNick + " ML" : s.bet === "PROP" ? `${s.player} Over 1.5 Hits` : `${s.bet === "OVER" ? "Over" : "Under"} ${line}`;
    const betType = s.bet === "HOME" || s.bet === "AWAY" ? "MONEYLINE" : s.bet === "PROP" ? "PLAYER_PROP" : "TOTAL";
    const category: PickCategoryKey = s.bet === "HOME" ? "FAV_ML" : s.bet === "AWAY" ? "DOG_ML" : s.bet === "PROP" ? "TD_PROP" : s.bet;
    const capperId = s.capper ?? "cap-" + s.id;
    const [wins, losses] = s.wl;
    const winPct = (wins / (wins + losses)) * 100;
    categoryRecords[capperId + "|" + category] = { key: category, label: category, wins, losses, pushes: 0, winPct, count: wins + losses };
    leagueRecords.records[capperId + "|MLB|" + category] = {
      category,
      label: category,
      overall: { wins, losses, pushes: 0, winPct, count: wins + losses },
      league: { wins, losses, pushes: 0, winPct, count: wins + losses },
    };
    const pick = {
      pickId: s.id,
      capperId,
      capperName: "Capper " + s.id,
      capperColorTag: null,
      capperIsFavorite: false,
      category,
      leagueName: "MLB",
      gameId: "G" + s.game,
      gameLabel: away + " @ " + home,
      betDetail: detail,
      odds: -110,
      units: 1,
      status: "PENDING",
      betType,
      period: "FULL_GAME",
      rawBetDetail: detail,
      propMarket: s.bet === "PROP" ? "HITS" : null,
      line: betType === "MONEYLINE" ? null : s.bet === "PROP" ? 1.5 : line,
      homeTeam: home,
      awayTeam: away,
      gameTime: start,
      teamGroup: s.bet === "AWAY" ? "AWAY" : "HOME",
      teamLabel: "",
      teamColor: null,
      datePosted: "2099-05-31T00:00:00.000Z",
    } as GeneratorPick;
    picks.set(s.id, pick);
    byGame.set(s.game, [...(byGame.get(s.game) ?? []), pick]);
  }
  const games: GeneratorGame[] = Array.from(byGame.entries()).map(([n, ps]) => ({
    gameId: "G" + n,
    gameLabel: TEAMS[n][1] + " @ " + TEAMS[n][0],
    gameTime: start,
    leagueName: "MLB",
    picks: ps,
  }));
  return { games, picks, categoryRecords, leagueRecords };
}

const snap = (slate: ReturnType<typeof makeSlate>, slip: string[] = [], targets: string[] = []): GeneratorSnapshot => ({
  builtAt: NOW.toISOString(),
  games: slate.games,
  slipPicks: slip.map((id) => slate.picks.get(id)!),
  targets,
  leagueRecords: slate.leagueRecords,
  categoryRecords: slate.categoryRecords,
});
const SETTINGS: GeneratorSettings = { legCount: 4, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE" };
const run = (s: GeneratorSnapshot, over: Partial<GeneratorSettings> = {}, variation: { seed: number; history: string[][] } | null = null) =>
  buildGeneratedParlay(s, { ...SETTINGS, ...over }, variation, NOW);
const ids = (p: GeneratedParlay) => p.legs.map((l) => l.pick.pickId);
const generatedIds = (p: GeneratedParlay) => p.legs.filter((l) => l.source === "GENERATED").map((l) => l.pick.pickId);

// Eight games. Each home ML is its game's best leg, strength falling by game.
const BASE: Spec[] = [];
TEAMS.forEach((_, g) => {
  BASE.push({ id: `g${g}h`, game: g, bet: "HOME", wl: [70 - g * 2, 30 + g * 2] });
  BASE.push({ id: `g${g}o`, game: g, bet: "OVER", wl: [60 - g, 40 + g] });
  BASE.push({ id: `g${g}a`, game: g, bet: "AWAY", wl: [45, 55] }); // below the gate everywhere
});
const slate = makeSlate(BASE);

// ============================================================================
// Generate: deterministic, best legs, one per game, gated.
// ============================================================================
{
  const a = run(snap(slate));
  check("Generate: the 4 strongest games' best legs", generatedIds(a).sort(), ["g0h", "g1h", "g2h", "g3h"]);
  check("Generate: same inputs, same parlay", JSON.stringify(run(snap(slate))), JSON.stringify(a));
  const shuffled = makeSlate([...BASE].reverse());
  check("Generate: input order doesn't matter", ids(run(snap(shuffled))), ids(a));
  check("Generate: variety BEST, no shortfall", [a.variety, a.shortfall], ["BEST", []]);
  check("every generated leg clears 55% and carries its W-L", a.legs.every((l) => l.record !== null && l.record.winPct >= 55 && l.record.n === l.record.wins + l.record.losses), true);
  check("no leg is the sub-55% away ML", ids(run(snap(slate), { legCount: 25, maxLegsPerGame: 5 })).some((id) => id.endsWith("a")), false);
}

// ============================================================================
// Wilson: a small perfect record loses to a large good one.
// ============================================================================
{
  const s = makeSlate([
    { id: "small", game: 0, bet: "HOME", wl: [3, 0] },
    { id: "large", game: 0, bet: "OVER", wl: [60, 30] },
  ]);
  check("3-0 (100%) vs 60-30 (67%): the 60-30 is the leg", generatedIds(run(snap(s), { legCount: 1 })), ["large"]);
}

// ============================================================================
// Shortfall: never silently fewer.
// ============================================================================
{
  const s = makeSlate(BASE.filter((p) => p.game < 3));
  const r = run(snap(s), { legCount: 5 });
  check("3 qualifying games, 5 asked, max 1: 3 legs", r.legs.length, 3);
  check("...and says why, with what to change", r.shortfall, ["3 of 5 legs: only 3 games have picks that clear 55%. Raise Max legs per game to add same-game legs."]);
  const r2 = run(snap(s), { legCount: 5, maxLegsPerGame: 2 });
  check("max 2: same-game legs fill it (5 legs)", r2.legs.length, 5);
  check("...two games now SGPs, tagged", [r2.sameGameGames, r2.legs.filter((l) => l.sameGame).length], [2, 4]);
  check("capacity says the most it can supply", [r2.capacity, r2.capacityText], [6, "6 max from 3 games with qualified picks"]);
}

// ============================================================================
// Slip picks: always in, never gated, conflicts settled by record then line.
// ============================================================================
{
  const s = makeSlate([
    ...BASE,
    { id: "slipWeak", game: 5, bet: "AWAY", wl: [8, 12], capper: "weakCapper" }, // 40%: never generated, always kept as a slip pick
    { id: "over95", game: 6, bet: "OVER", wl: [30, 20], line: 9.5 },
    { id: "over85b", game: 6, bet: "OVER", wl: [12, 10], line: 8.5 },
    { id: "under95", game: 7, bet: "UNDER", wl: [11, 9], line: 9.5 },
    { id: "over95b", game: 7, bet: "OVER", wl: [20, 10], line: 9.5 },
  ]);
  const r = run(snap(s, ["slipWeak", "over95", "over85b", "under95", "over95b"]), { legCount: 6 });
  check("a 40% slip pick is in", ids(r).includes("slipWeak"), true);
  check("duplicate line: the better record stays", [ids(r).includes("over95"), ids(r).includes("over85b")], [true, false]);
  check("opposing: the better record stays", [ids(r).includes("over95b"), ids(r).includes("under95")], [true, false]);
  check("the dropped ones say why", r.dropped.map((d) => [d.pickId, d.note]).sort(), [
    ["over85b", "duplicates Capper over95 — Over 9.5 — not used"],
    ["under95", "opposes Capper over95b — Over 9.5 — not used"],
  ]);
  check("slip legs are SLIP, the rest GENERATED", [r.fromSlip, r.generated], [3, 3]);
  check("a generated leg never opposes or duplicates a slip pick on its game", r.legs.filter((l) => l.gameId === "G5").map((l) => l.pick.pickId), ["slipWeak"]);
}

// ============================================================================
// Max legs per game counts slip picks; caps 25 / 5.
// ============================================================================
{
  const props: Spec[] = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, game: 0, bet: "PROP" as const, wl: [30 + i, 20], player: `Player ${"ABCDEFGH"[i]}` }));
  const s = makeSlate([...props, { id: "slipProp", game: 0, bet: "PROP", wl: [5, 5], player: "Slip Player" }]);
  const r = run(snap(s, ["slipProp"], ["G0"]), { legCount: 25, maxLegsPerGame: 9 });
  check("max legs per game is held at 5, slip pick included", [r.legs.length, r.legs.filter((l) => l.gameId === "G0").length], [5, 5]);
  check("leg count is held at 25", run(snap(slate), { legCount: 40, maxLegsPerGame: 5 }).requested, 25);
  const two = makeSlate([...props, { id: "slipP2", game: 0, bet: "PROP", wl: [5, 5], player: "Other Slip" }, { id: "slipP3", game: 0, bet: "PROP", wl: [5, 5], player: "Third Slip" }]);
  const r2 = run(snap(two, ["slipP2", "slipP3"], ["G0"]), { legCount: 4, maxLegsPerGame: 2 });
  check("two slip picks on a game at max 2: no generated leg there", [r2.fromSlip, r2.generated], [2, 0]);
}

// ============================================================================
// Targets: legs only from targeted games plus the slip's games.
// ============================================================================
{
  const s = makeSlate([...BASE, { id: "dead", game: 7, bet: "AWAY", wl: [10, 30] } as Spec].filter((p) => !(p.game === 7 && p.id !== "dead")));
  const r = run(snap(s, ["g0h"], ["G5", "G6", "G7", "G99"]), { legCount: 5, maxLegsPerGame: 2 });
  check("targeted: generated legs come only from G5/G6 (G7 has none) plus the slip's G0", Array.from(new Set(r.legs.map((l) => l.gameId))).sort(), ["G0", "G5", "G6"]);
  check("targeted: the stronger untargeted games are never used", r.legs.some((l) => ["G1", "G2", "G3", "G4"].includes(l.gameId)), false);
  check("targeted: capacity text", r.capacityText, "5 max with 4 games targeted");
  check("targeted: a target with no qualified picks is named", r.shortfall, ["New York Mets @ Atlanta Braves: no qualified picks — 3 of 4 games used"]);
  check("targeted: a target not in the pool is reported", r.unavailableTargets, ["G99"]);
}

// ============================================================================
// Include Picks and the Pick Mix; Fill from.
// ============================================================================
{
  const s = makeSlate([...BASE, ...TEAMS.map((_, g) => ({ id: `g${g}p`, game: g, bet: "PROP" as const, wl: [58, 42] as [number, number], player: "Hitter " + "ABCDEFGH"[g] }))]);
  const r = run(snap(s, ["g0h"]), { include: ["PROPS"], legCount: 3 });
  check("Props: every generated leg is a prop", r.legs.filter((l) => l.source === "GENERATED").every((l) => l.pick.betType === "PLAYER_PROP"), true);
  check("Props: the slip's moneyline is still in", ids(r).includes("g0h"), true);
  const m = run(snap(s, ["g0h"]), { legCount: 4, mix: { MONEYLINE: 25, SPREAD: 0, TOTALS: 25, PROPS: 50 } });
  const kinds = m.legs.map((l) => (l.pick.betType === "PLAYER_PROP" ? "P" : "G")).sort().join("");
  check("mix ML 25 · Totals 25 · Props 50 of 4, slip holds a moneyline: 2 game lines + 2 props overall", kinds, "GGPP");
  const only = run(snap(s, ["g0h", "g1h"]), { legCount: 4, fillFrom: "YOUR_PICKS_ONLY" });
  check("Your picks only: just the slip, and it says so", [ids(only).sort(), only.shortfall], [["g0h", "g1h"], ["Your picks only: 2 picks in your slip. Switch Fill from to Best available to add legs."]]);
  check("Your picks only with an empty slip: Best available", run(snap(s), { legCount: 3, fillFrom: "YOUR_PICKS_ONLY" }).legs.length, 3);
}

// ============================================================================
// Regenerate: different parlays of comparable strength, never below the gate.
// ============================================================================
{
  const s = snap(slate, ["g7h"], []);
  const primary = run(s, { legCount: 4 });
  const history: string[][] = [generatedIds(primary)];
  const seen = new Set([primary.generatedKey]);
  const weakestPrimaryTop = Math.min(...primary.legs.filter((l) => l.source === "GENERATED").map((l) => l.wilsonLowerBound!));
  let allVaried = true;
  let allQualified = true;
  let allComparable = true;
  let slipEvery = true;
  for (let i = 1; i <= 5; i++) {
    const r = run(s, { legCount: 4 }, { seed: i * 101, history: [...history].reverse() });
    if (r.variety !== "VARIED" || seen.has(r.generatedKey)) allVaried = false;
    seen.add(r.generatedKey);
    history.push(generatedIds(r));
    if (!r.legs.every((l) => l.source === "SLIP" || (l.record!.winPct >= 55 && l.wilsonLowerBound! >= weakestPrimaryTop - GAME_BAND - 0.03))) allComparable = false;
    if (!r.legs.every((l) => l.source === "SLIP" || l.record!.winPct >= 55)) allQualified = false;
    if (!ids(r).includes("g7h")) slipEvery = false;
  }
  check("5 Regenerates: each differs from every parlay before it", allVaried, true);
  check("...every generated leg clears 55%", allQualified, true);
  check("...every generated leg is within the band of the Primary's weakest", allComparable, true);
  check("...the slip pick is in every one", slipEvery, true);
  check("Generate after Regenerates is the Primary again", run(s, { legCount: 4 }).generatedKey, primary.generatedKey);

  const tight = makeSlate(BASE.filter((p) => p.game < 2 && !p.id.endsWith("o")));
  const t = snap(tight);
  const tp = run(t, { legCount: 2 });
  check("pool exactly fills it: Regenerate says there is no alternative", run(t, { legCount: 2 }, { seed: 7, history: [generatedIds(tp)] }).variety, "NO_ALTERNATIVE");
}

// ============================================================================
// Games that are over (dropped), live games (kept), staleness.
// ============================================================================
{
  const early = makeSlate([{ id: "e", game: 0, bet: "HOME", wl: [30, 10] }], "2099-06-01T11:00:00.000Z");
  // The same game, with the feed saying it is final.
  const over = { ...early, picks: new Map([["e", { ...early.picks.get("e")!, gameStatus: "final" as const }]]), games: early.games.map((g) => ({ ...g, gameStatus: "final" as const })) };
  const r = buildGeneratedParlay(
    { ...snap(slate, ["g1h"]), slipPicks: [over.picks.get("e")!, slate.picks.get("g1h")!], games: [...slate.games, ...over.games] },
    { ...SETTINGS, legCount: 3 },
    null,
    NOW
  );
  check("a slip pick whose game is over is dropped, and says so", r.dropped.map((d) => [d.pickId, d.reason]), [["e", "over"]]);
  check("...a game that is over is never used", r.legs.some((l) => l.pick.pickId === "e"), false);
  for (const gameStatus of ["postponed", "cancelled"] as const) {
    const o = { ...over.picks.get("e")!, gameStatus };
    const rr = buildGeneratedParlay({ ...snap(slate, ["g1h"]), slipPicks: [o, slate.picks.get("g1h")!], games: slate.games }, { ...SETTINGS, legCount: 3 }, null, NOW);
    check(gameStatus + " slip pick: dropped as over", rr.dropped.map((d) => [d.pickId, d.reason]), [["e", "over"]]);
  }

  // LIVE: the same game with no status (kicked off an hour ago) or "live" stays in.
  for (const gameStatus of [undefined, "live" as const]) {
    const live = { ...early.picks.get("e")!, gameStatus };
    const lr = buildGeneratedParlay(
      { ...snap(slate, ["g1h"]), slipPicks: [live, slate.picks.get("g1h")!], games: [...slate.games, ...early.games.map((g) => ({ ...g, gameStatus }))] },
      { ...SETTINGS, legCount: 3 },
      null,
      NOW
    );
    check("live slip pick (" + (gameStatus ?? "no status") + "): used as a leg, not dropped", [lr.dropped.length, lr.legs.some((l) => l.pick.pickId === "e")], [0, true]);
  }
  const liveTarget = buildGeneratedParlay({ ...snap(slate, [], ["e-game"]), games: [...slate.games, { ...early.games[0], gameId: "e-game", gameStatus: "live" as const }] }, { ...SETTINGS, legCount: 1 }, null, NOW);
  check("a targeted live game is not reported unavailable", liveTarget.unavailableTargets, []);
  const overTarget = buildGeneratedParlay({ ...snap(slate, [], ["e-game"]), games: [...slate.games, { ...early.games[0], gameId: "e-game", gameStatus: "final" as const }] }, { ...SETTINGS, legCount: 1 }, null, NOW);
  check("a targeted game that is over is reported unavailable", overTarget.unavailableTargets, ["e-game"]);
  check("stale: older than 2 minutes", snapshotIsStale({ builtAt: new Date(NOW.getTime() - SNAPSHOT_MAX_AGE_MS - 1).toISOString(), games: slate.games, slipPicks: [], targets: [] }, NOW), true);
  check("fresh: built just now, nothing over", snapshotIsStale({ builtAt: NOW.toISOString(), games: slate.games, slipPicks: [], targets: [] }, NOW), false);
  check("stale: a full-slate game in it has kicked off", snapshotIsStale({ builtAt: NOW.toISOString(), games: early.games, slipPicks: [], targets: [] }, NOW), true);
  check("fresh: a live game that is targeted stays", snapshotIsStale({ builtAt: NOW.toISOString(), games: early.games, slipPicks: [], targets: [early.games[0].gameId] }, NOW), false);
  check("fresh: a live game a slip pick is on stays", snapshotIsStale({ builtAt: NOW.toISOString(), games: early.games, slipPicks: [early.picks.get("e")!], targets: [] }, NOW), false);
  check("stale: a targeted game that is now over", snapshotIsStale({ builtAt: NOW.toISOString(), games: over.games, slipPicks: [], targets: [over.games[0].gameId] }, NOW), true);
}

// ============================================================================
// Hedge / Contrarian with Swap: Suggested - generated legs only (the other
// scopes: swap-scope-acceptance-test.ts).
// ============================================================================
{
  const s = makeSlate([
    { id: "slipMl", game: 0, bet: "HOME", wl: [70, 30] },
    { id: "slipOver", game: 0, bet: "OVER", wl: [65, 35] },
    { id: "genMl", game: 1, bet: "HOME", wl: [66, 34] },
    { id: "genOver", game: 1, bet: "OVER", wl: [60, 40] },
  ]);
  const r = run(snap(s, ["slipMl"]), { legCount: 2 });
  check("parlay: the slip ML plus the best generated leg (G1 ML)", ids(r).sort(), ["genMl", "slipMl"]);
  check("Hedge: the slip pick is not swapped", r.hedge.SUGGESTED.legs.find((l) => l.original.pick.pickId === "slipMl")?.unchangedReason, "OUT_OF_SCOPE");
  check("Hedge: the generated ML swaps to its game's qualifying total (R4)", r.hedge.SUGGESTED.legs.find((l) => l.original.pick.pickId === "genMl")?.swap?.pick.pickId, "genOver");
  check("Hedge: never to a slip pick (G0's Over is unused but G0 is the slip's)", r.hedge.SUGGESTED.legs.some((l) => l.swap?.pick.pickId === "slipOver"), false);
  check("Contrarian: slip pick unchanged too", r.contrarian.SUGGESTED.legs.find((l) => l.original.pick.pickId === "slipMl")?.unchangedReason, "OUT_OF_SCOPE");
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
if (failures > 0) process.exit(1);
