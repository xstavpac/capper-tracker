// Bet Types (Include Picks: All Picks / Moneyline / Spread / Totals / Props) as a regression guard on the
// engine after selection.ts (PR 5). Pure - no DB. Fixed seeds.
//   npx tsx src/lib/parlay/bet-types-filter-acceptance-test.ts
//
// Where the filter runs (generator.ts): keepsPick (include-picks.ts) at candidate intake, before scoring's
// gate and before selection.ts sees anything; and in buildSwap on the game's picks before Hedge (AUTO_HEDGE)
// and Contrarian rank alternates. Slip picks are never filtered (rules 1 and 6).
//
// For Generate and 200 Regenerate seeds in Diversified and Explore:
//   - Props only: every leg a prop, every Hedge (and Contrarian) alternate a prop;
//   - Moneyline only: the same for moneylines;
//   - Moneyline + Totals: no spread, no prop, anywhere.
// Hedge alternates are R4 (side vs total) or R5 (nested scope, same family) - the slate carries First
// Five moneylines and totals so a single-category filter still has in-filter alternates (R5) to draw.
// Also pinned: what Your picks only does with slip picks outside the selection (they are used), and the
// Props-only leg count on this, the largest props slate in the generator tests (60 props on 10 games).
import { buildGeneratedParlay, type EngineSwap, type GeneratedParlay, type GeneratorSettings, type GeneratorSnapshot, type Variation } from "@/lib/parlay/generator";
import { betCategory, type BetCategory } from "@/lib/parlay/bet-category";
import type { IncludeSelection } from "@/lib/parlay/include-picks";
import type { SelectionMode } from "@/lib/parlay/selection";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { CategoryBreakdownItem, PickCategoryKey } from "@/server/data/stats";
import type { CapperLeagueRecords, PropMarketRecord } from "@/server/data/picks";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

// ---------------------------------------------------------------------------
// Fixture: 10 MLB games, 16 picks each from 16 cappers - every category, First Five markets, and six props
// on six different players (four Hits Overs, a Total Bases Over, a pitcher's strikeouts Over).
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
  ["Philadelphia Phillies", "Miami Marlins", "Phillies", "Marlins"],
  ["San Diego Padres", "Colorado Rockies", "Padres", "Rockies"],
];
type Kind = "HML" | "AML" | "HF5" | "AF5" | "HRL" | "ARL" | "O85" | "U85" | "F5O" | "F5U" | "PH1" | "PH2" | "PH3" | "PH4" | "PTB" | "PK";
const KINDS: Kind[] = ["HML", "AML", "HF5", "AF5", "HRL", "ARL", "O85", "U85", "F5O", "F5U", "PH1", "PH2", "PH3", "PH4", "PTB", "PK"];
const SURNAMES = ["Abbott", "Barnes", "Castillo", "Duran", "Ellis", "Fuentes", "Garner", "Hayes", "Ibarra", "Jensen"];

type Shape = { betType: string; period: string; detail: string; line: number | null; category: PickCategoryKey; propMarket: string | null; away: boolean };
function shape(g: number, k: Kind): Shape {
  const [, , home, away] = TEAMS[g];
  const who = (n: string) => `${n} ${SURNAMES[g]}`;
  const prop = (detail: string, line: number, market: string): Shape => ({ betType: "PLAYER_PROP", period: "FULL_GAME", detail, line, category: "TD_PROP" as PickCategoryKey, propMarket: market, away: false });
  switch (k) {
    case "HML": return { betType: "MONEYLINE", period: "FULL_GAME", detail: `${home} ML`, line: null, category: "FAV_ML", propMarket: null, away: false };
    case "AML": return { betType: "MONEYLINE", period: "FULL_GAME", detail: `${away} ML`, line: null, category: "DOG_ML", propMarket: null, away: true };
    case "HF5": return { betType: "MONEYLINE", period: "FIRST_HALF", detail: `${home} First Five Moneyline`, line: null, category: "F5_ML", propMarket: null, away: false };
    case "AF5": return { betType: "MONEYLINE", period: "FIRST_HALF", detail: `${away} First Five Moneyline`, line: null, category: "F5_ML", propMarket: null, away: true };
    case "HRL": return { betType: "SPREAD", period: "FULL_GAME", detail: `${home} -1.5`, line: -1.5, category: "SPREAD_MINUS", propMarket: null, away: false };
    case "ARL": return { betType: "SPREAD", period: "FULL_GAME", detail: `${away} +1.5`, line: 1.5, category: "SPREAD_PLUS", propMarket: null, away: true };
    case "O85": return { betType: "TOTAL", period: "FULL_GAME", detail: `${away} ${home} Over 8.5`, line: 8.5, category: "OVER", propMarket: null, away: false };
    case "U85": return { betType: "TOTAL", period: "FULL_GAME", detail: `${away} ${home} Under 8.5`, line: 8.5, category: "UNDER", propMarket: null, away: false };
    case "F5O": return { betType: "TOTAL", period: "FIRST_HALF", detail: `${away} ${home} First Five Over 4.5`, line: 4.5, category: "F5_OVER", propMarket: null, away: false };
    case "F5U": return { betType: "TOTAL", period: "FIRST_HALF", detail: `${away} ${home} First Five Under 4.5`, line: 4.5, category: "F5_UNDER", propMarket: null, away: false };
    case "PH1": return prop(`${who("Aaron")} Over 1.5 Hits`, 1.5, "HITS");
    case "PH2": return prop(`${who("Bobby")} Over 1.5 Hits`, 1.5, "HITS");
    case "PH3": return prop(`${who("Carlos")} Over 1.5 Hits`, 1.5, "HITS");
    case "PH4": return prop(`${who("Derek")} Over 1.5 Hits`, 1.5, "HITS");
    case "PTB": return prop(`${who("Elliot")} Over 1.5 Total Bases`, 1.5, "TOTAL_BASES");
    case "PK": return prop(`${who("Frank")} Over 5.5 Strikeouts`, 5.5, "STRIKEOUTS");
  }
}
// Records 58% to 75% (100 decided), spread so strengths differ across games and markets.
const winPctOf = (g: number, k: Kind) => 58 + ((g * 7 + KINDS.indexOf(k) * 5) % 18);

