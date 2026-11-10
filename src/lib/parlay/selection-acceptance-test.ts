// The selection layer (selection.ts, PR 5) through the engine (generator.ts) and the
// session (generator-session.ts). Pure - no DB. Fixed seeds throughout, except the fresh-seed check.
//   npx tsx src/lib/parlay/selection-acceptance-test.ts
//
//   1. Generate is deterministic (50 runs, Standard, Your picks only, Hedge).
//   2. Regenerate, 200 fixed seeds per mode: distinct parlays, mean rank of the chosen legs
//      (Best < Diversified < Explore), zero constraint violations in every draw.
//   3. Max legs per game 1, 2 and 5, and every opposing pair: both MLs, one team's ML + the other's
//      spread, Over + Under on one total, the same side at another line - never together; a side plus
//      a game total is allowed and does appear.
//   4. Your picks only: 20 picks, Total legs 7 - consecutive Regenerates never repeat; a slip of exactly
//      Total legs - no other parlays; a small slip - "No other parlays" exactly when every combination
//      has been shown, with the count logged; 25 picks, Total legs 12 - within the time cap and never a
//      false exhaustion; a budget that runs out - BUDGET_EXHAUSTED and a parlay that differs, never
//      "No other parlays".
//   5. Reuse penalty: a leg in recentLegs is drawn less often than without.
//   6. Hedge: Generate takes the top alternate; Regenerate draws among the gated ones.
//   7. Fresh seed: two "page loads" give different first Regenerates.
//   8. The run log: extras.selection survives sanitizeClientTrace.
import { buildGeneratedParlay, type EngineLeg, type GeneratedParlay, type GeneratorSettings, type GeneratorSnapshot, type Variation } from "@/lib/parlay/generator";
import { createGeneratorSession } from "@/lib/parlay/generator-session";
import { legSetKey } from "@/lib/parlay/parlay-set";
import { sameGameConflict } from "@/lib/parlay/same-game-rules";
import { blocks } from "@/lib/parlay/build-my-picks";
import { toBuildCandidate } from "@/lib/parlay/pool-swap";
import { toParlayCandidate, toParlayLeg } from "@/lib/parlay/qualification-core";
import { EMPTY_PLATFORM_RATES, passesGate, scorePick } from "@/lib/parlay/scoring";
import {
  betKeyOf,
  ENUMERATION_TIME_BUDGET_MS,
  enumerateCombos,
  orderCandidates,
  reuseMultiplier,
  REUSE_FLOOR,
  SELECTION_BETA,
  SELECTION_MODES,
  signatureOf,
  type SelectionMode,
  type SelectionTrace,
} from "@/lib/parlay/selection";
import { TraceCollector, type RunTrace } from "@/lib/parlay/run-trace";
import { sanitizeClientTrace } from "@/lib/parlay/run-trace-validate";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { CategoryBreakdownItem, PickCategoryKey } from "@/server/data/stats";
import type { CapperLeagueRecords } from "@/server/data/picks";

let failures = 0;
// Key-order-free JSON, for comparing objects.
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

// ---------------------------------------------------------------------------
// Fixture: MLB games, each with six picks from six cappers - home ML, away ML, the away team's
// +1.5, Over 8.5, Under 8.5 and Over 9.5 - so every opposing pair is on every game.
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
  ["Minnesota Twins", "Kansas City Royals", "Twins", "Royals"],
  ["Milwaukee Brewers", "Cincinnati Reds", "Brewers", "Reds"],
  ["Pittsburgh Pirates", "Washington Nationals", "Pirates", "Nationals"],
  ["Los Angeles Angels", "Oakland Athletics", "Angels", "Athletics"],
];
// HTT / ATT: each team's total Over - two of them, a side and a game total can all share a game, so
// max legs per game 5 binds differently from 2.
type Kind = "HML" | "AML" | "ASP" | "O85" | "U85" | "O95" | "HTT" | "ATT";
const KINDS: Kind[] = ["HML", "AML", "ASP", "O85", "U85", "O95", "HTT", "ATT"];
const kindOf = (p: { pickId: string }) => p.pickId.split("-")[1] as Kind;
const gameOf = (p: { pickId: string }) => Number(p.pickId.split("-")[0].slice(1));

