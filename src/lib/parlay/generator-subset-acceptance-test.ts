// Fill from = Your picks only with more slip picks than Total legs (generator.ts
// rule 6): the parlay is Total legs of them, Generate takes the strongest,
// Regenerate draws another mix each tap - weighted toward the stronger, never
// opposing, never over max legs per game, both sides of an opposing pair in
// turn - and with no more picks than legs every pick is in and Regenerate says
// so. Runs Regenerate through the session (generator-session.ts) so the
// history is the one the card keeps. Pure - no DB. Run with:
//   npx tsx src/lib/parlay/generator-subset-acceptance-test.ts
import { buildGeneratedParlay, type GeneratedParlay, type GeneratorSettings, type GeneratorSnapshot } from "@/lib/parlay/generator";
import { createGeneratorSession } from "@/lib/parlay/generator-session";
import { legSetKey } from "@/lib/parlay/parlay-set";
import { sameGameConflict } from "@/lib/parlay/same-game-rules";
import { blocks } from "@/lib/parlay/build-my-picks";
import { toBuildCandidate } from "@/lib/parlay/pool-swap";
import { toParlayCandidate, toParlayLeg } from "@/lib/parlay/qualification-core";
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
// Fixture: 20 slip picks over 12 MLB games, records 55% to 70% (100 picks
// each), 8 games with two picks, 3 opposing pairs (ML / ML, Over / Under, ML /
// the other team's +1.5).
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
];
type Bet = "HOME" | "AWAY" | "OVER" | "UNDER" | "AWAY_SPREAD";
const BETS: [number, Bet][] = [
  [0, "HOME"], [0, "OVER"], [1, "HOME"], [1, "UNDER"], [2, "HOME"], [2, "AWAY"], [3, "OVER"], [3, "UNDER"], [4, "HOME"], [4, "OVER"],
  [5, "HOME"], [6, "AWAY"], [7, "OVER"], [8, "HOME"], [8, "UNDER"], [9, "HOME"], [10, "HOME"], [10, "AWAY_SPREAD"], [11, "HOME"],
  [11, "UNDER"],
];
const OPPOSING: [string, string][] = [["p5", "p6"], ["p7", "p8"], ["p17", "p18"]];

const categoryRecords: Record<string, CategoryBreakdownItem | null> = {};
const leagueRecords: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };
const PICKS: GeneratorPick[] = BETS.map(([game, bet], i) => {
  const id = `p${i + 1}`;
  const [home, away, homeNick, awayNick] = TEAMS[game];
  const winPct = 55 + Math.round((i * 15) / 19);
  const detail = bet === "HOME" ? homeNick + " ML" : bet === "AWAY" ? awayNick + " ML" : bet === "AWAY_SPREAD" ? awayNick + " +1.5" : `${bet === "OVER" ? "Over" : "Under"} 8.5`;
  const betType = bet === "HOME" || bet === "AWAY" ? "MONEYLINE" : bet === "AWAY_SPREAD" ? "SPREAD" : "TOTAL";
  const category: PickCategoryKey = bet === "HOME" ? "FAV_ML" : bet === "AWAY" ? "DOG_ML" : bet === "AWAY_SPREAD" ? "SPREAD_PLUS" : bet;
  const capperId = "cap-" + id;
  const rec = { wins: winPct, losses: 100 - winPct, pushes: 0, winPct, count: 100 };
  categoryRecords[capperId + "|" + category] = { key: category, label: category, ...rec };
  leagueRecords.records[capperId + "|MLB|" + category] = { category, label: category, overall: rec, league: rec };
  return {
    pickId: id, capperId, capperName: "Capper " + id, capperColorTag: null, capperIsFavorite: false, category, leagueName: "MLB",
    gameId: "G" + game, gameLabel: away + " @ " + home, betDetail: detail, odds: -110, units: 1, status: "PENDING", betType, period: "FULL_GAME",
    rawBetDetail: detail, propMarket: null, line: betType === "MONEYLINE" ? null : bet === "AWAY_SPREAD" ? 1.5 : 8.5, homeTeam: home, awayTeam: away,
    gameTime: START, teamGroup: bet === "AWAY" || bet === "AWAY_SPREAD" ? "AWAY" : "HOME", teamLabel: "", teamColor: null, datePosted: "2099-05-31T00:00:00.000Z",
  } as GeneratorPick;
});
const winPctOf = new Map(PICKS.map((p, i) => [p.pickId, 55 + Math.round((i * 15) / 19)]));
const games: GeneratorGame[] = TEAMS.map(([home, away], n) => ({ gameId: "G" + n, gameLabel: away + " @ " + home, gameTime: START, leagueName: "MLB", picks: PICKS.filter((p) => p.gameId === "G" + n) }));
const snapshotOf = (slip: GeneratorPick[]): GeneratorSnapshot => ({ builtAt: NOW.toISOString(), games, slipPicks: slip, targets: [], leagueRecords, categoryRecords });
const SNAPSHOT = snapshotOf(PICKS);
const settingsOf = (legCount: number, maxLegsPerGame: number): GeneratorSettings => ({ legCount, maxLegsPerGame, include: "ALL", mix: null, fillFrom: "YOUR_PICKS_ONLY" });
const ids = (p: GeneratedParlay) => p.legs.map((l) => l.pick.pickId);

