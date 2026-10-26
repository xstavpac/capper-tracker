// The adjustable win-rate gate (gate.ts, settings.minWinPct): 55 stays the
// default, a lower value admits cappers the default rejects, a higher one
// rejects cappers it admits, anything that isn't a whole 5-point step from 45
// to 75 is 55, Hedge and Contrarian honour it, LEGACY_RULES ignores it, and the
// result is deterministic. Pure - no DB. Run with:
//   npx tsx src/lib/parlay/generator-gate-acceptance-test.ts
import { readFileSync } from "node:fs";
import { buildGeneratedParlay, GENERATOR_RULES, LEGACY_RULES, type GeneratedParlay, type GeneratorSettings, type GeneratorSnapshot } from "@/lib/parlay/generator";
import { GATE_DEFAULT, GATE_MAX, GATE_MIN, GATE_STEP, normalizeMinWinPct } from "@/lib/parlay/gate";
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
  ["Cleveland Guardians", "Detroit Tigers", "Guardians", "Tigers"],
  ["Seattle Mariners", "Texas Rangers", "Mariners", "Rangers"],
];

const col = (wins: number, losses: number) => ({ wins, losses, pushes: 0, winPct: (wins / (wins + losses)) * 100, count: wins + losses });

// One in-league record per pick; every pick is a moneyline, HOME or AWAY.
type Spec = { id: string; game: number; side: "HOME" | "AWAY"; rec: [number, number] };

function makeSnapshot(specs: Spec[]): GeneratorSnapshot {
  const categoryRecords: Record<string, CategoryBreakdownItem | null> = {};
  const leagueRecords: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };
  const byGame = new Map<number, GeneratorPick[]>();
  for (const s of specs) {
    const [home, away, homeNick, awayNick] = TEAMS[s.game];
    const detail = (s.side === "HOME" ? homeNick : awayNick) + " ML";
    const category: PickCategoryKey = s.side === "HOME" ? "FAV_ML" : "DOG_ML";
    const capperId = "cap-" + s.id;
    const c = col(s.rec[0], s.rec[1]);
    categoryRecords[capperId + "|" + category] = { key: category, label: category, ...c };
    leagueRecords.records[capperId + "|MLB|" + category] = { category, label: category, overall: c, league: c };
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
      betType: "MONEYLINE",
      period: "FULL_GAME",
      rawBetDetail: detail,
      propMarket: null,
      line: null,
      homeTeam: home,
      awayTeam: away,
      gameTime: START,
      teamGroup: s.side,
      teamLabel: "",
      teamColor: null,
      datePosted: "2099-05-31T00:00:00.000Z",
    } as GeneratorPick;
    byGame.set(s.game, [...(byGame.get(s.game) ?? []), pick]);
  }
  const games: GeneratorGame[] = Array.from(byGame.entries()).map(([n, picks]) => ({ gameId: "G" + n, gameLabel: TEAMS[n][1] + " @ " + TEAMS[n][0], gameTime: START, leagueName: "MLB", picks }));
  return { builtAt: NOW.toISOString(), games, slipPicks: [], targets: [], leagueRecords, categoryRecords };
}