function makeSnapshot(winPct: (g: number, k: Kind) => number, nGames = TEAMS.length, slipIds: string[] = []): GeneratorSnapshot {
  const categoryRecords: Record<string, CategoryBreakdownItem | null> = {};
  const leagueRecords: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };
  const games: GeneratorGame[] = [];
  for (let g = 0; g < nGames; g++) {
    const [home, away, homeNick, awayNick] = TEAMS[g];
    const picks = KINDS.map((k) => {
      const id = `g${g}-${k}`;
      const pct = winPct(g, k);
      const detail = { HML: homeNick + " ML", AML: awayNick + " ML", ASP: awayNick + " +1.5", O85: "Over 8.5", U85: "Under 8.5", O95: "Over 9.5", HTT: homeNick + " team total over 4.5", ATT: awayNick + " team total over 3.5" }[k];
      const betType = k === "HML" || k === "AML" ? "MONEYLINE" : k === "ASP" ? "SPREAD" : k === "HTT" || k === "ATT" ? "TEAM_TOTAL" : "TOTAL";
      const category = (k === "HML" ? "FAV_ML" : k === "AML" ? "DOG_ML" : k === "ASP" ? "SPREAD_PLUS" : k === "U85" ? "UNDER" : k === "HTT" || k === "ATT" ? "TEAM_TOTAL" : "OVER") as PickCategoryKey;
      const line = k === "ASP" ? 1.5 : k === "O95" ? 9.5 : k === "HTT" ? 4.5 : k === "ATT" ? 3.5 : betType === "TOTAL" ? 8.5 : null;
      const capperId = "cap-" + id;
      const rec = { wins: pct, losses: 100 - pct, pushes: 0, winPct: pct, count: 100 };
      categoryRecords[capperId + "|" + category] = { key: category, label: category, ...rec };
      leagueRecords.records[capperId + "|MLB|" + category] = { category, label: category, overall: rec, league: rec };
      return {
        pickId: id, capperId, capperName: "Capper " + id, capperColorTag: null, capperIsFavorite: false, category, leagueName: "MLB",
        gameId: "G" + g, gameLabel: away + " @ " + home, betDetail: detail, odds: -110, oddsSource: "STATED", units: 1, status: "PENDING", betType, period: "FULL_GAME",
        rawBetDetail: detail, propMarket: null, line, homeTeam: home, awayTeam: away, gameTime: START,
        teamGroup: k === "AML" || k === "ASP" || k === "ATT" ? "AWAY" : "HOME", teamLabel: "", teamColor: null, datePosted: "2099-05-31T00:00:00.000Z",
      } as GeneratorPick;
    });
    games.push({ gameId: "G" + g, gameLabel: away + " @ " + home, gameTime: START, leagueName: "MLB", picks });
  }
  const all = games.flatMap((g) => g.picks);
  return { builtAt: NOW.toISOString(), games, slipPicks: slipIds.map((id) => all.find((p) => p.pickId === id)!), targets: [], leagueRecords, categoryRecords };
}
// Records 58% to 75%, spread so each game's legs differ in strength.
const spread = (g: number, k: Kind) => 58 + ((g * 7 + KINDS.indexOf(k) * 11) % 18);
const SLATE = makeSnapshot(spread);
const settingsOf = (legCount: number, maxLegsPerGame: number, fillFrom: GeneratorSettings["fillFrom"] = "BEST_AVAILABLE"): GeneratorSettings => ({ legCount, maxLegsPerGame, include: "ALL", mix: null, fillFrom });
const ids = (p: GeneratedParlay) => p.legs.map((l) => l.pick.pickId);

function run(snap: GeneratorSnapshot, settings: GeneratorSettings, variation: Variation | null): { p: GeneratedParlay; sel: SelectionTrace; trace: RunTrace } {
  const t = new TraceCollector({ mode: settings.fillFrom === "YOUR_PICKS_ONLY" ? "YOUR_PICKS" : "STANDARD", trigger: variation ? "REGENERATE" : "GENERATE", origin: "CLIENT", scoringVersion: "test", settings: {} }, false);
  const p = buildGeneratedParlay(snap, settings, variation, NOW, t);
  const trace = t.finish();
  return { p, sel: trace.extras.selection!, trace };
}