// Two picks that can't share a parlay: the slip's own rule (blocks) or any
// same-game rule.
const asC = (p: GeneratorPick) => toParlayCandidate(toParlayLeg(p));
const clash = (a: GeneratorPick, b: GeneratorPick) =>
  a.gameId === b.gameId && (blocks(toBuildCandidate(a), toBuildCandidate(b)).blocked || sameGameConflict(asC(a), asC(b)) !== null);
const invalid = (legs: GeneratorPick[], cap: number) => {
  const perGame = new Map<string, number>();
  for (const l of legs) perGame.set(l.gameId, (perGame.get(l.gameId) ?? 0) + 1);
  return Math.max(...perGame.values()) > cap || legs.some((a, i) => legs.slice(i + 1).some((b) => clash(a, b)));
};

{
  const pairs = PICKS.flatMap((a, i) => PICKS.slice(i + 1).filter((b) => clash(a, b)).map((b) => [a.pickId, b.pickId]));
  check("fixture: the rules block exactly the 3 opposing pairs", pairs, OPPOSING);
  check("fixture: 20 picks, 12 games, 8 with two picks (one opposing pair each on 3)", [PICKS.length, new Set(PICKS.map((p) => p.gameId)).size, games.filter((g) => g.picks.length === 2).length], [20, 12, 8]);
}

// Every valid 7-leg parlay from the 20, for the uniform baseline.
function validCombos(L: number, cap: number): GeneratorPick[][] {
  const out: GeneratorPick[][] = [];
  const walk = (start: number, chosen: GeneratorPick[]) => {
    if (chosen.length === L) return void out.push(chosen);
    for (let i = start; i <= PICKS.length - (L - chosen.length); i++) {
      const c = PICKS[i];
      if (chosen.filter((x) => x.gameId === c.gameId).length >= cap || chosen.some((x) => clash(x, c))) continue;
      walk(i + 1, [...chosen, c]);
    }
  };
  walk(0, []);
  return out;
}
const avgPct = (legs: { pickId: string }[]) => legs.reduce((s, l) => s + winPctOf.get(l.pickId)!, 0) / legs.length;