const BASE: GeneratorSettings = { legCount: 5, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE" };
const run = (snap: GeneratorSnapshot, over: Partial<GeneratorSettings> = {}, rules = GENERATOR_RULES) => buildGeneratedParlay(snap, { ...BASE, ...over }, null, NOW, rules);
const ids = (p: GeneratedParlay) => p.legs.map((l) => l.pick.pickId).sort();

// One capper per game: 52%, 55% exactly, 58%, 65%, 70% in the league.
const ladder = makeSnapshot([
  { id: "p52", game: 0, side: "HOME", rec: [13, 12] },
  { id: "p55", game: 1, side: "HOME", rec: [11, 9] },
  { id: "p58", game: 2, side: "HOME", rec: [29, 21] },
  { id: "p65", game: 3, side: "HOME", rec: [13, 7] },
  { id: "p70", game: 4, side: "HOME", rec: [7, 3] },
]);

// ---- the bounds and the normalizer ------------------------------------------
check("bounds are 45..75 in steps of 5, default 55", [GATE_MIN, GATE_MAX, GATE_STEP, GATE_DEFAULT], [45, 75, 5, 55]);
check("every whole step in range is kept", [45, 50, 55, 60, 65, 70, 75].map(normalizeMinWinPct), [45, 50, 55, 60, 65, 70, 75]);
check(
  "anything else is 55 (below, above, off-step, fraction, NaN, Infinity, string, null, undefined, object)",
  [40, 80, 100, 0, -55, 57, 52.5, 55.5, NaN, Infinity, "60", null, undefined, {}].map(normalizeMinWinPct),
  Array(14).fill(55)
);

// ---- default equals today ----------------------------------------------------
{
  const today = JSON.stringify(run(ladder));
  check("default: setting absent, 55, undefined and invalid values are byte-identical", [55, undefined, 57, 30, 80, NaN].map((v) => JSON.stringify(run(ladder, { minWinPct: v as number }))).every((j) => j === today), true);
  check("default gate: 55% exactly passes, 52% does not", ids(run(ladder)), ["p55", "p58", "p65", "p70"]);
}

// ---- lower admits, higher rejects ---------------------------------------------
check("lower (50) admits the 52% capper the default rejects", ids(run(ladder, { minWinPct: 50 })), ["p52", "p55", "p58", "p65", "p70"]);
check("higher (60) rejects the 55% and 58% cappers the default admits", ids(run(ladder, { minWinPct: 60 })), ["p65", "p70"]);
check("higher (75) leaves nobody", ids(run(ladder, { minWinPct: 75 })), []);
check("the gate is inclusive: exactly 65% passes at 65", ids(run(ladder, { minWinPct: 65 })), ["p65", "p70"]);
check("45 admits all five", ids(run(ladder, { minWinPct: 45 })).length, 5);
check("out of range (80, 30) falls back to 55, not to a stricter or looser gate", [80, 30].map((v) => ids(run(ladder, { minWinPct: v }))), [ids(run(ladder)), ids(run(ladder))]);

// ---- Hedge and Contrarian honour it ----------------------------------------------
{
  // Each game: a strong 9-1 pick on one side and an opposite-side alternate.
  // G0's alternate is 52%, G1's 58%.
  const snap = makeSnapshot([
    { id: "a0", game: 0, side: "HOME", rec: [9, 1] },
    { id: "b0", game: 0, side: "AWAY", rec: [13, 12] },
    { id: "a1", game: 1, side: "HOME", rec: [9, 1] },
    { id: "b1", game: 1, side: "AWAY", rec: [29, 21] },
  ]);
  const alt = (p: GeneratedParlay["contrarian"], pickId: string) => {
    const l = p.legs.find((x) => x.original.pick.pickId === pickId)!;
    return l.swap ? l.swap.pick.pickId : l.unchangedReason;
  };
  const at = (g?: number) => run(snap, { legCount: 2, minWinPct: g });
  check("default: Contrarian takes the 58% alternate, not the 52% one", [alt(at().contrarian, "a0"), alt(at().contrarian, "a1")], ["NO_ALTERNATE", "b1"]);
  check("lower (50): Contrarian takes the 52% alternate too", [alt(at(50).contrarian, "a0"), alt(at(50).contrarian, "a1")], ["b0", "b1"]);
  check("higher (60): Contrarian drops the 58% alternate", [alt(at(60).contrarian, "a0"), alt(at(60).contrarian, "a1")], ["NO_ALTERNATE", "NO_ALTERNATE"]);
}

// ---- LEGACY_RULES ignores it ---------------------------------------------------------
{
  const legacy = JSON.stringify(run(ladder, {}, LEGACY_RULES));
  check("LEGACY_RULES: 45, 50, 60, 75 and an invalid value are all byte-identical to the setting absent", [45, 50, 60, 75, 12].every((v) => JSON.stringify(run(ladder, { minWinPct: v }, LEGACY_RULES)) === legacy), true);
  check("LEGACY_RULES still gates at 55", ids(run(ladder, { minWinPct: 45 }, LEGACY_RULES)), ["p55", "p58", "p65", "p70"]);
}

// ---- deterministic when a lower gate lets many cappers in ------------------------------
{
  const many: Spec[] = [];
  for (let g = 0; g < TEAMS.length; g++) for (let i = 0; i < 6; i++) many.push({ id: `c${g}${i}`, game: g, side: i % 2 ? "AWAY" : "HOME", rec: [10 + i, 10 - (i % 3) + 2] });
  const snap = makeSnapshot(many);
  const shuffled: GeneratorSnapshot = { ...snap, games: [...snap.games].reverse().map((g) => ({ ...g, picks: [...g.picks].reverse() })) };
  const once = JSON.stringify(run(snap, { minWinPct: 45 }));
  check("same snapshot and settings: byte-identical across runs", [0, 1, 2].every(() => JSON.stringify(run(snap, { minWinPct: 45 })) === once), true);
  check("snapshot order does not matter at the lowest gate (legs)", ids(run(shuffled, { minWinPct: 45 })), ids(run(snap, { minWinPct: 45 })));
  const chain = (s: GeneratorSnapshot) => JSON.stringify([1, 2, 3].map((i) => ids(buildGeneratedParlay(s, { ...BASE, minWinPct: 45 }, { seed: 1000 + i * 31, history: [] }, NOW))));
  check("Regenerate with a seed is repeatable at the lowest gate", chain(snap), chain(snap));
}

// ---- the server and the card use the same normalizer --------------------------------------
{
  const server = readFileSync("src/server/actions/parlay-generate.ts", "utf8");
  check("parseRequest normalizes minWinPct with the shared helper", /minWinPct:\s*normalizeMinWinPct\(s\.minWinPct\)/.test(server), true);
  const card = readFileSync("src/components/parlay/generator-card.tsx", "utf8");
  check("the card sends minWinPct in the settings Generate and Regenerate share", /fillFrom, minWinPct \}\)/.test(card), true);
}

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nAll passed.");