// ---------------------------------------------------------------------------
// The constraint audit, applied to every parlay any check below builds.
// ---------------------------------------------------------------------------
const asC = (p: GeneratorPick) => toParlayCandidate(toParlayLeg(p));
// The pairs the brief names: both MLs, one team's ML + the other team's spread, Over + Under on one
// total (either line), the same side at another line.
function namedOpposing(a: GeneratorPick, b: GeneratorPick): boolean {
  if (a.gameId !== b.gameId) return false;
  const pair = [kindOf(a), kindOf(b)].sort().join("+");
  return ["AML+HML", "ASP+HML", "O85+U85", "O95+U85", "O85+O95"].includes(pair);
}
type Violation = string;
function audit(p: GeneratedParlay, cap: number, rule: "STANDARD" | "SUBSET", gate = 55): Violation[] {
  const out: Violation[] = [];
  const legs = p.legs;
  const keys = legs.map((l) => betKeyOf(l.pick));
  if (new Set(keys).size !== keys.length) out.push("betKey duplicate");
  const perGame = new Map<string, number>();
  for (const l of legs) perGame.set(l.gameId, (perGame.get(l.gameId) ?? 0) + 1);
  if (Math.max(0, ...perGame.values()) > cap) out.push("over max legs per game");
  for (let i = 0; i < legs.length; i++)
    for (let j = i + 1; j < legs.length; j++) {
      const a = legs[i].pick;
      const b = legs[j].pick;
      if (a.gameId !== b.gameId) continue;
      if (namedOpposing(a, b)) out.push(`opposing ${a.pickId} + ${b.pickId}`);
      if (rule === "STANDARD" && sameGameConflict(asC(a), asC(b)) !== null) out.push(`same-game rule ${a.pickId} + ${b.pickId}`);
      if (rule === "SUBSET" && (blocks(toBuildCandidate(a), toBuildCandidate(b)).blocked || blocks(toBuildCandidate(b), toBuildCandidate(a)).blocked)) out.push(`blocks ${a.pickId} + ${b.pickId}`);
    }
  if (rule === "STANDARD") {
    const snap = SLATE;
    const ctx = { leagueRecords: snap.leagueRecords, categoryRecords: snap.categoryRecords, platformRates: EMPTY_PLATFORM_RATES, minWinPct: gate };
    for (const l of legs) if (l.source === "GENERATED" && !passesGate(scorePick(l.pick, ctx), gate)) out.push(`below gate ${l.pick.pickId}`);
  }
  return out;
}
const sideAndTotal = (legs: EngineLeg[]) => legs.some((a) => legs.some((b) => a.gameId === b.gameId && ["HML", "AML", "ASP"].includes(kindOf(a.pick)) && ["O85", "U85", "O95"].includes(kindOf(b.pick))));

// ============================================================================
// 1. Generate is deterministic
// ============================================================================
{
  const s = settingsOf(8, 2);
  const first = JSON.stringify(buildGeneratedParlay(SLATE, s, null, NOW));
  let same = 0;
  for (let i = 0; i < 50; i++) if (JSON.stringify(buildGeneratedParlay(SLATE, s, null, NOW)) === first) same++;
  check("Generate x50 (Standard, 8 legs, 2 per game, with Hedge and Contrarian): identical every run", same, 50);
  const slip = makeSnapshot(spread, TEAMS.length, SLATE.games.slice(0, 4).flatMap((g) => g.picks.map((p) => p.pickId)).slice(0, 20));
  const ys = settingsOf(7, 2, "YOUR_PICKS_ONLY");
  const firstY = JSON.stringify(buildGeneratedParlay(slip, ys, null, NOW));
  let sameY = 0;
  for (let i = 0; i < 50; i++) if (JSON.stringify(buildGeneratedParlay(slip, ys, null, NOW)) === firstY) sameY++;
  check("Generate x50 (Your picks only, 7 of 20): identical every run", sameY, 50);
  // The order: score descending, then betKey, then pick id - shuffled input, same order.
  const cands = [
    { item: 1, id: "b", betKey: "k2", gameId: "G", score: 5 },
    { item: 2, id: "a", betKey: "k2", gameId: "G", score: 5 },
    { item: 3, id: "c", betKey: "k1", gameId: "G", score: 5 },
    { item: 4, id: "d", betKey: "k0", gameId: "G", score: 9 },
  ];
  check("ties: score, then betKey, then pick id, whatever the input order", [orderCandidates(cands, null), orderCandidates([...cands].reverse(), null)].map((o) => o.map((r) => r.id).join("")), ["dcab", "dcab"]);
}