function makeSnapshot(slipIds: string[] = []): GeneratorSnapshot {
  const categoryRecords: Record<string, CategoryBreakdownItem | null> = {};
  const leagueRecords: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };
  const propMarketRecords: Record<string, PropMarketRecord | null> = {};
  const games: GeneratorGame[] = TEAMS.map(([home, away], g) => {
    const picks = KINDS.map((k) => {
      const s = shape(g, k);
      const id = `g${g}-${k}`;
      const capperId = "cap-" + id;
      const pct = winPctOf(g, k);
      const rec = { wins: pct, losses: 100 - pct, pushes: 0, winPct: pct, count: 100 };
      categoryRecords[capperId + "|" + s.category] = { key: s.category, label: s.category, ...rec };
      leagueRecords.records[capperId + "|MLB|" + s.category] = { category: s.category, label: s.category, overall: rec, league: rec };
      if (s.propMarket) {
        const key = `BASEBALL:${s.propMarket}` as PropMarketRecord["key"];
        propMarketRecords[`${capperId}|MLB|${key}`] = { key, league: rec, allTime: rec };
      }
      return {
        pickId: id, capperId, capperName: "Capper " + id, capperColorTag: null, capperIsFavorite: false, category: s.category, leagueName: "MLB",
        gameId: "G" + g, gameLabel: away + " @ " + home, betDetail: s.detail, odds: -110, oddsSource: "STATED", units: 1, status: "PENDING",
        betType: s.betType, period: s.period, rawBetDetail: s.detail, propMarket: s.propMarket, line: s.line, homeTeam: home, awayTeam: away,
        gameTime: START, teamGroup: s.propMarket ? "OTHER" : s.away ? "AWAY" : "HOME", teamLabel: "", teamColor: null, datePosted: "2099-05-31T00:00:00.000Z",
      } as GeneratorPick;
    });
    return { gameId: "G" + g, gameLabel: away + " @ " + home, gameTime: START, leagueName: "MLB", picks };
  });
  const all = games.flatMap((g) => g.picks);
  return { builtAt: NOW.toISOString(), games, slipPicks: slipIds.map((id) => all.find((p) => p.pickId === id)!), targets: [], leagueRecords, categoryRecords, propMarketRecords };
}
const SLATE = makeSnapshot();
const settingsOf = (include: IncludeSelection, legCount: number, maxLegsPerGame: number, fillFrom: GeneratorSettings["fillFrom"] = "BEST_AVAILABLE"): GeneratorSettings => ({ legCount, maxLegsPerGame, include, mix: null, fillFrom });

