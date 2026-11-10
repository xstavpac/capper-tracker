// The Parlay Generator's "Favorites only" star (PR 2 of 3). Pure - no DB. Fixed seeds.
//   npx tsx src/lib/parlay/favorites-only-acceptance-test.ts
//
// Where the star runs (generator.ts): keepsFavorite at candidate intake, right after the Bet Types
// filter and before scoring's gate; and in buildSwap on the game's picks before Hedge and Contrarian
// rank alternates. Slip picks are never filtered. Pinned here:
//   1. Star off (absent, or false) is exactly the parlay of today, and the favorite flags are inert.
//   2. Star on: every generated leg, and every Hedge / Contrarian alternate under every Swap
//      setting, is a favorite capper's pick, over Generate + 400 Regenerates; slip picks all stay.
//   3. Fewer favorite picks than Total legs: the shorter parlay (limited); zero favorites: no legs.
//   4. The run log counts what the star removed (FILTER_FAVORITES), and still reconciles.
//   5. The request parser's normalizer: only a literal true is on. The copy and the memory.
import { readFileSync } from "node:fs";
import { buildGeneratedParlay, keepsFavorite, type EngineSwap, type GeneratedParlay, type GeneratorSettings, type GeneratorSnapshot, type Variation } from "@/lib/parlay/generator";
import { FAVORITES_EMPTY, normalizeFavoritesOnly, readStoredFavoritesOnly, writeStoredFavoritesOnly } from "@/lib/parlay/favorites-only";
import { legsNote } from "@/lib/parlay/subset-ui";
import { reconcileTrace, standardScoringVersion, TraceCollector, type RunTrace } from "@/lib/parlay/run-trace";
import { traceSettings } from "@/lib/parlay/generator-trace";
import { sanitizeClientTrace } from "@/lib/parlay/run-trace-validate";
import type { SelectionMode } from "@/lib/parlay/selection";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { CategoryBreakdownItem, PickCategoryKey } from "@/server/data/stats";
import type { CapperLeagueRecords } from "@/server/data/picks";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

// ---------------------------------------------------------------------------
// Fixture: 8 MLB games, 10 picks each (full-game and First Five sides and totals, both sides of
// each market, so Hedge (R4/R5) and Contrarian (the other side) both have alternates), each pick
// by its own capper. Favorites go by market: both sides of a market (HML/AML, O85/U85, ...) on a third of
// the (game, market) pairs - so a favorite leg can have a favorite on the other side of its bet (Contrarian).
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
type Kind = "HML" | "AML" | "HF5" | "AF5" | "HRL" | "ARL" | "O85" | "U85" | "F5O" | "F5U";
const KINDS: Kind[] = ["HML", "AML", "HF5", "AF5", "HRL", "ARL", "O85", "U85", "F5O", "F5U"];
type Shape = { betType: string; period: string; detail: string; line: number | null; category: PickCategoryKey; away: boolean };
function shape(g: number, k: Kind): Shape {
  const [, , home, away] = TEAMS[g];
  switch (k) {
    case "HML": return { betType: "MONEYLINE", period: "FULL_GAME", detail: `${home} ML`, line: null, category: "FAV_ML", away: false };
    case "AML": return { betType: "MONEYLINE", period: "FULL_GAME", detail: `${away} ML`, line: null, category: "DOG_ML", away: true };
    case "HF5": return { betType: "MONEYLINE", period: "FIRST_HALF", detail: `${home} First Five Moneyline`, line: null, category: "F5_ML", away: false };
    case "AF5": return { betType: "MONEYLINE", period: "FIRST_HALF", detail: `${away} First Five Moneyline`, line: null, category: "F5_ML", away: true };
    case "HRL": return { betType: "SPREAD", period: "FULL_GAME", detail: `${home} -1.5`, line: -1.5, category: "SPREAD_MINUS", away: false };
    case "ARL": return { betType: "SPREAD", period: "FULL_GAME", detail: `${away} +1.5`, line: 1.5, category: "SPREAD_PLUS", away: true };
    case "O85": return { betType: "TOTAL", period: "FULL_GAME", detail: `${away} ${home} Over 8.5`, line: 8.5, category: "OVER", away: false };
    case "U85": return { betType: "TOTAL", period: "FULL_GAME", detail: `${away} ${home} Under 8.5`, line: 8.5, category: "UNDER", away: false };
    case "F5O": return { betType: "TOTAL", period: "FIRST_HALF", detail: `${away} ${home} First Five Over 4.5`, line: 4.5, category: "F5_OVER", away: false };
    case "F5U": return { betType: "TOTAL", period: "FIRST_HALF", detail: `${away} ${home} First Five Under 4.5`, line: 4.5, category: "F5_UNDER", away: false };
  }
}
// Records 58% to 75% (100 decided): every pick clears the 55% default gate.
const winPctOf = (g: number, k: Kind) => 58 + ((g * 7 + KINDS.indexOf(k) * 5) % 18);
const isFav = (g: number, k: Kind) => (g + Math.floor(KINDS.indexOf(k) / 2)) % 3 === 0;