// ============================================================================
// 2 + 3. Regenerate, 200 fixed seeds per mode, and the constraint audit at max legs per game 1 / 2 / 5
// ============================================================================
const distribution: Record<string, { distinct: number; meanRank: number; violations: number; sideTotal: number }> = {};
for (const cap of [1, 2, 5]) {
  // More legs than games at 2 and 5 per game, so the same-game pass runs.
  const s = settingsOf(cap === 1 ? 8 : 18, cap);
  const gen = run(SLATE, s, null);
  check(`max ${cap} per game · Generate: ${s.legCount} legs and no violation`, [gen.p.legs.length, audit(gen.p, cap, "STANDARD")], [s.legCount, []]);
  for (const mode of SELECTION_MODES) {
    const keys = new Set<string>();
    let rankSum = 0;
    let rankN = 0;
    const violations: string[] = [];
    let sideTotal = 0;
    let short = 0;
    let maxOnGame = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const r = run(SLATE, s, { seed, history: [gen.p.historyIds], mode });
      keys.add(r.p.generatedKey);
      for (const l of r.sel.legs) {
        rankSum += l.rank;
        rankN++;
      }
      violations.push(...audit(r.p, cap, "STANDARD"));
      if (sideAndTotal(r.p.legs)) sideTotal++;
      if (r.p.legs.length !== s.legCount) short++;
      for (const g of new Set(r.p.legs.map((l) => l.gameId))) maxOnGame = Math.max(maxOnGame, r.p.legs.filter((l) => l.gameId === g).length);
    }
    distribution[`${cap}/${mode}`] = { distinct: keys.size, meanRank: rankSum / rankN, violations: violations.length, sideTotal };
    check(`max ${cap} per game · ${mode}: 200 draws, zero constraint violations`, violations.slice(0, 3), []);
    check(`max ${cap} per game · ${mode}: every draw is a full ${s.legCount}-leg parlay`, short, 0);
    if (cap > 1) check(`max ${cap} per game · ${mode}: a side plus a game total on one game is allowed and appears`, sideTotal > 0, true);
    if (cap === 5) check(`max 5 per game · ${mode}: some game carries more than 2 legs (the cap is not 2 in disguise)`, maxOnGame > 2, true);
  }
  const [b, d, e] = SELECTION_MODES.map((m) => distribution[`${cap}/${m}`]);
  console.log(`  max ${cap} per game, ${s.legCount} legs, 200 seeds: ` + SELECTION_MODES.map((m) => `${m} ${distribution[`${cap}/${m}`].distinct} distinct, mean rank ${distribution[`${cap}/${m}`].meanRank.toFixed(2)}`).join(" · "));
  check(`max ${cap} per game · mean rank of chosen legs: Best < Diversified < Explore`, b.meanRank < d.meanRank && d.meanRank < e.meanRank, true);
  check(`max ${cap} per game · distinct parlays: Best <= Diversified <= Explore`, b.distinct <= d.distinct && d.distinct <= e.distinct, true);
}
check("betas: Best > Diversified > Explore > 0", SELECTION_BETA.BEST > SELECTION_BETA.DIVERSIFIED && SELECTION_BETA.DIVERSIFIED > SELECTION_BETA.EXPLORE && SELECTION_BETA.EXPLORE > 0, true);

// ============================================================================
// 4. Your picks only
// ============================================================================
// 20 picks on 10 games, two per game: every named opposing pair, plus sides with totals.
const PAIRS: [Kind, Kind][] = [["HML", "AML"], ["HML", "ASP"], ["O85", "U85"], ["O85", "O95"], ["U85", "O95"], ["HML", "O85"], ["AML", "U85"], ["ASP", "O95"], ["HML", "U85"], ["AML", "O85"]];
const twentyIds = PAIRS.flatMap(([a, b], g) => [`g${g}-${a}`, `g${g}-${b}`]);
const TWENTY = makeSnapshot(spread, TEAMS.length, twentyIds);
const pool = (snap: GeneratorSnapshot) => ({ leagues: ["MLB"], slipPickIds: snap.slipPicks.map((p) => p.pickId), targets: [] });
const sessionOn = (snap: GeneratorSnapshot, firstSeed?: number, mode?: SelectionMode, onTrace?: (t: RunTrace) => void) =>
  createGeneratorSession({ generate: async (req) => ({ snapshot: snap, parlay: buildGeneratedParlay(snap, req.settings, null, NOW) }), now: () => NOW, ...(firstSeed !== undefined ? { firstSeed } : {}), ...(mode ? { mode } : {}), ...(onTrace ? { onTrace } : {}) });