// Every bet-type violation in one build: legs, Hedge and Contrarian alternates under every Swap setting.
function violations(p: GeneratedParlay, allowed: readonly BetCategory[], where: { slipToo: boolean }): string[] {
  const out: string[] = [];
  const bad = (pick: GeneratorPick) => {
    const c = betCategory(pick);
    return c === "UNCLASSIFIED" || !allowed.includes(c);
  };
  for (const l of p.legs) if ((where.slipToo || l.source === "GENERATED") && bad(l.pick)) out.push(`leg ${l.pick.pickId} (${betCategory(l.pick)})`);
  const swaps = (label: string, s: Record<string, EngineSwap>) => {
    for (const [scope, sw] of Object.entries(s)) for (const l of sw.legs) if (l.swap && bad(l.swap.pick)) out.push(`${label} ${scope} ${l.original.pick.pickId} -> ${l.swap.pick.pickId} (${betCategory(l.swap.pick)})`);
  };
  swaps("hedge", p.hedge);
  swaps("contrarian", p.contrarian);
  return out;
}

// Generate, then 200 Regenerate seeds per mode, against the Generate parlay as history.
type Tally = { legsGenerate: number; legsMin: number; legsMax: number; builds: number; hedges: number; contrarians: number; violations: string[] };
function sweep(snap: GeneratorSnapshot, settings: GeneratorSettings, allowed: readonly BetCategory[], slipToo = false): Tally {
  const gen = buildGeneratedParlay(snap, settings, null, NOW);
  const t: Tally = { legsGenerate: gen.legs.length, legsMin: gen.legs.length, legsMax: gen.legs.length, builds: 1, hedges: 0, contrarians: 0, violations: violations(gen, allowed, { slipToo }) };
  const count = (p: GeneratedParlay) => {
    t.hedges += p.hedge.ALL.swapCount;
    t.contrarians += p.contrarian.ALL.swapCount;
  };
  count(gen);
  for (const mode of ["DIVERSIFIED", "EXPLORE"] as SelectionMode[]) {
    for (let seed = 1; seed <= 200; seed++) {
      const v: Variation = { seed, history: [gen.historyIds], mode };
      const p = buildGeneratedParlay(snap, settings, v, NOW);
      t.builds++;
      t.legsMin = Math.min(t.legsMin, p.legs.length);
      t.legsMax = Math.max(t.legsMax, p.legs.length);
      t.violations.push(...violations(p, allowed, { slipToo }));
      count(p);
    }
  }
  return t;
}
const report = (label: string, t: Tally, requested: number) =>
  console.log(`  ${label}: ${requested} requested · Generate ${t.legsGenerate} legs · Regenerates ${t.legsMin}-${t.legsMax} legs · ${t.builds} builds · Hedge swaps ${t.hedges}, Contrarian swaps ${t.contrarians} (Swap = All) · violations ${t.violations.length}`);

// ============================================================================
// 1-2. The three filter cases
// ============================================================================
const CASES: { label: string; include: IncludeSelection; allowed: BetCategory[]; legCount: number; maxPerGame: number }[] = [
  { label: "Props only", include: ["PROPS"], allowed: ["PROPS"], legCount: 10, maxPerGame: 2 },
  { label: "Moneyline only", include: ["MONEYLINE"], allowed: ["MONEYLINE"], legCount: 10, maxPerGame: 2 },
  { label: "Moneyline + Totals", include: ["MONEYLINE", "TOTALS"], allowed: ["MONEYLINE", "TOTALS"], legCount: 10, maxPerGame: 2 },
];
const results: Record<string, Tally> = {};
for (const c of CASES) {
  const t = sweep(SLATE, settingsOf(c.include, c.legCount, c.maxPerGame), c.allowed);
  results[c.label] = t;
  report(c.label, t, c.legCount);
  check(`${c.label}: zero bet-type violations over Generate + 400 Regenerates (legs, Hedge, Contrarian, every Swap setting)`, t.violations.slice(0, 5), []);
  check(`${c.label}: every build is a full ${c.legCount}-leg parlay`, [t.legsGenerate, t.legsMin, t.legsMax], [c.legCount, c.legCount, c.legCount]);
}
// Hedge really ran under the narrow filters (a vacuous pass would prove nothing).
check("Moneyline only: Hedge found in-filter alternates (First Five moneylines, R5)", results["Moneyline only"].hedges > 0, true);
check("Moneyline + Totals: Hedge found alternates (R4 side vs total, R5)", results["Moneyline + Totals"].hedges > 0, true);
check("Props only: no Hedge alternate at all (the classifier doesn't relate props: INACTIVE)", results["Props only"].hedges, 0);
{
  // The control: under All Picks a moneyline's Hedge does reach a total (R4) - the filter is what stops it above.
  const all = buildGeneratedParlay(SLATE, settingsOf("ALL", 10, 2), null, NOW);
  const crosses = all.hedge.ALL.legs.some((l) => l.swap && betCategory(l.original.pick) === "MONEYLINE" && betCategory(l.swap.pick) === "TOTALS");
  check("control, All Picks: some moneyline's Hedge alternate is a total", crosses, true);
}