// ============================================================================
// 20 picks, Total legs 7, max legs per game 1 and 2: Generate then 40 Regenerates
// through the session.
// ============================================================================
async function taps(cap: number) {
  const settings = settingsOf(7, cap);
  const session = createGeneratorSession({ generate: async (req) => ({ snapshot: SNAPSHOT, parlay: buildGeneratedParlay(SNAPSHOT, req.settings, null, NOW) }), now: () => NOW });
  const pool = { leagues: ["MLB"], slipPickIds: PICKS.map((p) => p.pickId), targets: [] };
  const first = await session.generate(pool, settings);
  if ("error" in first) throw new Error(first.error);
  const gen = first.parlay;
  const label = `max ${cap} per game`;
  check(`${label} · Generate: exactly 7 legs, all from the slip`, [gen.legs.length, gen.fromSlip, gen.generated, gen.requested], [7, 7, 0, 7]);
  check(`${label} · Generate: slipTotal 20, slipUsed 7, capacity = what the slip can make`, [gen.slipTotal, gen.slipUsed, gen.capacity], [20, 7, cap === 1 ? 12 : 17]);
  check(`${label} · Generate: the 13 unused are not_selected, nothing else dropped`, [gen.dropped.length, gen.dropped.every((d) => d.reason === "not_selected")], [13, true]);
  const strongest = validCombos(7, cap).reduce((best, c) => (avgPct(c) > avgPct(best) ? c : best));
  check(`${label} · Generate: the strongest valid 7`, legSetKey(ids(gen)), legSetKey(strongest.map((p) => p.pickId)));
  check(`${label} · Generate again: the same parlay`, ids(buildGeneratedParlay(SNAPSHOT, settings, null, NOW)), ids(gen));

  const keys = [gen.generatedKey];
  const changed: number[] = [];
  const chosen: string[][] = [];
  let prev = ids(gen);
  let allVaried = true;
  let anyInvalid = false;
  let repeatInWindow = false;
  let historyCarriesSlip = true;
  for (let i = 0; i < 40; i++) {
    const r = await session.regenerate(pool, settings);
    if ("error" in r) throw new Error(r.error);
    const p = r.parlay;
    if (p.variety !== "VARIED" || p.legs.length !== 7) allVaried = false;
    if (invalid(p.legs.map((l) => l.pick), cap)) anyInvalid = true;
    if (keys.slice(-20).includes(p.generatedKey)) repeatInWindow = true;
    if (p.historyIds.length !== 7 || legSetKey(p.historyIds) !== legSetKey(ids(p))) historyCarriesSlip = false;
    changed.push(ids(p).filter((x) => !prev.includes(x)).length);
    chosen.push(ids(p));
    keys.push(p.generatedKey);
    prev = ids(p);
  }
  const first20 = new Set(keys.slice(0, 21));
  const uniform = validCombos(7, cap);
  const uniformAvg = uniform.reduce((s, c) => s + avgPct(c), 0) / uniform.length;
  const drawnAvg = chosen.slice(0, 20).reduce((s, c) => s + avgPct(c.map((pickId) => ({ pickId }))), 0) / 20;
  const seen = new Set(chosen.slice(0, 20).flat());
  // How often the 5 strongest and 5 weakest picks are in a parlay: 40 taps vs
  // every valid parlay equally likely.
  const byPct = [...PICKS].sort((a, b) => winPctOf.get(b.pickId)! - winPctOf.get(a.pickId)!).map((p) => p.pickId);
  const rate = (sets: string[][], group: string[]) => sets.reduce((n, c) => n + c.filter((x) => group.includes(x)).length, 0) / (sets.length * group.length);
  const uniformIds = uniform.map((c) => c.map((p) => p.pickId));
  const [topDrawn, bottomDrawn, topUniform, bottomUniform] = [rate(chosen, byPct.slice(0, 5)), rate(chosen, byPct.slice(-5)), rate(uniformIds, byPct.slice(0, 5)), rate(uniformIds, byPct.slice(-5))];
  console.log(
    `  ${label}: ${uniform.length} valid 7-leg parlays · Generate + 20 taps = ${first20.size} distinct · legs changed per tap ${changed.slice(0, 20).join(",")} ` +
      `(avg ${(changed.slice(0, 20).reduce((s, n) => s + n, 0) / 20).toFixed(1)}) · avg record drawn ${drawnAvg.toFixed(2)}% vs uniform ${uniformAvg.toFixed(2)}% · ${seen.size}/20 picks appeared` +
      ` · in a parlay: 5 strongest ${(topDrawn * 100).toFixed(0)}% (uniform ${(topUniform * 100).toFixed(0)}%), 5 weakest ${(bottomDrawn * 100).toFixed(0)}% (uniform ${(bottomUniform * 100).toFixed(0)}%)`
  );
  check(`${label} · 20 taps: Generate + 20 are 21 different parlays`, first20.size, 21);
  check(`${label} · 40 taps: every one VARIED with 7 legs`, allVaried, true);
  check(`${label} · 40 taps: no opposing legs, never over the per-game cap`, anyInvalid, false);
  check(`${label} · 40 taps: none repeats any of the 20 before it (history window)`, repeatInWindow, false);
  check(`${label} · history: each entry is the 7 slip picks used`, historyCarriesSlip, true);
  check(`${label} · strength: the draws average above a uniform pick of valid parlays`, drawnAvg > uniformAvg, true);
  check(`${label} · strength: the 5 strongest picks are in more parlays than uniform, the 5 weakest in fewer`, [topDrawn > topUniform, bottomDrawn < bottomUniform], [true, true]);
  check(`${label} · both sides of every opposing pair appear across the 20 taps`, OPPOSING.every(([a, b]) => seen.has(a) && seen.has(b)), true);
}