async function yourPicks() {
  for (const cap of [1, 2, 5]) {
    const settings = settingsOf(7, cap, "YOUR_PICKS_ONLY");
    const session = sessionOn(TWENTY, 1000 + cap);
    const g = await session.generate(pool(TWENTY), settings);
    if ("error" in g) throw new Error(g.error);
    const seen = new Set([g.parlay.generatedKey]);
    let repeats = 0;
    let notVaried = 0;
    const violations: string[] = [];
    let sideTotal = 0;
    const N = 100;
    for (let i = 0; i < N; i++) {
      const r = await session.regenerate(pool(TWENTY), settings);
      if ("error" in r) throw new Error(r.error);
      if (r.parlay.variety !== "VARIED" || r.parlay.legs.length !== 7) notVaried++;
      if (seen.has(r.parlay.generatedKey)) repeats++;
      seen.add(r.parlay.generatedKey);
      violations.push(...audit(r.parlay, cap, "SUBSET"));
      if (sideAndTotal(r.parlay.legs)) sideTotal++;
    }
    console.log(`  Your picks only, 20 picks, 7 legs, max ${cap} per game: Generate + ${N} Regenerates = ${seen.size} distinct`);
    check(`Your picks only · max ${cap} per game: ${N} consecutive Regenerates, each VARIED with 7 legs`, notVaried, 0);
    check(`Your picks only · max ${cap} per game: no combination repeated on the card`, repeats, 0);
    check(`Your picks only · max ${cap} per game: zero violations (blocks(), the named pairs, betKey, the cap)`, violations.slice(0, 3), []);
    if (cap > 1) check(`Your picks only · max ${cap} per game: a side plus a total on one game appears`, sideTotal > 0, true);
  }

  // Exactly Total legs: nothing to vary.
  const sevenIds = [0, 1, 2, 3, 4, 5, 6].map((g) => `g${g}-HML`);
  const SEVEN = makeSnapshot(spread, TEAMS.length, sevenIds);
  const s7 = settingsOf(7, 1, "YOUR_PICKS_ONLY");
  const sess7 = sessionOn(SEVEN, 7);
  await sess7.generate(pool(SEVEN), s7);
  const r7 = await sess7.regenerate(pool(SEVEN), s7);
  check("slip of exactly Total legs (7 of 7): Regenerate is NO_ALTERNATIVE (every pick is already in)", "error" in r7 ? r7.error : [r7.parlay.variety, r7.parlay.noAlternativeReason], ["NO_ALTERNATIVE", "ALL_PICKS_USED"]);

  // A small slip: 8 picks on 8 games, 7 legs - 8 combinations. "No other parlays" exactly after all 8.
  const eightIds = [0, 1, 2, 3, 4, 5, 6, 7].map((g) => `g${g}-HML`);
  const EIGHT = makeSnapshot(spread, TEAMS.length, eightIds);
  const traces: RunTrace[] = [];
  const sess8 = sessionOn(EIGHT, 8, undefined, (t) => traces.push(t));
  const g8 = await sess8.generate(pool(EIGHT), s7);
  if ("error" in g8) throw new Error(g8.error);
  const keys8 = new Set([g8.parlay.generatedKey]);
  const varieties: string[] = [];
  for (let i = 0; i < 8; i++) {
    const r = await sess8.regenerate(pool(EIGHT), s7);
    if ("error" in r) throw new Error(r.error);
    varieties.push(r.parlay.variety);
    if (r.parlay.variety === "VARIED") keys8.add(r.parlay.generatedKey);
  }
  check("8 picks, 7 legs: 7 Regenerates VARIED (all 8 combinations shown), the 8th NO_ALTERNATIVE", [varieties, keys8.size], [[...Array(7).fill("VARIED"), "NO_ALTERNATIVE"], 8]);
  const last = traces[traces.length - 1].extras.selection!;
  check("...the exhaustion is logged with the count of valid combinations", [last.exhausted, last.combos, last.budgetExhausted ?? false], [true, 8, false]);

  // 25 picks, Total legs 12: within the cap, never a false exhaustion.
  const t25Ids = SLATE.games.slice(0, 13).flatMap((g) => [g.picks[0].pickId, g.picks[3].pickId]).slice(0, 25); // home ML + Over 8.5 per game
  const T25 = makeSnapshot(spread, TEAMS.length, t25Ids);
  const s12 = settingsOf(12, 2, "YOUR_PICKS_ONLY");
  const sess25 = sessionOn(T25, 25);
  const g25 = await sess25.generate(pool(T25), s12);
  if ("error" in g25) throw new Error(g25.error);
  let slowest = 0;
  let falseExhaustion = 0;
  for (let i = 0; i < 30; i++) {
    const t0 = performance.now();
    const r = await sess25.regenerate(pool(T25), s12);
    slowest = Math.max(slowest, performance.now() - t0);
    if ("error" in r || r.parlay.variety !== "VARIED") falseExhaustion++;
  }
  console.log(`  25 picks, 12 legs: 30 Regenerates, slowest ${slowest.toFixed(1)} ms (whole build, Hedge and Contrarian included)`);
  check("25 picks, 12 legs: 30 Regenerates, never a false 'No other parlays'", falseExhaustion, 0);
  // The enumeration itself under the real budget, forced deep: the first 20,000 combinations in its own order are
  // marked shown. It must stop within the time cap (plus timer slack) and either find an unseen one or say
  // BUDGET_EXHAUSTED - never "complete" with nothing unseen, which would be false.
  const cands25 = T25.slipPicks.map((p) => {
    const s = scorePick(p, { leagueRecords: T25.leagueRecords, categoryRecords: T25.categoryRecords, platformRates: EMPTY_PLATFORM_RATES, minWinPct: 55 });
    return { item: p, id: p.pickId, betKey: betKeyOf(p), gameId: p.gameId, score: s.status === "SCORED" ? s.rankScore * 100 : -100 };
  });
  const base25 = orderCandidates(cands25, null);
  // The conflict pairs worked out once, as the engine does.
  const blocked25 = new Set<string>();
  for (const a of T25.slipPicks) for (const b of T25.slipPicks) if (a !== b && a.gameId === b.gameId && blocks(toBuildCandidate(a), toBuildCandidate(b)).blocked) blocked25.add(a.pickId + "|" + b.pickId);
  const rules25 = { maxPerGame: 2, legOf: (p: GeneratorPick) => p, conflict: (a: GeneratorPick, b: GeneratorPick) => blocked25.has(a.pickId + "|" + b.pickId) || blocked25.has(b.pickId + "|" + a.pickId) };
  // The first 20,000 combinations in the enumeration's own order: a seen-set that records each one and calls it seen.
  const firstMany = new Set<string>();
  const recorder = { has: (sig: string) => (firstMany.size < 20_000 && firstMany.add(sig), true) } as unknown as ReadonlySet<string>;
  enumerateCombos(base25, rules25, 12, recorder, null, { nodes: 1e9, ms: 1e9 });
  const t1 = performance.now();
  const deep = enumerateCombos(base25, rules25, 12, firstMany, null);
  const took = performance.now() - t1;
  console.log(`  enumeration, ${firstMany.size} combinations marked shown: ${took.toFixed(1)} ms, ${deep.nodes} nodes, found=${deep.found !== null}, budgetExhausted=${deep.budgetExhausted}`);
  check(`enumeration with ${firstMany.size} shown: returns within the ${ENUMERATION_TIME_BUDGET_MS} ms cap (+15 ms timer slack)`, took <= ENUMERATION_TIME_BUDGET_MS + 15, true);
  check("enumeration with many shown: finds an unseen combination or says BUDGET_EXHAUSTED, never a false 'complete'", deep.complete, false);

  // A budget that runs out: BUDGET_EXHAUSTED, and a parlay that differs from the one on screen.
  // 12 dominant picks (95%) and 13 weak (58%) under Best: every draw is Generate's, so the enumeration runs, on 1 node.
  const DOM = makeSnapshot((g, k) => (k === "HML" && g < 12 ? 95 : 58), TEAMS.length, t25Ids);
  const gd = run(DOM, s12, null);
  const rd = run(DOM, s12, { seed: 5, history: [gd.p.historyIds], mode: "BEST", enumerationBudget: { nodes: 1 } });
  check("budget runs out: VARIED (never 'No other parlays'), 12 legs, differs from the parlay on screen", [rd.p.variety, rd.p.legs.length, rd.p.generatedKey !== gd.p.generatedKey], ["VARIED", 12, true]);
  check("...and the trace says BUDGET_EXHAUSTED", [rd.sel.budgetExhausted, rd.sel.exhausted ?? false, (rd.trace.extras.notes ?? []).includes("selection:BUDGET_EXHAUSTED")], [true, false, true]);
  check("...with no violation", audit(rd.p, 2, "SUBSET"), []);
}