// ============================================================================
// Slip picks under a filter (Best available): the slip stays whatever the filter; generated legs and every
// alternate keep to it - a slip moneyline's Hedge under Props only is a prop or nothing.
// ============================================================================
{
  const snap = makeSnapshot(["g0-HML", "g1-O85"]);
  const t = sweep(snap, settingsOf(["PROPS"], 10, 2), ["PROPS"], false);
  report("Props only + a slip ML and Over", t, 10);
  check("Props only with slip ML + Over: generated legs and every alternate are props", t.violations.slice(0, 5), []);
  const g = buildGeneratedParlay(snap, settingsOf(["PROPS"], 10, 2), null, NOW);
  check("...the slip ML and Over are still legs (slip picks are never filtered)", ["g0-HML", "g1-O85"].every((id) => g.legs.some((l) => l.pick.pickId === id && l.source === "SLIP")), true);
}

// ============================================================================
// 3. Your picks only: slip picks outside the selected Bet Types
// ============================================================================
{
  // 12 picks on 6 games, two per game: a moneyline or spread with a total or prop. Props only, 4 legs.
  const slip = ["g0-HML", "g0-PH1", "g1-HRL", "g1-PH2", "g2-O85", "g2-PH3", "g3-AML", "g3-PTB", "g4-ARL", "g4-PK", "g5-U85", "g5-PH4"];
  const snap = makeSnapshot(slip);
  const s = settingsOf(["PROPS"], 4, 2, "YOUR_PICKS_ONLY");
  const gen = buildGeneratedParlay(snap, s, null, NOW);
  const seen = new Set<string>();
  let nonPropLegs = 0;
  let builds = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const p = buildGeneratedParlay(snap, s, { seed, history: [gen.historyIds], mode: "EXPLORE" }, NOW);
    builds++;
    for (const l of p.legs) {
      seen.add(l.pick.pickId);
      if (betCategory(l.pick) !== "PROPS") nonPropLegs++;
    }
  }
  const nonPropUsed = [...seen].filter((id) => !id.split("-")[1].startsWith("P"));
  console.log(
    `  Your picks only, Props selected, 12 slip picks (6 props, 6 game lines), 4 legs: Generate ${gen.legs.map((l) => l.pick.pickId).join(", ")}; ` +
      `over ${builds} Explore Regenerates ${nonPropLegs} legs were game lines; game lines drawn: ${nonPropUsed.join(", ") || "none"}`
  );
  check("Your picks only: Bet Types never filter the slip - game-line slip picks are drawn under Props only", nonPropUsed.length > 0, true);
  check("Your picks only: every leg is a slip pick, and Generate's 4 are the strongest regardless of type", [gen.legs.length, gen.legs.every((l) => l.source === "SLIP"), gen.generated], [4, true, 0]);
  const fewer = makeSnapshot(["g0-HML", "g1-O85", "g2-PH1"]);
  const r = buildGeneratedParlay(fewer, settingsOf(["PROPS"], 3, 2, "YOUR_PICKS_ONLY"), null, NOW);
  check("Your picks only, slip = Total legs, Props selected: every slip pick is in, the ML and Over too", r.legs.map((l) => l.pick.pickId).sort(), ["g0-HML", "g1-O85", "g2-PH1"]);
}

// ============================================================================
// 4. Props-only leg count vs Total legs on the largest props slate (60 props, 10 games, six per game)
// ============================================================================
{
  const rows: string[] = [];
  const counts: Record<string, number> = {};
  for (const maxPerGame of [1, 2, 3, 5]) {
    for (const legCount of [3, 6, 10, 15, 20]) {
      const p = buildGeneratedParlay(SLATE, settingsOf(["PROPS"], legCount, maxPerGame), null, NOW);
      counts[`${legCount}@${maxPerGame}`] = p.legs.length;
      rows.push(`${legCount}@${maxPerGame}→${p.legs.length}${p.legs.length < legCount ? ` (capacity ${p.capacity})` : ""}`);
    }
  }
  console.log(`  Props only, Total legs @ max per game → legs built: ${rows.join(" · ")}`);
  check("Props only: Total legs is met whenever max legs per game x 10 games allows it", [counts["10@1"], counts["15@2"], counts["20@2"], counts["20@3"], counts["20@5"]], [10, 15, 20, 20, 20]);
  check("Props only, max 1 per game: capped at the 10 games (15 asked -> 10)", counts["15@1"], 10);
}

console.log(failures > 0 ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures > 0 ? 1 : 0);
