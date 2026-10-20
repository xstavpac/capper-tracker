// generator-session.ts without a database (CI runs this; the DB-backed
// parlay-generate-zero-reads-acceptance-test.ts counts real SQL locally):
// one request per Generate of a new pool, none for Regenerate, settings
// changes or a reordered pool, a reload when the pool changes or the snapshot
// is stale. The request is a counting stand-in that serves a fixed snapshot.
// Pure - no DB. Run with:
//   npx tsx src/lib/parlay/generator-session-acceptance-test.ts
import { createGeneratorSession, poolKey, type GenerateCall } from "@/lib/parlay/generator-session";
import { buildGeneratedParlay, type GeneratorSettings, type GeneratorSnapshot } from "@/lib/parlay/generator";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const T0 = Date.parse("2099-06-01T12:00:00.000Z");
const START = "2099-06-01T23:00:00.000Z";
const TEAMS: [string, string, string][] = [
  ["New York Yankees", "Boston Red Sox", "Yankees"],
  ["Toronto Blue Jays", "Tampa Bay Rays", "Blue Jays"],
  ["Houston Astros", "Baltimore Orioles", "Astros"],
  ["Cleveland Guardians", "Detroit Tigers", "Guardians"],
  ["Seattle Mariners", "Texas Rangers", "Mariners"],
];
const categoryRecords: GeneratorSnapshot["categoryRecords"] = {};
const games: GeneratorGame[] = TEAMS.map(([home, away, nick], g) => {
  const pick = (id: string, detail: string, betType: string, category: "FAV_ML" | "OVER", wins: number, line: number | null) => {
    categoryRecords["cap-" + id + "|" + category] = { key: category, label: category, wins, losses: 40 - wins, pushes: 0, winPct: (wins / 40) * 100, count: 40 };
    return {
      pickId: id, capperId: "cap-" + id, capperName: id, capperColorTag: null, capperIsFavorite: false, category, leagueName: "MLB",
      gameId: "G" + g, gameLabel: away + " @ " + home, betDetail: detail, odds: -110, units: 1, status: "PENDING", betType,
      period: "FULL_GAME", rawBetDetail: detail, line, homeTeam: home, awayTeam: away, gameTime: START, teamGroup: "HOME",
      teamLabel: "", teamColor: null, datePosted: "2099-05-31T00:00:00.000Z",
    } as GeneratorPick;
  };
  return {
    gameId: "G" + g,
    gameLabel: away + " @ " + home,
    gameTime: START,
    leagueName: "MLB",
    picks: [pick(`g${g}ml`, nick + " ML", "MONEYLINE", "FAV_ML", 26 - g, null), pick(`g${g}o`, "Over 8.5", "TOTAL", "OVER", 25 - g, 8.5)],
  };
});

let clock = T0;
let calls: string[] = [];
const generate: GenerateCall = async (req) => {
  calls.push(poolKey(req));
  const snapshot: GeneratorSnapshot = {
    builtAt: new Date(clock).toISOString(),
    games,
    slipPicks: req.slipPickIds.map((id) => games.flatMap((g) => g.picks).find((p) => p.pickId === id)!),
    targets: req.targets.map((t) => t.gameId),
    leagueRecords: { records: {}, streaks: {}, last20: {} },
    categoryRecords,
  };
  return { snapshot, parlay: buildGeneratedParlay(snapshot, req.settings, null, new Date(clock)) };
};
const S: GeneratorSettings = { legCount: 2, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE" };
const pool = { leagues: ["MLB"], slipPickIds: ["g4ml"], targets: [] as { gameId: string; leagueName: string }[] };

(async () => {
  const session = createGeneratorSession({ generate, now: () => new Date(clock) });
  const g1 = await session.generate(pool, S);
  check("first Generate: one request", [calls.length, "error" in g1 ? null : g1.fetched], [1, true]);
  const keys: string[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await session.regenerate(pool, S);
    if (!("error" in r)) keys.push(r.parlay.generatedKey + (r.fetched ? "!" : ""));
  }
  check("5 Regenerates: no request", calls.length, 1);
  check("...none fetched, and they varied", [keys.some((k) => k.endsWith("!")), new Set(keys).size > 1], [false, true]);
  await session.generate(pool, { ...S, legCount: 3, maxLegsPerGame: 2, include: ["MONEYLINE", "SPREAD", "TOTALS"], mix: { MONEYLINE: 50, SPREAD: 0, TOTALS: 50 }, fillFrom: "YOUR_PICKS_ONLY" });
  check("settings that don't change the pool: no request", calls.length, 1);
  await session.generate({ leagues: ["MLB"], slipPickIds: ["g4ml"], targets: [] }, S);
  check("the same pool rebuilt from new arrays: no request", calls.length, 1);
  check("poolKey ignores order", poolKey({ leagues: ["NFL", "MLB"], slipPickIds: ["b", "a"], targets: [] }) === poolKey({ leagues: ["MLB", "NFL"], slipPickIds: ["a", "b"], targets: [] }), true);
  const again = await session.generate(pool, S);
  check("Generate on a held snapshot: the same Primary as the first", "error" in g1 || "error" in again ? null : again.parlay.generatedKey === g1.parlay.generatedKey, true);

  await session.generate({ ...pool, slipPickIds: [] }, S);
  check("slip changed: one request", calls.length, 2);
  await session.regenerate({ ...pool, slipPickIds: [], targets: [{ gameId: "G1", leagueName: "MLB" }] }, S);
  check("targets changed (on Regenerate): reload first", calls.length, 3);
  await session.regenerate({ ...pool, slipPickIds: [], leagues: ["MLB", "NFL"], targets: [{ gameId: "G1", leagueName: "MLB" }] }, S);
  check("leagues changed: reload", calls.length, 4);

  clock = T0 + 2 * 60 * 1000 + 1;
  await session.regenerate({ ...pool, slipPickIds: [], leagues: ["MLB", "NFL"], targets: [{ gameId: "G1", leagueName: "MLB" }] }, S);
  check("snapshot older than 2 minutes: reload", calls.length, 5);
  clock = Date.parse(START) + 1;
  calls = [];
  const s2 = createGeneratorSession({ generate, now: () => new Date(clock) });
  clock = Date.parse(START) - 60_000;
  await s2.generate(pool, S);
  clock = Date.parse(START) + 1;
  await s2.regenerate(pool, S);
  check("a game in the snapshot started: reload", calls.length, 2);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