// ============================================================================
// No more picks than legs: every pick in, Regenerate says why it can't vary.
// ============================================================================
async function allIn() {
  const six = PICKS.slice(0, 6).filter((p) => p.pickId !== "p6"); // G0 x2, G1 x2, G2 ML: 5 picks, none opposing
  const snap = snapshotOf(six);
  const g = buildGeneratedParlay(snap, settingsOf(5, 2), null, NOW);
  check("N = L (5 picks, 5 legs): every pick in", [legSetKey(ids(g)), g.slipTotal, g.slipUsed, g.dropped.length], [legSetKey(six.map((p) => p.pickId)), 5, 5, 0]);
  const r = buildGeneratedParlay(snap, settingsOf(5, 2), { seed: 2, history: [g.historyIds] }, NOW);
  check("N = L: Regenerate is NO_ALTERNATIVE because every pick is in", [r.variety, r.noAlternativeReason, legSetKey(ids(r))], ["NO_ALTERNATIVE", "ALL_PICKS_USED", legSetKey(ids(g))]);
  const more = buildGeneratedParlay(snap, settingsOf(8, 2), { seed: 2, history: [g.historyIds] }, NOW);
  check("N < L (5 picks, 8 legs): all 5 in, the same reason, and the shortfall is said", [more.legs.length, more.noAlternativeReason, more.shortfall.length], [5, "ALL_PICKS_USED", 1]);

  // The old N <= L rule is kept: an opposing pair is settled, not rotated.
  const withPair = PICKS.slice(0, 6);
  const w = buildGeneratedParlay(snapshotOf(withPair), settingsOf(6, 2), null, NOW);
  check("N <= L with an opposing pair: the better record stays, the other is dropped as opposes", w.dropped.map((d) => [d.pickId, d.reason]), [["p5", "opposes"]]);

  // Session: a NO_ALTERNATIVE is not remembered, so the next tap still says it.
  const session = createGeneratorSession({ generate: async (req) => ({ snapshot: snap, parlay: buildGeneratedParlay(snap, req.settings, null, NOW) }), now: () => NOW });
  const pool = { leagues: ["MLB"], slipPickIds: six.map((p) => p.pickId), targets: [] };
  await session.generate(pool, settingsOf(5, 2));
  const reasons: unknown[] = [];
  for (let i = 0; i < 3; i++) {
    const t = await session.regenerate(pool, settingsOf(5, 2));
    reasons.push("error" in t ? t.error : t.parlay.noAlternativeReason);
  }
  check("N = L through the session: three taps, three ALL_PICKS_USED", reasons, ["ALL_PICKS_USED", "ALL_PICKS_USED", "ALL_PICKS_USED"]);
}