// ============================================================================
// 5. Reuse penalty
// ============================================================================
function reuse() {
  const s = settingsOf(8, 2);
  const gen = run(SLATE, s, null);
  // A leg drawn in about half of the Diversified draws: the penalty has room to show.
  const counts = new Map<string, number>();
  for (let seed = 1; seed <= 200; seed++) for (const id of ids(run(SLATE, s, { seed, history: [gen.p.historyIds] }).p)) counts.set(id, (counts.get(id) ?? 0) + 1);
  const [target] = [...counts.entries()].sort((a, b) => Math.abs(a[1] - 100) - Math.abs(b[1] - 100))[0];
  const pick = SLATE.games.flatMap((g) => g.picks).find((p) => p.pickId === target)!;
  const recentLegs = [{ betKey: betKeyOf(pick), at: NOW.getTime() }];
  let withPenalty = 0;
  let hits = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const r = run(SLATE, s, { seed, history: [gen.p.historyIds], recentLegs });
    if (ids(r.p).includes(target)) withPenalty++;
    hits += r.sel.reuseHits;
  }
  console.log(`  reuse penalty: ${target} drawn ${counts.get(target)}/200 without, ${withPenalty}/200 with it in recentLegs`);
  check("reuse penalty: a leg in recentLegs is drawn less often than without", withPenalty < counts.get(target)!, true);
  check("reuse penalty: the run log counts the hits", hits, withPenalty);
  check("reuse multiplier: just shown = floor, 12 h later halfway back, none = 1", [reuseMultiplier("k", [{ betKey: "k", at: 0 }], 0), reuseMultiplier("k", [{ betKey: "k", at: 0 }], 12 * 3600_000), reuseMultiplier("x", [{ betKey: "k", at: 0 }], 0)], [REUSE_FLOOR, 1 - (1 - REUSE_FLOOR) / 2, 1]);
}

