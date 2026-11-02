// The scoring switch, leg by leg: one frozen slate through the engine as it was (WILSON_RULES) and through
// scoring.ts (GENERATOR_RULES). Every leg that changed in the Primary, Hedge or Contrarian is explained in
// scoring-switch-diff.txt, and the scored output is frozen in scoring-switch-frozen.json. Pure - no DB.
//   npx tsx src/lib/parlay/scoring-switch-diff-acceptance-test.ts
//   (re-freeze, only for an intended change: add --write)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GeneratorPick } from "@/lib/parlay/auto-generate";
import { buildGeneratedParlay, GENERATOR_RULES, WILSON_RULES, type EngineSwap, type GeneratedParlay, type GeneratorSettings, type GeneratorSnapshot } from "@/lib/parlay/generator";
import { recordForGate } from "@/lib/parlay/pick-record";
import { scorePick, selectionScore, EMPTY_PLATFORM_RATES } from "@/lib/parlay/scoring";
import { GENERATOR_Z } from "@/lib/parlay/generator-z";
import { wilsonLowerBound } from "@/lib/wilson-lower-bound";
import { buildSnapshot, NOW, pickOf } from "@/lib/parlay/scoring-switch-fixture";

const pct = (x: number) => (x * 100).toFixed(1);
const signed = (x: number) => (x >= 0 ? "+" : "") + pct(x);

function explain(pick: GeneratorPick, snap: GeneratorSnapshot, gate: number): string {
  const r = recordForGate(pick, snap.leagueRecords, snap.categoryRecords, GENERATOR_Z, snap.propMarketRecords);
  const old = r
    ? `old ${r.wins}-${r.losses} raw ${r.winPct.toFixed(1)}% ${r.winPct >= gate ? "passes" : "fails"} wilson ${wilsonLowerBound(r.wins, r.losses, GENERATOR_Z).toFixed(3)}`
    : "old no record";
  const s = scorePick(pick, { leagueRecords: snap.leagueRecords, categoryRecords: snap.categoryRecords, propMarketRecords: snap.propMarketRecords, platformRates: snap.platformRates ?? EMPTY_PLATFORM_RATES, minWinPct: gate });
  if (s.status !== "SCORED") return `${pick.pickId} (${pick.betDetail} ${pick.odds}): ${old}; new no record`;
  const why = s.model === "edge model" ? "edge model" : `win-rate model, ${s.fallback}${s.thin ? `, ${s.thin.binding} edge binds` : ""}`;
  return `${pick.pickId} (${pick.betDetail} ${pick.odds}): ${old}; new ${why}, price ${s.price.status}, edge ${signed(s.rankScore)} vs ${s.gate.requiredEdge === null ? "no gate" : signed(s.gate.requiredEdge)} ${s.gate.passes ? "passes" : "fails"}, -110 equivalent ${pct(selectionScore(s))}`;
}

function diffPrimary(oldP: GeneratedParlay, newP: GeneratedParlay, snap: GeneratorSnapshot, gate: number): string[] {
  const out: string[] = [];
  const keysOf = (p: GeneratedParlay) => new Map(p.legs.map((l) => [l.pick.pickId, l.pick]));
  const a = keysOf(oldP);
  const b = keysOf(newP);
  for (const [id, pick] of a) if (!b.has(id)) out.push(`  out: ${explain(pick, snap, gate)}`);
  for (const [id, pick] of b) if (!a.has(id)) out.push(`  in:  ${explain(pick, snap, gate)}`);
  if (out.length === 0) out.push("  (no change)");
  return out;
}

function diffSwap(title: string, oldS: EngineSwap, newS: EngineSwap, snap: GeneratorSnapshot, gate: number): string[] {
  const out: string[] = [];
  const alt = (s: EngineSwap) => new Map(s.legs.map((l) => [l.original.pick.pickId, l]));
  const a = alt(oldS);
  const b = alt(newS);
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const before = a.get(id);
    const after = b.get(id);
    if (!before || !after) {
      const only = before ?? after!;
      out.push(`  ${before ? "leg gone" : "new leg"} ${id}: alternate ${only.swap ? explain(only.swap.pick, snap, gate) : `none (${only.unchangedReason})`}`);
    } else if ((before.swap?.pick.pickId ?? null) !== (after.swap?.pick.pickId ?? null)) {
      out.push(`  leg ${id}:`);
      out.push(`    old: ${before.swap ? explain(before.swap.pick, snap, gate) : `none (${before.unchangedReason})`}`);
      out.push(`    new: ${after.swap ? explain(after.swap.pick, snap, gate) : `none (${after.unchangedReason})`}`);
    }
  }
  return [`${title}:`, ...(out.length ? out : ["  (no change)"])];
}