// ============================================================================
// Edges: N = L + 1, and a per-game cap that leaves fewer usable picks than L.
// ============================================================================
function edges() {
  // 8 picks on 8 games (one each, nothing opposing), 7 legs: 8 ways to leave one out.
  const eight = PICKS.filter((p) => ["p1", "p3", "p5", "p7", "p9", "p11", "p12", "p13"].includes(p.pickId));
  const snap = snapshotOf(eight);
  const g = buildGeneratedParlay(snap, settingsOf(7, 1), null, NOW);
  check("N = L + 1: Generate leaves out the weakest", [g.legs.length, g.dropped.map((d) => [d.pickId, d.reason])], [7, [["p1", "not_selected"]]]);
  const history: string[][] = [g.historyIds];
  let neverTwiceInARow = true;
  for (let i = 0; i < 7; i++) {
    const r = buildGeneratedParlay(snap, settingsOf(7, 1), { seed: 10 + i, history }, NOW);
    if (r.variety !== "VARIED" || r.generatedKey === legSetKey(history[0])) neverTwiceInARow = false;
    history.unshift(r.historyIds);
  }
  console.log(`  N = L + 1: Generate + 7 taps show ${new Set(history.map((h) => legSetKey(h))).size} of the 8 possible parlays`);
  check("N = L + 1: 7 taps, each VARIED and never the parlay just shown", neverTwiceInARow, true);
  const ninth = buildGeneratedParlay(snap, settingsOf(7, 1), { seed: 99, history }, NOW);
  check("N = L + 1: the next tap still differs from the last", [ninth.variety, ninth.generatedKey !== legSetKey(history[0])], ["VARIED", true]);

  // 20 picks, max 1 per game: they can make 12 legs. Total legs 14 is past
  // that - not a subset; the 12 go in, the rest are dropped as today, and the
  // shortfall is said.
  const over = buildGeneratedParlay(SNAPSHOT, settingsOf(14, 1), null, NOW);
  check("cap shrinks the slip below L (12 usable, 14 asked): 12 legs, capacity 12, shortfall said", [over.legs.length, over.capacity, over.shortfall.length > 0, invalid(over.legs.map((l) => l.pick), 1)], [12, 12, true, false]);
  check("...its unused picks are dropped as today (opposes / left out), never not_selected", over.dropped.some((d) => d.reason === "not_selected"), false);
  // Exactly the slip's capacity: every usable pick in, nothing to vary.
  const exact = buildGeneratedParlay(SNAPSHOT, settingsOf(12, 1), { seed: 3, history: [[]] }, NOW);
  check("L = capacity (12): every usable pick in, Regenerate: ALL_PICKS_USED", [exact.legs.length, exact.noAlternativeReason], [12, "ALL_PICKS_USED"]);
  const eleven = buildGeneratedParlay(SNAPSHOT, settingsOf(11, 1), null, NOW);
  check("L = capacity - 1 (11): a subset, 11 legs", [eleven.legs.length, eleven.slipUsed, eleven.dropped.filter((d) => d.reason === "not_selected").length], [11, 11, 9]);
}

// ============================================================================
// Best available is not a subset, whatever the slip holds.
// ============================================================================
function bestAvailable() {
  const r = buildGeneratedParlay(SNAPSHOT, { ...settingsOf(7, 2), fillFrom: "BEST_AVAILABLE" }, null, NOW);
  check("Best available, 20 slip picks, Total legs 7: every usable slip pick is in, as before", [r.legs.length, r.dropped.some((d) => d.reason === "not_selected")], [17, false]);
}

(async () => {
  await taps(1);
  await taps(2);
  await allIn();
  edges();
  bestAvailable();
  console.log(failures > 0 ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
  if (failures > 0) process.exitCode = 1;
})();
