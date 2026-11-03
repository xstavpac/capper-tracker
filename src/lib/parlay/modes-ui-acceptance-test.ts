// PR 6 (modes UI, reuse history, LIMITED): the browser-kept reuse history and mode survive broken storage,
// history trims to 10 parlays / 24h and merges once per leg, LIMITED fires exactly when Best available
// builds fewer legs than Total legs and never touches the gate, and the chosen mode reaches selection's beta.
// Pure - no DB. Run with:  npx tsx src/lib/parlay/modes-ui-acceptance-test.ts
import { createGeneratorSession, type GenerateCall } from "@/lib/parlay/generator-session";
import { buildGeneratedParlay, type GeneratorSettings, type GeneratorSnapshot } from "@/lib/parlay/generator";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import { mergeRecentLegs, readReuseHistory, readStoredMode, recordReuseHistory, trimHistory, writeStoredMode, type KeyValueStore } from "@/lib/parlay/reuse-history";
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
const H = 60 * 60 * 1000;

// ---- storage wrapper ----
check("throwing storage: history reads empty", readReuseHistory("u", NOW, throwing), []);
check("throwing storage: write does not throw and returns what it would store", recordReuseHistory("u", ["a", "b"], NOW, throwing), [{ at: NOW, legs: ["a", "b"] }]);
check("no storage: history reads empty", readReuseHistory("u", NOW, null), []);
check("empty storage: history reads empty", readReuseHistory("u", NOW, memStore()), []);
check("throwing storage: mode is Diversified", readStoredMode("u", throwing), "DIVERSIFIED");
writeStoredMode("u", "EXPLORE", throwing);
const ms = memStore();
for (const junk of ["not json", "null", "[]", '{"v":2,"parlays":[]}', '{"v":1,"parlays":"x"}', '{"v":1,"parlays":[{"at":"x","legs":["a"]},{"at":1,"legs":5},null]}']) {
  ms.data.set("parlay-reuse:v1:u", junk);
  check("junk in storage reads empty: " + junk.slice(0, 24), readReuseHistory("u", NOW, ms), []);
}
writeStoredMode("u", "BEST", ms);
check("mode round-trips", readStoredMode("u", ms), "BEST");
ms.data.set("parlay-mode:v1:u", "WILD");
check("an unknown stored mode falls back to Diversified", readStoredMode("u", ms), "DIVERSIFIED");
writeStoredMode("u", "DIVERSIFIED", ms);
check("Diversified clears the key", ms.data.has("parlay-mode:v1:u"), false);

// ---- trimming ----
const st = memStore();
for (let i = 0; i < 14; i++) recordReuseHistory("u", ["leg" + i], NOW - (14 - i) * 1000, st);
const kept = readReuseHistory("u", NOW, st);
check("history keeps the newest 10", [kept.length, kept[0].legs[0], kept[9].legs[0]], [10, "leg13", "leg4"]);
check(
  "history drops entries 24h old and older",
  trimHistory([{ at: NOW - 24 * H, legs: ["old"] }, { at: NOW - 24 * H + 1000, legs: ["fresh"] }], NOW).map((e) => e.legs[0]),
  ["fresh"]
);
const dup = memStore();
recordReuseHistory("u", ["x", "y"], NOW - 5000, dup);
recordReuseHistory("u", ["x", "y"], NOW, dup);
check("the same parlay rebuilt is one entry", readReuseHistory("u", NOW, dup), [{ at: NOW, legs: ["x", "y"] }]);
check("users are separate", readReuseHistory("v", NOW, dup), []);

// ---- merge ----
check(
  "a leg in both sources appears once, latest time kept",
  mergeRecentLegs([{ betKey: "a", at: 5 }], [{ at: 9, legs: ["a", "b"] }, { at: 2, legs: ["b"] }]).sort((p, q) => (p.betKey < q.betKey ? -1 : 1)),
  [{ betKey: "a", at: 9 }, { betKey: "b", at: 9 }]
);

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

  // Reuse history through the session: stored legs join recentLegs after a "reload" (new session, same storage).
  const store = memStore();
  const s1 = createGeneratorSession({ generate, now: () => new Date(NOW), reuse: { userId: () => "u", store } });
  const first = await s1.generate(pool, base);
  const firstKeys = "error" in first ? [] : first.parlay.historyBetKeys ?? [];
  check("a parlay shown is written to the browser history", readReuseHistory("u", NOW, store).map((e) => e.legs), [firstKeys]);
  const traces2: RunTrace[] = [];
  const s2 = createGeneratorSession({ generate, now: () => new Date(NOW), reuse: { userId: () => "u", store }, onTrace: (x) => void traces2.push(x) });
  await s2.generate(pool, base);
  traces2.length = 0;
  await s2.regenerate(pool, base);
  check("a new page load's Regenerate weighs the stored legs down", (traces2[0]?.extras.selection?.reuseHits ?? 0) > 0, true);
  const broken = createGeneratorSession({ generate, now: () => new Date(NOW), reuse: { userId: () => "u", store: throwing } });
  await broken.generate(pool, base);
  const r = await broken.regenerate(pool, base);
  check("throwing storage: Generate and Regenerate still work", "error" in r ? null : r.parlay.legs.length, 3);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
