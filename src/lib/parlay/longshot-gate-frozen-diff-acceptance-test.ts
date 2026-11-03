// The long-shot gate (scoring.ts, SCORING_VERSION hier-k20-logit-edge-min5-ls1-v2), frozen: when the win-rate
// gate L > 0, a pick also needs its capper's RAW record in the scored category to clear the break-even of the
// pick's own price. Every NBA same-game case (every Contrarian case, so every selection case, plus the NBA slate)
// is run at gates 0 / 45 / 55 / 60 / 75 through the engine before the rule (longshot-gate-before-frozen.json,
// captured from origin/main 24cbb47) and now. The Primary, Hedge and Contrarian under every Swap setting, the
// dropped slip picks, the shortfall and the rest of the output are compared. Every case that moved is listed in
// longshot-gate-diff.txt with the picks whose gate verdict changed, each with its raw record against its
// break-even. Pure - no DB.
//   npx tsx src/lib/parlay/longshot-gate-frozen-diff-acceptance-test.ts                   check
//   npx tsx src/lib/parlay/longshot-gate-frozen-diff-acceptance-test.ts --write           rewrite the diff table
//   npx tsx src/lib/parlay/longshot-gate-frozen-diff-acceptance-test.ts --capture-before  rewrite the before JSON (base commit only)
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGeneratedParlay, GENERATOR_RULES, type GeneratedParlay } from "@/lib/parlay/generator";
import { NBA_SAMEGAME_CASES, nowOf, snapshotOf, type NbaCase } from "@/lib/parlay/nba-samegame-frozen-cases";
import { EMPTY_PLATFORM_RATES, passesGate, scorePick, type PickScore } from "@/lib/parlay/scoring";
import { SWAP_SCOPES } from "@/lib/parlay/swap-scope";
import type { GeneratorPick } from "@/lib/parlay/auto-generate";

export const LONGSHOT_GATES = [0, 45, 55, 60, 75] as const;

const BEFORE = join(__dirname, "longshot-gate-before-frozen.json");
const DIFF = join(__dirname, "longshot-gate-diff.txt");

type Row = [string, string | null];
type Captured = {
  legs: string[];
  dropped: [string, string][];
  hedge: Record<string, Row[]>;
  contrarian: Record<string, Row[]>;
  shortfall: string[];
  limited: GeneratedParlay["limited"];
  coreSha: string;
};
type Capture = { capturedFrom: string; cases: Record<string, Captured>; verdicts: Record<string, Record<string, boolean>> };

const sha = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 16);
const caseKey = (c: NbaCase, gate: number) => `${c.label} @ ${gate}%`;
const slateKey = (c: NbaCase, gate: number) => `${c.slate} @ ${gate}%`;

function scorer(c: NbaCase, gate: number) {
  const snap = snapshotOf(c);
  const ctx = { leagueRecords: snap.leagueRecords, categoryRecords: snap.categoryRecords, propMarketRecords: snap.propMarketRecords, platformRates: snap.platformRates ?? EMPTY_PLATFORM_RATES, minWinPct: gate };
  return { snap, score: (p: GeneratorPick) => scorePick(p, ctx) };
}

function capture(capturedFrom: string): Capture {
  const out: Capture = { capturedFrom, cases: {}, verdicts: {} };
  for (const c of NBA_SAMEGAME_CASES) {
    for (const gate of LONGSHOT_GATES) {
      const { snap, score } = scorer(c, gate);
      const p = buildGeneratedParlay(snap, { ...c.settings, minWinPct: gate }, null, nowOf(c), GENERATOR_RULES);
      const rows = (s: GeneratedParlay["hedge"]["ALL"]): Row[] => s.legs.map((l) => [l.original.pick.pickId, l.swap?.pick.pickId ?? l.unchangedReason]);
      out.cases[caseKey(c, gate)] = {
        legs: p.legs.map((l) => l.pick.pickId),
        dropped: p.dropped.map((d) => [d.pickId, d.reason]),
        hedge: Object.fromEntries(SWAP_SCOPES.map((s) => [s, rows(p.hedge[s])])),
        contrarian: Object.fromEntries(SWAP_SCOPES.map((s) => [s, rows(p.contrarian[s])])),
        shortfall: p.shortfall,
        limited: p.limited,
        coreSha: sha(p),
      };
      const v = (out.verdicts[slateKey(c, gate)] ??= {});
      for (const pk of [...snap.games.flatMap((g) => g.picks), ...snap.slipPicks]) v[pk.pickId] = passesGate(score(pk), gate);
    }
  }
  return JSON.parse(JSON.stringify(out));
}

if (process.argv.includes("--capture-before")) {
  writeFileSync(BEFORE, JSON.stringify(capture("origin/main 24cbb47 (before the long-shot gate)")) + "\n");
  console.log("wrote " + BEFORE);
  process.exit(0);
}

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

const before = JSON.parse(readFileSync(BEFORE, "utf8")) as Capture;
const now = capture("now");