// ============================================================================
// 6. Hedge
// ============================================================================
function hedge() {
  const s = settingsOf(8, 1);
  const gen = run(SLATE, s, null);
  const once = JSON.stringify(gen.p.hedge);
  check("Hedge on Generate: identical over 20 runs", Array.from({ length: 20 }, () => JSON.stringify(run(SLATE, s, null).p.hedge) === once).every(Boolean), true);
  // For the same Primary, Regenerate's Hedge draws among the gated alternates (one seed per leg).
  const primary = gen.p.historyIds;
  const kept: Record<string, string> = {};
  for (const mode of ["BEST", "EXPLORE"] as const) {
  const alts = new Map<string, Set<string>>();
  let badHedge = 0;
  let sameAsGenerate = 0;
  let compared = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const r = run(SLATE, s, { seed, history: [primary], mode });
    for (const l of r.p.hedge.ALL.legs) {
      if (!l.swap) continue;
      const set = alts.get(l.original.pick.pickId) ?? new Set();
      set.add(l.swap.pick.pickId);
      alts.set(l.original.pick.pickId, set);
      const ctx = { leagueRecords: SLATE.leagueRecords, categoryRecords: SLATE.categoryRecords, platformRates: EMPTY_PLATFORM_RATES, minWinPct: 55 };
      if (!passesGate(scorePick(l.swap.pick, ctx), 55)) badHedge++;
      const g = gen.p.hedge.ALL.legs.find((x) => x.original.pick.pickId === l.original.pick.pickId);
      if (g?.swap) {
        compared++;
        if (g.swap.pick.pickId === l.swap.pick.pickId) sameAsGenerate++;
      }
    }
  }
  const multi = [...alts.values()].filter((v) => v.size > 1).length;
  console.log(`  Hedge, ${mode}, 200 seeds: ${alts.size} legs hedged, ${multi} drew more than one alternate; Generate's alternate kept ${sameAsGenerate}/${compared}`);
  kept[mode] = `${sameAsGenerate}/${compared}`;
  check(`Hedge on Regenerate (${mode}): every alternate drawn clears the gate`, badHedge, 0);
  if (mode === "BEST") check("Hedge on Regenerate (Best): Generate's (top) alternate is kept most of the time", sameAsGenerate * 2 > compared, true);
  else check("Hedge on Regenerate (Explore): some leg draws more than one alternate across seeds", multi > 0, true);
  }
  const share = (k: string) => Number(kept[k].split("/")[0]) / Number(kept[k].split("/")[1]);
  check("Hedge: Best keeps the top alternate more often than Explore", share("BEST") > share("EXPLORE"), true);
}