const CASES: [string, GeneratorSettings, string[]][] = [
  ["6 legs, best available, default gate", { legCount: 6, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE" }, []],
  ["8 legs, 2 per game, default gate", { legCount: 8, maxLegsPerGame: 2, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE" }, []],
  ["6 legs, 60% gate", { legCount: 6, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE", minWinPct: 60 }, []],
  ["6 legs, no gate", { legCount: 6, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE", minWinPct: 0 }, []],
  ["slip competing on one game, 4 legs", { legCount: 4, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE" }, ["g2-heavy-fav", "g2-mid-under"]],
  ["Your picks only, 2 of 5", { legCount: 2, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "YOUR_PICKS_ONLY" }, ["g1-55-45", "g2-heavy-fav", "g3-thin", "g0-small-spread", "g5-away"]],
];

const lines: string[] = [];
const frozen: Record<string, unknown> = {};
for (const [label, settings, slip] of CASES) {
  const snap = buildSnapshot(undefined, slip);
  const gate = settings.minWinPct ?? 55;
  const oldP = buildGeneratedParlay(snap, settings, null, NOW, WILSON_RULES);
  const newP = buildGeneratedParlay(snap, settings, null, NOW, GENERATOR_RULES);
  lines.push(`=== ${label} ===`);
  lines.push(`old legs: ${oldP.legs.map((l) => l.pick.pickId).join(", ") || "(none)"}`);
  lines.push(`new legs: ${newP.legs.map((l) => l.pick.pickId).join(", ") || "(none)"}`);
  lines.push("Primary:", ...diffPrimary(oldP, newP, snap, gate));
  lines.push(...diffSwap("Hedge (Swap = All)", oldP.hedge.ALL, newP.hedge.ALL, snap, gate));
  lines.push(...diffSwap("Contrarian (Swap = All), its rules unchanged: differences follow from the legs above", oldP.contrarian.ALL, newP.contrarian.ALL, snap, gate));
  lines.push("");
  frozen[label] = { legs: newP.legs.map((l) => l.pick.pickId), hedge: newP.hedge.ALL.legs.map((l) => l.swap?.pick.pickId ?? null), contrarian: newP.contrarian.ALL.legs.map((l) => l.swap?.pick.pickId ?? null), parlay: { ...newP, hedge: newP.hedge.ALL, contrarian: newP.contrarian.ALL } };
}
// The suites pinned to WILSON_RULES keep their old expectations. These are the records those pins read, at their
// fixtures' -110 with no priced history and no platform rates, so each old answer has its scored answer here.
const PINNED: [string, string, [number, number], [number, number]][] = [
  ["generator-gate: 55% exactly passes", "p55", [11, 9], [11, 9]],
  ["generator-gate: 58%, passes 55, rejected at 60", "p58", [29, 21], [29, 21]],
  ["generator-gate: 65%, passes 60 and 65", "p65", [13, 7], [13, 7]],
  ["generator-gate: 70%, passes 60 and 65", "p70", [7, 3], [7, 3]],
  ["generator: a 60% target leg, capacity 5", "over95", [30, 20], [30, 20]],
  ["generator: a 55% target leg, capacity 5", "under95", [11, 9], [11, 9]],
  ["record-scope: 4-1 in MLB qualifies", "lgGood", [4, 1], [4, 6]],
  ["record-scope: no MLB record, all-time 6-4 qualifies", "fallback", [0, 0], [6, 4]],
  ["record-scope: 1-3 in MLB, all-time 11-9 reads", "lgBad", [1, 3], [11, 9]],
  ["soft-sample: 4-1 in NCAAF qualifies", "ncaafGood", [4, 1], [20, 30]],
  ["best-of-two: only 1-0 qualifies", "onlyOne", [1, 0], [1, 0]],
  ["best-of-two: 50-40 in MLB passes 55", "noFallback", [50, 40], [50, 40]],
  ["prop-market-gate: a game line at 6-4 clears 55", "line", [6, 4], [6, 4]],
  ["prop-market-gate: NFL TD on its market at 6-4 clears 55", "nflTd", [6, 4], [6, 4]],
];
lines.push("=== Records behind the pinned suites' old expectations ===");
for (const [label, id, lg, all] of PINNED) {
  const spec = { id, game: 0, category: "FAV_ML" as const, betType: "MONEYLINE", detail: id, odds: -110, source: null, lg, all, hist: null };
  const pinned = buildSnapshot([spec], [], []);
  lines.push(label + ": " + explain(pickOf(spec), pinned, 55));
}
lines.push("");
const diffText = lines.join("\n");
const jsonText = JSON.stringify(frozen, null, 2) + "\n";
const diffPath = join(__dirname, "scoring-switch-diff.txt");
const jsonPath = join(__dirname, "scoring-switch-frozen.json");

if (process.argv.includes("--write")) {
  writeFileSync(diffPath, diffText);
  writeFileSync(jsonPath, jsonText);
  console.log(diffText);
  process.exit(0);
}

let failures = 0;
const norm = (s: string) => s.replace(/\r\n/g, "\n");
for (const [name, got, want] of [["per-leg diff", diffText, norm(readFileSync(diffPath, "utf8"))], ["scored output", jsonText, norm(readFileSync(jsonPath, "utf8"))]] as const) {
  const pass = got === want;
  console.log(`${pass ? "PASS" : "FAIL"}: ${name} matches its frozen file`);
  if (!pass) failures++;
}
console.log(diffText);
console.log(failures > 0 ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures > 0 ? 1 : 0);