const list = (ids: string[]) => ids.join(", ") || "(none)";
const swaps = (rows: Row[]) => rows.map(([a, b]) => `${a}->${b}`).join(", ") || "(none)";
function caseDiff(a: Captured, b: Captured): string[] {
  const out: string[] = [];
  if (JSON.stringify(a.legs) !== JSON.stringify(b.legs)) {
    out.push(`  legs: ${list(a.legs)}`, `     -> ${list(b.legs)}`);
    out.push(`     out: ${list(a.legs.filter((x) => !b.legs.includes(x)))}; in: ${list(b.legs.filter((x) => !a.legs.includes(x)))}`);
  }
  if (JSON.stringify(a.dropped) !== JSON.stringify(b.dropped)) out.push(`  dropped: ${JSON.stringify(a.dropped)} -> ${JSON.stringify(b.dropped)}`);
  for (const s of SWAP_SCOPES) {
    if (JSON.stringify(a.hedge[s]) !== JSON.stringify(b.hedge[s])) out.push(`  hedge (${s}): ${swaps(a.hedge[s])}`, `            -> ${swaps(b.hedge[s])}`);
    if (JSON.stringify(a.contrarian[s]) !== JSON.stringify(b.contrarian[s])) out.push(`  contrarian (${s}): ${swaps(a.contrarian[s])}`, `                 -> ${swaps(b.contrarian[s])}`);
  }
  if (JSON.stringify(a.shortfall) !== JSON.stringify(b.shortfall)) out.push(`  shortfall: ${JSON.stringify(a.shortfall)} -> ${JSON.stringify(b.shortfall)}`);
  if (JSON.stringify(a.limited) !== JSON.stringify(b.limited)) out.push(`  limited: ${JSON.stringify(a.limited)} -> ${JSON.stringify(b.limited)}`);
  if (out.length === 0 && a.coreSha !== b.coreSha) out.push("  (other output fields changed)");
  return out;
}

const pct = (x: number) => (x * 100).toFixed(1) + "%";
function why(s: PickScore, odds: number): string {
  if (s.status !== "SCORED") return "no record";
  const wins = s.levels.league.wins + s.levels.otherLeagues.wins;
  const raw = `raw ${wins}-${s.decided - wins} (${pct(wins / s.decided)})`;
  const be = s.breakEven === null ? "no real price" : `break-even ${pct(s.breakEven)} at ${odds > 0 ? "+" : ""}${odds}`;
  return `${raw} vs ${be}; edge ${(s.rankScore * 100).toFixed(1)} vs required ${s.gate.requiredEdge === null ? "none" : (s.gate.requiredEdge * 100).toFixed(1)}`;
}

const lines: string[] = [`Long-shot gate frozen diff: ${before.capturedFrom} -> now, gates ${LONGSHOT_GATES.join(" / ")}.`, ""];

// Picks whose verdict moved, per slate and gate.
lines.push("=== Gate verdicts that changed (slate @ gate: pick, before -> now, why) ===");
const flipsAt = new Map<number, number>();
const wrongWay: string[] = [];
const seenSlate = new Set<string>();
for (const c of NBA_SAMEGAME_CASES) {
  for (const gate of LONGSHOT_GATES) {
    const k = slateKey(c, gate);
    const { snap, score } = scorer(c, gate);
    for (const pk of [...snap.games.flatMap((g) => g.picks), ...snap.slipPicks]) {
      const id = `${k}|${pk.pickId}`;
      if (seenSlate.has(id)) continue;
      seenSlate.add(id);
      const was = before.verdicts[k]?.[pk.pickId];
      const is = now.verdicts[k][pk.pickId];
      if (was === is) continue;
      flipsAt.set(gate, (flipsAt.get(gate) ?? 0) + 1);
      if (!was && is) wrongWay.push(id);
      lines.push(`  ${k}: ${pk.pickId} (${pk.betDetail ?? pk.rawBetDetail} ${pk.odds}) ${was ? "passes" : "fails"} -> ${is ? "passes" : "fails"} · ${why(score(pk), pk.odds)}`);
    }
  }
}
lines.push(`Changed verdicts per gate: ${LONGSHOT_GATES.map((g) => `${g}%: ${flipsAt.get(g) ?? 0}`).join(", ")}`, "");

lines.push("=== Cases whose output changed ===");
const movedAt = new Map<number, number>();
for (const c of NBA_SAMEGAME_CASES) {
  for (const gate of LONGSHOT_GATES) {
    const k = caseKey(c, gate);
    const d = caseDiff(before.cases[k], now.cases[k]);
    if (d.length === 0) continue;
    movedAt.set(gate, (movedAt.get(gate) ?? 0) + 1);
    lines.push(k, ...d);
  }
}
lines.push(`Cases changed per gate (of ${NBA_SAMEGAME_CASES.length} each): ${LONGSHOT_GATES.map((g) => `${g}%: ${movedAt.get(g) ?? 0}`).join(", ")}`);
lines.push("Every other case is byte-identical to before (Primary, dropped, Hedge and Contrarian under every Swap setting, shortfall, the whole output).");

check("the before capture covers every case at every gate", Object.keys(before.cases).length, NBA_SAMEGAME_CASES.length * LONGSHOT_GATES.length);
check("gate 0 is untouched: no verdict and no case moved", [flipsAt.get(0) ?? 0, movedAt.get(0) ?? 0], [0, 0]);
check("the rule only ever removes a pick from the gate, never adds one", wrongWay, []);

const text = lines.join("\n") + "\n";
if (process.argv.includes("--write")) {
  writeFileSync(DIFF, text);
  console.log(text);
  process.exit(0);
}
check("the diff matches longshot-gate-diff.txt", text === readFileSync(DIFF, "utf8").replace(/\r\n/g, "\n"), true);
console.log(text);
console.log(failures > 0 ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
if (failures > 0) process.exit(1);