// ============================================================================
// 7. Fresh seed per page load, and 8. the run log
// ============================================================================
async function freshSeedAndLog() {
  const s = settingsOf(8, 2);
  const firstRegen = async () => {
    const traces: RunTrace[] = [];
    const session = sessionOn(SLATE, undefined, "EXPLORE", (t) => traces.push(t));
    await session.generate(pool(SLATE), s);
    const r = await session.regenerate(pool(SLATE), s);
    if ("error" in r) throw new Error(r.error);
    return { key: r.parlay.generatedKey, seed: traces[traces.length - 1].extras.selection!.seed };
  };
  const a = await firstRegen();
  const b = await firstRegen();
  console.log(`  two page loads: first Regenerate seeds ${a.seed} and ${b.seed}`);
  check("fresh seed: two page loads draw with different seeds", a.seed !== b.seed, true);
  check("fresh seed: ...and give different first Regenerates", a.key !== b.key, true);
  const fixedA = await (async () => {
    const sess = sessionOn(SLATE, 41);
    await sess.generate(pool(SLATE), s);
    const r = await sess.regenerate(pool(SLATE), s);
    return "error" in r ? null : r.parlay.generatedKey;
  })();
  const fixedB = await (async () => {
    const sess = sessionOn(SLATE, 41);
    await sess.generate(pool(SLATE), s);
    const r = await sess.regenerate(pool(SLATE), s);
    return "error" in r ? null : r.parlay.generatedKey;
  })();
  check("a fixed firstSeed (tests) still replays exactly", fixedA, fixedB);

  // The run log: extras.selection through the client intake.
  const traces: RunTrace[] = [];
  const session = sessionOn(SLATE, 3, undefined, (t) => traces.push(t));
  await session.generate(pool(SLATE), s);
  await session.regenerate(pool(SLATE), s);
  const regen = traces[traces.length - 1];
  const sel = regen.extras.selection!;
  check("run log: Regenerate records mode, beta, seed and each leg's rank and weight", [sel.trigger, sel.mode, sel.beta, typeof sel.seed, sel.legs.length, sel.legs.every((l) => l.rank >= 1 && l.weight > 0 && l.weight <= 1)], ["REGENERATE", "DIVERSIFIED", SELECTION_BETA.DIVERSIFIED, "number", 8, true]);
  check("run log: the session's last parlay's legs were weighed down (reuse hits counted)", typeof sel.reuseHits, "number");
  const clean = sanitizeClientTrace(JSON.parse(JSON.stringify(regen)));
  check("run log: extras.selection survives sanitizeClientTrace unchanged", canon(clean?.extras.selection), canon(sel));
  const hostile = sanitizeClientTrace({ ...JSON.parse(JSON.stringify(regen)), extras: { selection: { trigger: "REGENERATE", mode: "LOUD", beta: 1e9, seed: -1, reuseHits: 1, legs: [{ id: "x", rank: 1, weight: 7 }, { id: "y", rank: 2, weight: 0.5 }] } } });
  check("run log: the intake drops what doesn't fit (unknown mode, out-of-range beta / seed / weight)", canon(hostile?.extras.selection), canon( { trigger: "REGENERATE", mode: null, beta: null, seed: null, legs: [{ id: "y", rank: 2, weight: 0.5 }], reuseHits: 1 }));
  const gen = run(SLATE, s, null).sel;
  check("run log: Generate records ranks with no mode, beta or seed", [gen.trigger, gen.mode, gen.beta, gen.seed, gen.legs.every((l) => l.weight === 1)], ["GENERATE", null, null, null, true]);
}

(async () => {
  await yourPicks();
  reuse();
  hedge();
  await freshSeedAndLog();
  console.log("\nRegenerate distribution (200 seeds): " + JSON.stringify(distribution));
  console.log(failures > 0 ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
  if (failures > 0) process.exitCode = 1;
})();
