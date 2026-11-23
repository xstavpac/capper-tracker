// PR 6 (modes UI, LIMITED): the browser-kept mode survives broken storage, the old browser-kept reuse
// history is removed and never read (the exposure penalty is the result card's, in memory - generator-session.ts),
// LIMITED fires exactly when Best available builds fewer legs than Total legs and never touches the gate,
// and the chosen mode reaches selection's beta.
// Pure - no DB. Run with:  npx tsx src/lib/parlay/modes-ui-acceptance-test.ts
import { createGeneratorSession, type GenerateCall } from "@/lib/parlay/generator-session";
import { buildGeneratedParlay, type GeneratorSettings, type GeneratorSnapshot } from "@/lib/parlay/generator";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import { LEGACY_REUSE_HISTORY_KEY, readStoredMode, writeStoredMode, type KeyValueStore } from "@/lib/parlay/selection-mode-store";
import { SELECTION_BETA } from "@/lib/parlay/selection";
import { sanitizeClientTrace } from "@/lib/parlay/run-trace-validate";
import type { RunTrace } from "@/lib/parlay/run-trace";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const memStore = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
};
const throwing: KeyValueStore = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("full");
  },
  removeItem: () => {
    throw new Error("denied");
  },
};
const NOW = Date.parse("2099-06-01T12:00:00.000Z");

// ---- storage wrapper ----
check("throwing storage: mode is Diversified", readStoredMode("u", throwing), "DIVERSIFIED");
writeStoredMode("u", "EXPLORE", throwing);
check("no storage: mode is Diversified", readStoredMode("u", null), "DIVERSIFIED");
const ms = memStore();
writeStoredMode("u", "BEST", ms);
check("mode round-trips", readStoredMode("u", ms), "BEST");
ms.data.set("parlay-mode:v1:u", "WILD");
check("an unknown stored mode falls back to Diversified", readStoredMode("u", ms), "DIVERSIFIED");
writeStoredMode("u", "DIVERSIFIED", ms);
check("Diversified clears the key", ms.data.has("parlay-mode:v1:u"), false);

// ---- the old reuse history: removed on the next read, the mode untouched, other users' left alone ----
const legacy = memStore();
legacy.data.set("parlay-reuse:v1:u", JSON.stringify({ v: 1, parlays: [{ at: NOW, legs: ["a"] }] }));
legacy.data.set("parlay-reuse:v1:v", "{}");
writeStoredMode("u", "EXPLORE", legacy);
check("legacy key name", LEGACY_REUSE_HISTORY_KEY("u"), "parlay-reuse:v1:u");
check("reading the mode removes the old reuse history", [readStoredMode("u", legacy), legacy.data.has("parlay-reuse:v1:u")], ["EXPLORE", false]);
check("...only this user's", legacy.data.has("parlay-reuse:v1:v"), true);

