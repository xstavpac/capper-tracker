// The NBA same-game fix, in two frozen sections (nba-samegame-diff.txt):
//   1. Same-game rules read NBA props with their sport, and NBA rebounds / steals / blocks are non-offensive:
//      53ad4f5 (before) -> step 1, both captured in nba-samegame-before-frozen.json.
//   2. betKeyOf reads NBA props with their league: step 1 -> now (this checkout). Every NBA prop's key, old
//      and new, and every case whose output moved because of it.
// On NBA_SAMEGAME_CASES (every Contrarian case plus an NBA slate built to stack props). Pure - no DB.
// `--write` rewrites nba-samegame-diff.txt.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGeneratedParlay, GENERATOR_RULES } from "@/lib/parlay/generator";
import { betKeyOf } from "@/lib/parlay/selection";
import { NBA_SAMEGAME_CASES, nowOf, snapshotOf } from "@/lib/parlay/nba-samegame-frozen-cases";
import { LONGSHOT_MOVED_AT_OWN_GATE } from "@/lib/parlay/longshot-gate-moved";

type Row = [string, string | null];
type Captured = { legs: string[]; dropped: [string, string][]; hedge: Row[]; contrarian: Row[]; historyBetKeys: string[] | null; coreSha: string };
type Capture = { cases: Record<string, Captured>; betKeys: Record<string, string> };
const frozen = JSON.parse(readFileSync(join(__dirname, "nba-samegame-before-frozen.json"), "utf8")) as { capturedFrom: { before: string; step1: string }; before: Capture; step1: Capture };

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}
const sha = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 16);

// Now.
const now: Capture = { cases: {}, betKeys: {} };
for (const c of NBA_SAMEGAME_CASES) {
  const snap = snapshotOf(c);
  for (const pk of snap.games.flatMap((g) => g.picks)) if (pk.betType === "PLAYER_PROP") now.betKeys[`${c.slate}:${pk.pickId}`] = betKeyOf(pk);
  const p = buildGeneratedParlay(snap, c.settings, null, nowOf(c), GENERATOR_RULES);
  const { historyBetKeys, ...core } = p;
  const row = (s: typeof p.hedge.ALL): Row[] => s.legs.map((l) => [l.original.pick.pickId, l.swap?.pick.pickId ?? l.unchangedReason]);
  now.cases[c.label] = { legs: p.legs.map((l) => l.pick.pickId), dropped: p.dropped.map((d) => [d.pickId, d.reason]), hedge: row(p.hedge.ALL), contrarian: row(p.contrarian.ALL), historyBetKeys: historyBetKeys ?? null, coreSha: sha(core) };
}

const list = (ids: string[]) => ids.join(", ") || "(none)";
const swaps = (rows: Row[]) => rows.map(([a, b]) => `${a}->${b}`).join(", ");
function caseDiff(label: string, a: Captured, b: Captured): string[] {
  const out: string[] = [];
  if (JSON.stringify(a.legs) !== JSON.stringify(b.legs)) {
    out.push(`  legs: ${list(a.legs)}`, `     -> ${list(b.legs)}`);
    const gone = a.legs.filter((x) => !b.legs.includes(x));
    const added = b.legs.filter((x) => !a.legs.includes(x));
    if (gone.length || added.length) out.push(`     out: ${list(gone)}; in: ${list(added)}`);
  }
  if (JSON.stringify(a.dropped) !== JSON.stringify(b.dropped)) out.push(`  dropped: ${JSON.stringify(a.dropped)} -> ${JSON.stringify(b.dropped)}`);
  if (JSON.stringify(a.hedge) !== JSON.stringify(b.hedge)) out.push(`  hedge: ${swaps(a.hedge)}`, `      -> ${swaps(b.hedge)}`);
  if (JSON.stringify(a.contrarian) !== JSON.stringify(b.contrarian)) out.push(`  contrarian: ${swaps(a.contrarian)}`, `           -> ${swaps(b.contrarian)}`);
  if (out.length === 0 && a.coreSha !== b.coreSha) out.push("  (other output fields changed)");
  return out.length ? [label, ...out] : [];
}

const lines: string[] = [];
// ---- Section 1 ----
lines.push(`=== 1. Same-game rules with the sport (+ NBA rebounds/steals/blocks non-offensive): ${frozen.capturedFrom.before} -> ${frozen.capturedFrom.step1} ===`);
let moved1 = 0;
for (const c of NBA_SAMEGAME_CASES) {
  const d = caseDiff(c.label, frozen.before.cases[c.label], frozen.step1.cases[c.label]);
  if (d.length) {
    moved1++;
    lines.push(...d);
  }
}
lines.push(`${moved1} of ${NBA_SAMEGAME_CASES.length} cases changed; every other case is identical.`, "");

// ---- Section 2 ----
lines.push(`=== 2. betKeyOf reads NBA props with their league: ${frozen.capturedFrom.step1} -> now ===`);
lines.push("NBA prop keys (old -> new):");
for (const [id, key] of Object.entries(now.betKeys)) {
  const was = frozen.step1.betKeys[id];
  if (was !== key) lines.push(`  ${id}: ${was} -> ${key}`);
}
const unchangedKeys = Object.entries(now.betKeys).filter(([id, key]) => frozen.step1.betKeys[id] === key).map(([id]) => id);
lines.push(`  unchanged (props the no-sport chain already read): ${list(unchangedKeys)}`);
let moved2 = 0;
const keyOnly: string[] = [];
for (const c of NBA_SAMEGAME_CASES) {
  const a = frozen.step1.cases[c.label];
  const b = now.cases[c.label];
  // Moved later by the long-shot gate (ls1), not by betKeyOf: longshot-gate-diff.txt has them in full. Their
  // NBA prop keys are still compared below through historyBetKeys.
  if (LONGSHOT_MOVED_AT_OWN_GATE.includes(c.label)) {
    if (JSON.stringify(a.historyBetKeys) !== JSON.stringify(b.historyBetKeys)) keyOnly.push(c.label);
    continue;
  }
  const d = caseDiff(c.label, a, b);
  if (d.length) {
    moved2++;
    lines.push(...d);
  } else if (JSON.stringify(a.historyBetKeys) !== JSON.stringify(b.historyBetKeys)) keyOnly.push(c.label);
}
lines.push(`Parlays whose legs, Hedge or Contrarian moved because of the key: ${moved2}.`);
lines.push(`Not compared here, moved by the long-shot gate instead (longshot-gate-diff.txt): ${list([...LONGSHOT_MOVED_AT_OWN_GATE])}`);
lines.push(`Parlays whose only change is the NBA prop's key in historyBetKeys (what the next Regenerate weighs down): ${keyOnly.length}`);
for (const l of keyOnly) lines.push(`  ${l}`);
lines.push("");

check("section 2: betKeyOf moves no leg, Hedge or Contrarian on any case", moved2, 0);
check("section 2: NFL / NHL / MLB prop keys unchanged", Object.entries(now.betKeys).filter(([id, key]) => !id.startsWith("NBA:") && !/^(SWITCH:g4|MIXED:n1)/.test(id) && frozen.step1.betKeys[id] !== key), []);

const text = lines.join("\n");
const path = join(__dirname, "nba-samegame-diff.txt");
if (process.argv.includes("--write")) {
  writeFileSync(path, text);
  console.log(text);
  process.exit(0);
}
check("both sections match nba-samegame-diff.txt", text === readFileSync(path, "utf8").replace(/\r\n/g, "\n"), true);
console.log(text);
console.log(failures > 0 ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
if (failures > 0) process.exit(1);
