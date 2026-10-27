// The generator's softer sample-size adjustment (generator.ts, GENERATOR_Z):
// candidates rank by Wilson lower bound at the generator's own z, so a
// mid-volume record sits close to a huge one without tiny perfect records
// floating above both. The shared default (wilson-lower-bound.ts, z=1.96 - the
// Live category panel, legacy Auto-Generate, the frozen fixtures) does not
// move. Cases are from real slates. Pure - no DB. Run with:
//   npx tsx src/lib/parlay/generator-soft-sample-acceptance-test.ts
import {
  buildGeneratedParlay,
  GAME_BAND,
  GENERATOR_RULES,
  GENERATOR_Z,
  LEGACY_RULES,
  PICK_TIE_BAND,
  type GeneratedParlay,
  type GeneratorSettings,
  type GeneratorSnapshot,
} from "@/lib/parlay/generator";
import { wilsonLowerBound } from "@/lib/wilson-lower-bound";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { CategoryBreakdownItem, PickCategoryKey } from "@/server/data/stats";
import type { CapperLeagueRecords } from "@/server/data/picks";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const NOW = new Date("2099-09-01T12:00:00.000Z");
const START = "2099-09-01T23:00:00.000Z";
// [league, home, away, home nickname, away nickname]
const GAMES: [string, string, string, string, string][] = [
  ["NCAAF", "Texas Longhorns", "Ohio State Buckeyes", "Texas", "Ohio State"],
  ["MLB", "New York Yankees", "Boston Red Sox", "Yankees", "Red Sox"],
  ["MLB", "Toronto Blue Jays", "Tampa Bay Rays", "Blue Jays", "Rays"],
  ["MLB", "Houston Astros", "Baltimore Orioles", "Astros", "Orioles"],
  ["MLB", "Cleveland Guardians", "Detroit Tigers", "Guardians", "Tigers"],
  ["MLB", "Seattle Mariners", "Texas Rangers", "Mariners", "Rangers"],
];
const col = (wins: number, losses: number) => ({ wins, losses, pushes: 0, winPct: wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0, count: wins + losses });

// lg: the capper's record in this market in the game's league; all: every league.
type Spec = { id: string; game: number; bet: "HOME" | "AWAY" | "OVER"; lg: [number, number]; all?: [number, number] };

function makeSnapshot(specs: Spec[]): GeneratorSnapshot {
  const categoryRecords: Record<string, CategoryBreakdownItem | null> = {};
  const leagueRecords: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };
  const byGame = new Map<number, GeneratorPick[]>();
  for (const s of specs) {
    const [league, home, away, homeNick, awayNick] = GAMES[s.game];
    const detail = s.bet === "HOME" ? homeNick + " ML" : s.bet === "AWAY" ? awayNick + " ML" : "Over 8.5";
    const category: PickCategoryKey = s.bet === "HOME" ? "FAV_ML" : s.bet === "AWAY" ? "DOG_ML" : "OVER";
    const capperId = "cap-" + s.id;
    const all = col(...(s.all ?? s.lg));
    categoryRecords[capperId + "|" + category] = { key: category, label: category, ...all };
    leagueRecords.records[capperId + "|" + league + "|" + category] = { category, label: category, overall: all, league: col(...s.lg) };
    const pick = {
      pickId: s.id,
      capperId,
      capperName: "Capper " + s.id,
      capperColorTag: null,
      capperIsFavorite: false,
      category,
      leagueName: league,
      gameId: "G" + s.game,
      gameLabel: away + " @ " + home,
      betDetail: detail,
      odds: -110,
      units: 1,
      status: "PENDING",
      betType: s.bet === "OVER" ? "TOTAL" : "MONEYLINE",
      period: "FULL_GAME",
      rawBetDetail: detail,
      propMarket: null,
      line: s.bet === "OVER" ? 8.5 : null,
      homeTeam: home,
      awayTeam: away,
      gameTime: START,
      teamGroup: s.bet === "AWAY" ? "AWAY" : "HOME",
      teamLabel: "",
      teamColor: null,
      datePosted: "2099-08-31T00:00:00.000Z",
    } as GeneratorPick;
    byGame.set(s.game, [...(byGame.get(s.game) ?? []), pick]);
  }
  const games: GeneratorGame[] = Array.from(byGame.entries()).map(([n, picks]) => ({ gameId: "G" + n, gameLabel: GAMES[n][2] + " @ " + GAMES[n][1], gameTime: START, leagueName: GAMES[n][0], picks }));
  return { builtAt: NOW.toISOString(), games, slipPicks: [], targets: [], leagueRecords, categoryRecords };
}