function makeSnapshot(opts: { slipIds?: string[]; favorite?: (g: number, k: Kind) => boolean } = {}): GeneratorSnapshot {
  const favorite = opts.favorite ?? isFav;
  const categoryRecords: Record<string, CategoryBreakdownItem | null> = {};
  const leagueRecords: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };
  const games: GeneratorGame[] = TEAMS.map(([home, away], g) => {
    const picks = KINDS.map((k) => {
      const s = shape(g, k);
      const id = `g${g}-${k}`;
      const capperId = "cap-" + id;
      const pct = winPctOf(g, k);
      const rec = { wins: pct, losses: 100 - pct, pushes: 0, winPct: pct, count: 100 };
      categoryRecords[capperId + "|" + s.category] = { key: s.category, label: s.category, ...rec };
      leagueRecords.records[capperId + "|MLB|" + s.category] = { category: s.category, label: s.category, overall: rec, league: rec };
      return {
        pickId: id, capperId, capperName: "Capper " + id, capperColorTag: null, capperIsFavorite: favorite(g, k), category: s.category, leagueName: "MLB",
        gameId: "G" + g, gameLabel: away + " @ " + home, betDetail: s.detail, odds: -110, oddsSource: "STATED", units: 1, status: "PENDING",
        betType: s.betType, period: s.period, rawBetDetail: s.detail, propMarket: null, line: s.line, homeTeam: home, awayTeam: away,
        gameTime: START, teamGroup: s.away ? "AWAY" : "HOME", teamLabel: "", teamColor: null, datePosted: "2099-05-31T00:00:00.000Z",
      } as GeneratorPick;
    });
    return { gameId: "G" + g, gameLabel: away + " @ " + home, gameTime: START, leagueName: "MLB", picks };
  });
  const all = games.flatMap((g) => g.picks);
  return { builtAt: NOW.toISOString(), games, slipPicks: (opts.slipIds ?? []).map((id) => all.find((p) => p.pickId === id)!), targets: [], leagueRecords, categoryRecords, propMarketRecords: {} };
}
const SLATE = makeSnapshot();
const base = (legCount: number, maxLegsPerGame = 2): GeneratorSettings => ({ legCount, maxLegsPerGame, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE" });
const on = (s: GeneratorSettings): GeneratorSettings => ({ ...s, favoritesOnly: true });
const build = (snap: GeneratorSnapshot, s: GeneratorSettings, v: Variation | null = null, trace?: TraceCollector) => buildGeneratedParlay(snap, s, v, NOW, trace);
const variations = (gen: GeneratedParlay): Variation[] =>
  (["DIVERSIFIED", "EXPLORE"] as SelectionMode[]).flatMap((mode) => Array.from({ length: 200 }, (_, i) => ({ seed: i + 1, history: [gen.historyIds], mode })));

// Every non-favorite generated leg or alternate in one build.
function offStar(p: GeneratedParlay): string[] {
  const out: string[] = [];
  for (const l of p.legs) if (l.source === "GENERATED" && !l.pick.capperIsFavorite) out.push("leg " + l.pick.pickId);
  const swaps = (label: string, s: Record<string, EngineSwap>) => {
    for (const [scope, sw] of Object.entries(s)) for (const l of sw.legs) if (l.swap && !l.swap.pick.capperIsFavorite) out.push(`${label} ${scope} ${l.swap.pick.pickId}`);
  };
  swaps("hedge", p.hedge);
  swaps("contrarian", p.contrarian);
  return out;
}
// A parlay as JSON without the picks' own favorite flag - the one field that differs between the two slates.
const unflagged = (p: GeneratedParlay) => JSON.stringify(p, (k, v) => (k === "capperIsFavorite" ? undefined : v));

// ============================================================================
// 1. Star off: today's parlay, exactly
// ============================================================================
{
  // The same slate with no favorite at all: what every build was before the flags mattered.
  const noFlags = makeSnapshot({ favorite: () => false });
  const s = base(8);
  const today = build(noFlags, s);
  const absent = build(SLATE, s);
  const explicitOff = build(SLATE, { ...s, favoritesOnly: false });
  check("star off (absent): the same parlay as a slate with no favorites - legs, Hedge, Contrarian, every field", unflagged(absent), unflagged(today));
  check("star off (false): identical to absent", JSON.stringify(explicitOff), JSON.stringify(absent));
  let same = 0;
  const vs = variations(today);
  for (const v of vs) if (unflagged(build(SLATE, s, v)) === unflagged(build(noFlags, s, v))) same++;
  check("star off: all 400 Regenerates identical with and without favorite flags", same, vs.length);
  check("star off control: the parlay does use non-favorite cappers", absent.legs.some((l) => !l.pick.capperIsFavorite), true);
  check("star off control: some Hedge or Contrarian alternate is a non-favorite (so section 2 isn't vacuous)", offStar(absent).length > 0, true);
}

// ============================================================================
// 2. Star on: favorites only, everywhere a generated pick can come from
// ============================================================================
{
  const s = on(base(8));
  const gen = build(SLATE, s);
  const bad = offStar(gen);
  let hedges = gen.hedge.ALL.swapCount;
  let contrarians = gen.contrarian.ALL.swapCount;
  for (const v of variations(gen)) {
    const p = build(SLATE, s, v);
    bad.push(...offStar(p));
    hedges += p.hedge.ALL.swapCount;
    contrarians += p.contrarian.ALL.swapCount;
  }
  console.log(`  star on: Generate ${gen.legs.length} legs · Hedge swaps ${hedges}, Contrarian swaps ${contrarians} over 401 builds (Swap = All)`);
  check("star on: zero non-favorite legs or alternates over Generate + 400 Regenerates (every Swap setting)", bad.slice(0, 5), []);
  check("star on: a full 8-leg parlay from favorites", gen.legs.length, 8);
  check("star on: Hedge found favorite alternates (not vacuous)", hedges > 0, true);
  check("star on: Contrarian found favorite alternates (not vacuous)", contrarians > 0, true);
}
{
  // Slip picks by non-favorite cappers: always in, whatever the star says.
  const slipIds = ["g0-HF5", "g1-HML", "g2-O85"];
  const snap = makeSnapshot({ slipIds });
  check("fixture: the slip picks are all non-favorites", snap.slipPicks.every((p) => !p.capperIsFavorite), true);
  const p = build(snap, on(base(8)));
  check("star on with a non-favorite slip: every slip pick is a leg", slipIds.every((id) => p.legs.some((l) => l.pick.pickId === id && l.source === "SLIP")), true);
  check("...and every generated leg is a favorite", p.legs.filter((l) => l.source === "GENERATED").every((l) => l.pick.capperIsFavorite), true);
  check("...8 legs: 3 yours, 5 generated", [p.fromSlip, p.generated], [3, 5]);
  check("...no Hedge or Contrarian alternate is a non-favorite", offStar(p), []);
}

// ============================================================================
// 3. Short and empty pools
// ============================================================================
{
  // Two favorite picks on the whole slate (two games), 6 legs asked: the 2-leg parlay, said as limited.
  const two = makeSnapshot({ favorite: (g, k) => (g === 0 && k === "HML") || (g === 3 && k === "O85") });
  const p = build(two, on(base(6, 1)));
  check("2 favorite picks, 6 legs: the 2-leg parlay", p.legs.map((l) => l.pick.pickId).sort(), ["g0-HML", "g3-O85"]);
  check("...flagged limited (the completion banner's N of M)", p.limited, { have: 2, need: 6 });
}
{
  const none = makeSnapshot({ favorite: () => false });
  const p = build(none, on(base(6)));
  check("0 favorites, no slip: no legs (the empty state)", [p.legs.length, p.generated], [0, 0]);
  const withSlip = build(makeSnapshot({ favorite: () => false, slipIds: ["g0-HML", "g1-AML"] }), on(base(6)));
  check("0 favorites with 2 slip picks: just the slip picks", withSlip.legs.map((l) => `${l.source}:${l.pick.pickId}`), ["SLIP:g0-HML", "SLIP:g1-AML"]);
  check("the empty-state copy with the star on", FAVORITES_EMPTY, "None of your favorite cappers have picks that clear these filters right now. Turn off the star, add leagues or bet types, or lower the minimum win rate.");
}

// ============================================================================
// 4. The run log
// ============================================================================
function traced(s: GeneratorSettings): RunTrace {
  const t = new TraceCollector({ mode: "STANDARD", trigger: "GENERATE", origin: "CLIENT", scoringVersion: standardScoringVersion(), settings: traceSettings({ leagues: ["MLB"], slipPickIds: [], targets: [] }, s) }, true);
  build(SLATE, s, null, t);
  return t.finish();
}
{
  const favTrace = traced(on(base(8)));
  const nonFav = SLATE.games.flatMap((g) => g.picks).filter((p) => !p.capperIsFavorite).length;
  const row = favTrace.reasons.filter((r) => r.reason === "FILTER_FAVORITES");
  check("run log, star on: FILTER_FAVORITES counts every pick the star removed", row.map((r) => [r.stage, r.count]), [["INCLUDED", nonFav]]);
  check("run log, star on: the funnel still reconciles", reconcileTrace(favTrace), []);
  check("run log, star on: the settings say favoritesOnly", favTrace.settings.favoritesOnly, true);
  const legs = (favTrace.extras as { swaps?: { legs: { excluded: Record<string, number> }[] }[] }).swaps?.flatMap((m) => m.legs) ?? [];
  check("run log, star on: Hedge / Contrarian legs count FILTER_FAVORITES", legs.length > 0 && legs.every((l) => typeof l.excluded.FILTER_FAVORITES === "number"), true);
  check("run log, star on: some swap leg had picks removed by the star", legs.some((l) => l.excluded.FILTER_FAVORITES > 0), true);
  const offTrace = traced(base(8));
  check("run log, star off: no FILTER_FAVORITES anywhere, no favoritesOnly setting", [offTrace.reasons.some((r) => r.reason === "FILTER_FAVORITES"), "favoritesOnly" in offTrace.settings, JSON.stringify(offTrace.extras).includes("FILTER_FAVORITES")], [false, false, false]);
  // The browser's copy of the trace survives the server's validator with the new counts intact.
  const clean = sanitizeClientTrace(JSON.parse(JSON.stringify(favTrace)));
  check("run log: the validator keeps FILTER_FAVORITES (reasons and swap legs)", [clean?.reasons.some((r) => r.reason === "FILTER_FAVORITES"), JSON.stringify(clean?.extras ?? {}).includes("FILTER_FAVORITES")], [true, true]);
}

// ============================================================================
// 5. Parser, copy, memory
// ============================================================================
check("normalizeFavoritesOnly: only a literal true is on", [undefined, null, false, "true", 1, {}, true].map(normalizeFavoritesOnly), [false, false, false, false, false, false, true]);
{
  // parseRequest lives in a "use server" file (async exports only); pin that it reads the field through the normalizer
  // and sends it on only when on, so a request without it is exactly today's.
  const src = readFileSync("src/server/actions/parlay-generate.ts", "utf8");
  check("parseRequest: favoritesOnly through normalizeFavoritesOnly, present only when on", src.includes("...(normalizeFavoritesOnly(s.favoritesOnly) ? { favoritesOnly: true } : {})"), true);
}
check("keepsFavorite: off keeps everyone, on keeps favorites only", [keepsFavorite(false, { capperIsFavorite: false }), keepsFavorite(true, { capperIsFavorite: false }), keepsFavorite(true, { capperIsFavorite: true })], [true, false, true]);
check(
  "Total legs helper: '... from your favorite cappers.' with the star on, unchanged off",
  [legsNote({ yourPicksOnly: false, legCount: 5, slipFloor: 2, generatedLegs: 3, usable: 2, total: 2, favoritesOnly: true }), legsNote({ yourPicksOnly: false, legCount: 5, slipFloor: 2, generatedLegs: 3, usable: 2, total: 2 })],
  ["Up to 25 · 2 from your picks, 3 from your favorite cappers.", "Up to 25 · 2 from your picks, 3 from your cappers."]
);
{
  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } };
  const before = readStoredFavoritesOnly("u1");
  writeStoredFavoritesOnly("u1", true);
  const afterOn = [readStoredFavoritesOnly("u1"), readStoredFavoritesOnly("u2")];
  writeStoredFavoritesOnly("u1", false);
  check("memory: off by default, remembered per user, cleared when off", [before, ...afterOn, readStoredFavoritesOnly("u1"), store.size], [false, true, false, false, 0]);
  delete (globalThis as { window?: unknown }).window;
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