// ---- the session: LIMITED, the gate, the mode ----
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
  const id = `g${g}ml`;
  categoryRecords["cap-" + id + "|FAV_ML"] = { key: "FAV_ML", label: "FAV_ML", wins: 26 - g, losses: 14 + g, pushes: 0, winPct: ((26 - g) / 40) * 100, count: 40 };
  const pick = {
    pickId: id, capperId: "cap-" + id, capperName: id, capperColorTag: null, capperIsFavorite: false, category: "FAV_ML", leagueName: "MLB",
    gameId: "G" + g, gameLabel: away + " @ " + home, betDetail: nick + " ML", odds: -110, units: 1, status: "PENDING", betType: "MONEYLINE",
    period: "FULL_GAME", rawBetDetail: nick + " ML", line: null, homeTeam: home, awayTeam: away, gameTime: START, teamGroup: "HOME",
    teamLabel: "", teamColor: null, datePosted: "2099-05-31T00:00:00.000Z",
  } as GeneratorPick;
  return { gameId: "G" + g, gameLabel: away + " @ " + home, gameTime: START, leagueName: "MLB", picks: [pick] };
});
const generate: GenerateCall = async (req) => {
  const snapshot: GeneratorSnapshot = {
    builtAt: new Date(NOW).toISOString(), games, slipPicks: [], targets: [],
    leagueRecords: { records: {}, streaks: {}, last20: {} }, categoryRecords,
  };
  return { snapshot, parlay: buildGeneratedParlay(snapshot, req.settings, null, new Date(NOW)) };
};
const pool = { leagues: ["MLB"], slipPickIds: [] as string[], targets: [] as { gameId: string; leagueName: string }[] };
const base: GeneratorSettings = { legCount: 3, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE", minWinPct: 55 };

(async () => {
  const traces: RunTrace[] = [];
  const session = createGeneratorSession({ generate, now: () => new Date(NOW), onTrace: (t) => void traces.push(t) });
  const ok = await session.generate(pool, base);
  const okParlay = "error" in ok ? null : ok.parlay;
  check("enough qualifying legs: not LIMITED", [okParlay?.legs.length, okParlay?.limited], [3, null]);
  const short = await session.generate(pool, { ...base, legCount: 9 });
  const shortParlay = "error" in short ? null : short.parlay;
  const have = shortParlay?.legs.length ?? -1;
  check("fewer qualifying legs than Total legs: LIMITED with have/need", shortParlay?.limited, { have, need: 9 });
  check("...and the short parlay is still returned", have > 0 && have < 9, true);
  const exact = await session.generate(pool, { ...base, legCount: have });
  check("asking for exactly what qualifies: not LIMITED", "error" in exact ? null : exact.parlay.limited, null);
  check(
    "the bar is never lowered: the same legs at the same bar",
    "error" in exact ? null : exact.parlay.legs.map((l) => l.pick.pickId).sort(),
    shortParlay?.legs.map((l) => l.pick.pickId).sort()
  );
  const picksOnly = await session.generate({ ...pool, slipPickIds: ["g0ml"] }, { ...base, legCount: 2, fillFrom: "YOUR_PICKS_ONLY" });
  check("Your picks only: never LIMITED", "error" in picksOnly ? null : picksOnly.parlay.limited, null);
  const limitedTrace = traces.find((t) => t.extras.limited?.need === 9);
  check("the run log carries have/need", limitedTrace?.extras.limited, { have, need: 9 });
  check("...through sanitizeClientTrace", sanitizeClientTrace(JSON.parse(JSON.stringify(limitedTrace)))?.extras.limited, { have, need: 9 });

  for (const mode of ["BEST", "DIVERSIFIED", "EXPLORE"] as const) {
    const t: RunTrace[] = [];
    const s = createGeneratorSession({ generate, now: () => new Date(NOW), onTrace: (x) => void t.push(x), firstSeed: 7 });
    await s.generate(pool, base);
    t.length = 0;
    await s.regenerate(pool, base, mode);
    const sel = t[0]?.extras.selection;
    check("Regenerate in " + mode + " reaches selection's beta", [sel?.mode, sel?.beta], [mode, SELECTION_BETA[mode]]);
  }
  const t3: RunTrace[] = [];
  const d = createGeneratorSession({ generate, now: () => new Date(NOW), onTrace: (x) => void t3.push(x) });
  await d.generate(pool, base);
  t3.length = 0;
  await d.regenerate(pool, base);
  check("no mode passed: Diversified", t3[0]?.extras.selection?.mode, "DIVERSIFIED");

  // Nothing about the parlays shown is kept between page loads: a new session's first Regenerate weighs down
  // only what its own card has shown (its Generate), however many parlays an earlier session showed.
  const old = createGeneratorSession({ generate, now: () => new Date(NOW), firstSeed: 3 });
  await old.generate(pool, base);
  for (let i = 0; i < 4; i++) await old.regenerate(pool, base);
  const traces2: RunTrace[] = [];
  const s2 = createGeneratorSession({ generate, now: () => new Date(NOW), firstSeed: 3, onTrace: (x) => void traces2.push(x) });
  const gen2 = await s2.generate(pool, base);
  traces2.length = 0;
  await s2.regenerate(pool, base);
  const sel2 = traces2[0]?.extras.selection;
  const shownByGen = new Set("error" in gen2 ? [] : gen2.parlay.historyIds);
  check(
    "a new page load: only its own Generate's legs are weighed down",
    (sel2?.legs ?? []).every((l) => (l.reused === true) === shownByGen.has(l.id)),
    true
  );

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