const settings = (legCount: number, maxLegsPerGame = 1): GeneratorSettings => ({ legCount, maxLegsPerGame, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE" });
const ids = (p: GeneratedParlay) => p.legs.map((l) => l.pick.pickId);
const lb = (w: number, l: number) => wilsonLowerBound(w, l, GENERATOR_Z);

// ============================================================================
// The generator's own z; the shared default doesn't move
// ============================================================================
check("generator z is softer than the shared one", [GENERATOR_RULES.z, GENERATOR_Z], [1.5, 1.5]);
check("legacy keeps z=1.96 and its bands", [LEGACY_RULES.z, LEGACY_RULES.pickTieBand, LEGACY_RULES.gameBand], [1.96, 0.03, 0.05]);
check("retuned bands", [GENERATOR_RULES.pickTieBand, GENERATOR_RULES.gameBand, PICK_TIE_BAND, GAME_BAND], [0.035, 0.055, 0.035, 0.055]);
check("shared Wilson default is still z=1.96 (6-2 -> 0.4093)", wilsonLowerBound(6, 2).toFixed(4), "0.4093");

// ============================================================================
// Real case: 4-1 in NCAAF favorite moneyline (20-30 overall) beats 1-3 in NCAAF (33-27 overall)
// ============================================================================
{
  const snap = makeSnapshot([
    { id: "ncaafGood", game: 0, bet: "HOME", lg: [4, 1], all: [20, 30] },
    { id: "ncaafBad", game: 0, bet: "AWAY", lg: [1, 3], all: [33, 27] },
  ]);
  const now = buildGeneratedParlay(snap, settings(1), null, NOW);
  const old = buildGeneratedParlay(snap, settings(1), null, NOW, LEGACY_RULES);
  check("4-1 in NCAAF qualifies and is the leg; 1-3 in NCAAF doesn't", ids(now), ["ncaafGood"]);
  check("...on its NCAAF record", [now.legs[0].basis, now.legs[0].record], ["LEAGUE", { wins: 4, losses: 1, n: 5, winPct: 80 }]);
  check("legacy took the 33-27 all-time record instead", ids(old), ["ncaafBad"]);
}

// ============================================================================
// Real case: 18-4 is not buried under 100-30; 3-0 doesn't float above 18-4
// ============================================================================
{
  const gap = lb(100, 30) - lb(18, 4);
  check("18-4 is within 5 Wilson points of 100-30", gap >= 0 && gap <= 0.05, true);
  check("18-4 ranks clearly above 3-0 (by 5+ points)", lb(18, 4) - lb(3, 0) >= 0.05, true);
  check("and above 2-0 and 1-0", lb(18, 4) > lb(2, 0) && lb(2, 0) > lb(1, 0), true);
  check("100-30 still ranks above 18-4 (more sample, same ballpark)", lb(100, 30) > lb(18, 4), true);
  check("at 1.96 the gap was 7.5 points", +((wilsonLowerBound(100, 30) - wilsonLowerBound(18, 4)) * 100).toFixed(1), 7.5);

  // In the engine: same game, one leg. 18-4 beats 3-0; 100-30 beats 18-4.
  const snap = makeSnapshot([
    { id: "mid", game: 1, bet: "HOME", lg: [18, 4] },
    { id: "tiny", game: 1, bet: "OVER", lg: [3, 0] },
    { id: "big", game: 2, bet: "HOME", lg: [100, 30] },
    { id: "mid2", game: 2, bet: "OVER", lg: [18, 4] },
  ]);
  const p = buildGeneratedParlay(snap, settings(2), null, NOW);
  check("engine: 18-4 over 3-0 on its game; 100-30 over 18-4 on its game", ids(p).sort(), ["big", "mid"]);
  const leg = (id: string) => p.legs.find((l) => l.pick.pickId === id)!;
  check("legs are scored at the generator's z", [leg("mid").wilsonLowerBound, leg("big").wilsonLowerBound], [lb(18, 4), lb(100, 30)]);
}

// ============================================================================
// Real case: a 1-0 capper still qualifies (no minimum volume)
// ============================================================================
{
  const snap = makeSnapshot([{ id: "oneOh", game: 3, bet: "HOME", lg: [1, 0] }]);
  const p = buildGeneratedParlay(snap, settings(1), null, NOW);
  check("1-0 qualifies and is a leg", ids(p), ["oneOh"]);
  check("...with its 1-0 record shown", p.legs[0].record, { wins: 1, losses: 0, n: 1, winPct: 100 });
}

// ============================================================================
// Hedge / Contrarian rank at the same z
// ============================================================================
{
  const snap = makeSnapshot([
    { id: "prim", game: 4, bet: "HOME", lg: [30, 5] },
    { id: "dogTiny", game: 4, bet: "AWAY", lg: [3, 0] },
    { id: "dogMid", game: 4, bet: "AWAY", lg: [18, 4] },
  ]);
  const p = buildGeneratedParlay(snap, settings(1), null, NOW);
  const swap = p.contrarian.SUGGESTED.legs[0].swap;
  check("Contrarian takes 18-4 over 3-0, scored at the generator's z", swap && [swap.pick.pickId, swap.wilsonLowerBound], ["dogMid", lb(18, 4)]);
}

// ============================================================================
// Regenerate: deterministic per seed, never below the gate, rotates within the bands
// ============================================================================
{
  const snap = makeSnapshot([
    { id: "a1", game: 1, bet: "HOME", lg: [20, 5] },
    { id: "a2", game: 1, bet: "OVER", lg: [19, 5] },
    { id: "b1", game: 2, bet: "HOME", lg: [22, 6] },
    { id: "c1", game: 3, bet: "HOME", lg: [21, 6] },
    { id: "d1", game: 4, bet: "HOME", lg: [18, 5] },
    { id: "e1", game: 5, bet: "HOME", lg: [6, 4] },
  ]);
  const gen = buildGeneratedParlay(snap, settings(3), null, NOW);
  const variation = { seed: 7, history: [gen.legs.map((l) => l.pick.pickId)] };
  const r1 = buildGeneratedParlay(snap, settings(3), variation, NOW);
  const r2 = buildGeneratedParlay(snap, settings(3), variation, NOW);
  check("Generate is deterministic", JSON.stringify(buildGeneratedParlay(snap, settings(3), null, NOW)), JSON.stringify(gen));
  check("Regenerate is deterministic per seed and history", JSON.stringify(r1), JSON.stringify(r2));
  check("Regenerate gives another parlay", [r1.variety, r1.generatedKey !== gen.generatedKey], ["VARIED", true]);
  const weakestTop = Math.min(...gen.legs.map((l) => l.wilsonLowerBound!));
  check("every Regenerate leg is within the bands of Generate's weakest game", r1.legs.every((l) => l.wilsonLowerBound! >= weakestTop - GAME_BAND - PICK_TIE_BAND), true);
  check("the 6-4 game (far below the cut) never rotates in", [r1, ...[1, 2, 3, 4, 5].map((s) => buildGeneratedParlay(snap, settings(3), { seed: s, history: [gen.legs.map((l) => l.pick.pickId)] }, NOW))].some((p) => ids(p).includes("e1")), false);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
