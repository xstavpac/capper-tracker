// The scored output, frozen: one slate through the engine (scoring.ts, selection.ts) for six settings,
// compared with scoring-switch-frozen.json. The slate and its per-leg diff against the Wilson engine the
// scoring switch (#386) replaced are kept as history in scoring-switch-diff.txt; that engine (WILSON_RULES)
// was removed in PR 9, so only the scored output is asserted. Pure - no DB.
//   npx tsx src/lib/parlay/scoring-switch-diff-acceptance-test.ts
//   (re-freeze, only for an intended change: add --write)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGeneratedParlay, type GeneratorSettings } from "@/lib/parlay/generator";
import { buildSnapshot, NOW } from "@/lib/parlay/scoring-switch-fixture";

const CASES: [string, GeneratorSettings, string[]][] = [
  ["6 legs, best available, default gate", { legCount: 6, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE" }, []],
  ["8 legs, 2 per game, default gate", { legCount: 8, maxLegsPerGame: 2, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE" }, []],
  ["6 legs, 60% gate", { legCount: 6, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE", minWinPct: 60 }, []],
  ["6 legs, no gate", { legCount: 6, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE", minWinPct: 0 }, []],
  ["slip competing on one game, 4 legs", { legCount: 4, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE" }, ["g2-heavy-fav", "g2-mid-under"]],
  ["Your picks only, 2 of 5", { legCount: 2, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "YOUR_PICKS_ONLY" }, ["g1-55-45", "g2-heavy-fav", "g3-thin", "g0-small-spread", "g5-away"]],
];

const frozen: Record<string, unknown> = {};
for (const [label, settings, slip] of CASES) {
  const snap = buildSnapshot(undefined, slip);
  const newP = buildGeneratedParlay(snap, settings, null, NOW);
  frozen[label] = { legs: newP.legs.map((l) => l.pick.pickId), hedge: newP.hedge.ALL.legs.map((l) => l.swap?.pick.pickId ?? null), contrarian: newP.contrarian.ALL.legs.map((l) => l.swap?.pick.pickId ?? null), parlay: { ...newP, hedge: newP.hedge.ALL, contrarian: newP.contrarian.ALL } };
}
const jsonText = JSON.stringify(frozen, null, 2) + "\n";
const jsonPath = join(__dirname, "scoring-switch-frozen.json");

if (process.argv.includes("--write")) {
  writeFileSync(jsonPath, jsonText);
  console.log(jsonText);
  process.exit(0);
}

let failures = 0;
const want = readFileSync(jsonPath, "utf8").split("\r\n").join("\n");
const pass = jsonText === want;
console.log((pass ? "PASS" : "FAIL") + ": scored output matches its frozen file");
if (!pass) failures++;
console.log(failures > 0 ? "\n" + failures + " check(s) FAILED." : "\nAll checks passed.");
process.exit(failures > 0 ? 1 : 0);
