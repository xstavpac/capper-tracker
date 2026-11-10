// Consensus Hybrid onto scoring.ts (PR 8), frozen. Every case in hybrid-scoring-frozen-cases.ts (the 10/27
// slate twice, the all-leagues cases, long dogs at posted prices, an edge-model capper, the consensus
// shapes) at gates 0 / 45 / 55 / 60, through hybrid-scoring-frozen-capture.ts:
//   - WILSON (the rollback) must be byte-identical to the before JSON (__fixtures__/hybrid-scoring-before-frozen.json,
//     written by the capture file on origin/main 5f64665).
//   - SCORING (the default: the capper's actual record gates - either the in-league or the all-leagues record
//     reaching the lever - and the shrunk rankScore at the posted price only orders) is diffed against it.
//     hybrid-scoring-diff.txt lists every position that came, went, flipped direction, changed anchor or
//     changed its top supporter, the box-eligible games, boxes and legs before and after for every case and
//     gate, and why: each post whose gate verdict changed, with both records.
// Pure - no DB.
//   npx tsx src/lib/parlay/hybrid-scoring-frozen-diff-acceptance-test.ts          check
//   npx tsx src/lib/parlay/hybrid-scoring-frozen-diff-acceptance-test.ts --write  rewrite the diff table
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GENERATOR_Z } from "@/lib/parlay/generator";
import { recordForGate } from "@/lib/parlay/pick-record";
import { qualifies, wilsonLowerBound } from "@/lib/parlay/qualification-core";
import { EMPTY_PLATFORM_RATES, scorePickBestOfTwo, type PickScore } from "@/lib/parlay/scoring";
import { capture, captureKey, type Capture, type CapturedCase } from "@/lib/parlay/hybrid-scoring-frozen-capture";
import { caseSnapshot, FROZEN_CASES, FROZEN_GATES, type FrozenCase } from "@/lib/parlay/hybrid-scoring-frozen-cases";
import { hybridScoringVersion } from "@/lib/parlay/run-trace";

const BEFORE = join(__dirname, "__fixtures__", "hybrid-scoring-before-frozen.json");
const DIFF = join(__dirname, "hybrid-scoring-diff.txt");

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

const before = JSON.parse(readFileSync(BEFORE, "utf8")) as Capture;
const scoring = capture("now, SCORING");

// ---- The before capture is frozen (origin/main 5f64665, when the WILSON rollback still existed) ----
check("the before capture covers every case at every gate", Object.keys(before.cases).sort(), Object.keys(scoring.cases).sort());
const version = hybridScoringVersion();
check("SCORING's version names scoring.ts's rules and fits the 80-character intake", [version, version.length < 80], ["hybrid/hier-k20-logit-edge-min5-ls1-v2/hyb-rawgate-bo2-v2", true]);

// ---- The diff ----
type Pos = [string, number, boolean, [string, string, number, number, string, number, number][], string[], number];
const gameFamily = (key: string) => key.split("|").slice(0, 2).join("|");
const sup = (p: Pos) => (p[3][0] ? `${p[3][0][0]} ${p[3][0][2]}-${p[3][0][3]} (${p[3][0][1] === "LEAGUE" ? "in-league" : "all-leagues"})` : "-");
const pct = (x: number) => (x * 100).toFixed(1) + "%";

function positionDiff(a: CapturedCase, b: CapturedCase, label: (id: string) => string): string[] {
  const out: string[] = [];
  const A = new Map((a.positions as Pos[]).map((p) => [gameFamily(p[0]), p]));
  const B = new Map((b.positions as Pos[]).map((p) => [gameFamily(p[0]), p]));
  const name = (gf: string) => `${label(gf.split("|")[0])} ${gf.split("|")[1].toLowerCase()}`;
  for (const [gf, p] of A) {
    const q = B.get(gf);
    const dir = (x: Pos) => x[0].split("|")[2];
    if (!q) out.push(`  - ${name(gf)}: ${dir(p)} by ${sup(p)} is gone`);
    else {
      if (dir(p) !== dir(q)) out.push(`  ~ ${name(gf)}: direction ${dir(p)} (${sup(p)}) -> ${dir(q)} (${sup(q)})`);
      else if (p[3][0]?.[0] !== q[3][0]?.[0]) out.push(`  ~ ${name(gf)} ${dir(q)}: top supporter ${sup(p)} -> ${sup(q)}`);
      if (p[1] !== q[1]) out.push(`  ~ ${name(gf)} ${dir(q)}: anchor ${p[1]} -> ${q[1]}`);
      const ids = (x: Pos) => x[3].map((s) => s[0]).join(",");
      if (dir(p) === dir(q) && ids(p) !== ids(q)) out.push(`  ~ ${name(gf)} ${dir(q)}: supporters [${ids(p)}] -> [${ids(q)}]`);
    }
  }
  for (const [gf, q] of B) if (!A.has(gf)) out.push(`  + ${name(gf)}: ${q[0].split("|")[2]} by ${sup(q)} is new`);
  const order = (c: CapturedCase) => (c.positions as Pos[]).map((p) => gameFamily(p[0])).filter((gf) => A.has(gf) && B.has(gf)).join(" ");
  if (order(a) !== order(b)) out.push(`  ~ rank order of the positions on both sides changed (edge at the posted price, not Wilson)`);
  return out;
}

type Delivery = { deliveredLegs: number; requestedLegs: number; boxes: number; qualifyingGames: number };
function resultDiff(a: CapturedCase, b: CapturedCase, label: (id: string) => string): string[] {
  const out: string[] = [];
  const list = (ids: string[]) => ids.map(label).join(", ") || "(none)";
  if (JSON.stringify(a.boxes) !== JSON.stringify(b.boxes)) out.push(`  box-eligible: ${list(a.boxes)}`, `             -> ${list(b.boxes)}`);
  if (JSON.stringify(a.priced) !== JSON.stringify(b.priced)) out.push(`  priced: ${list(a.priced)}`, `       -> ${list(b.priced)}`);
  const ra = a.result as { p: { s: string; legs: unknown[][] } | null; d: Delivery; note: string | null };
  const rb = b.result as typeof ra;
  const shape = (r: typeof ra) => (r.p ? `${r.p.s}, ${r.d.boxes} box${r.d.boxes === 1 ? "" : "es"}, ${r.d.deliveredLegs}/${r.d.requestedLegs} legs` : `none (${r.note})`);
  if (shape(ra) !== shape(rb)) out.push(`  parlay: ${shape(ra)} -> ${shape(rb)}`);
  else if (JSON.stringify(ra.p?.legs) !== JSON.stringify(rb.p?.legs)) out.push(`  parlay: same shape (${shape(rb)}), different legs or order`);
  const why = (c: CapturedCase) => new Map(c.skipped.map(([id, , text]) => [id, text]));
  const wa = why(a);
  const wb = why(b);
  for (const id of new Set([...wa.keys(), ...wb.keys()])) {
    if (wa.get(id) !== wb.get(id)) out.push(`  why ${label(id)}: ${wa.get(id) ?? "(used)"} -> ${wb.get(id) ?? "(used)"}`);
  }
  return out;
}

// Every post whose gate verdict moved on the games the diff touched: both records, and the score that ranks.
const half = (h: { wins: number; losses: number; winPct: number; clears: boolean } | null) => (h ? `${h.wins}-${h.losses} ${h.winPct.toFixed(1)}%${h.clears ? " ✓" : ""}` : "none");
const rankText = (s: PickScore | null) => (s && s.status === "SCORED" ? `edge ${(s.rankScore * 100).toFixed(1)}` : "unranked");
function postLines(c: FrozenCase, gate: number, games: Set<string>): string[] {
  const snap = caseSnapshot(c);
  const ctx = { leagueRecords: snap.leagueRecords, categoryRecords: snap.categoryRecords, platformRates: snap.platformRates ?? EMPTY_PLATFORM_RATES, minWinPct: gate };
  const out: string[] = [];
  for (const g of snap.games) {
    if (!games.has(g.gameId)) continue;
    for (const p of g.picks) {
      const r = recordForGate(p, snap.leagueRecords, snap.categoryRecords, GENERATOR_Z);
      const b = scorePickBestOfTwo(p, ctx);
      const was = qualifies(r, gate);
      const is = b.passes;
      const odds = p.odds > 0 ? "+" + p.odds : String(p.odds);
      const w = r ? `${r.wins}-${r.losses} ${r.source === "LEAGUE" ? "lg" : "all"} ${r.winPct.toFixed(1)}%, Wilson ${pct(wilsonLowerBound(r.wins, r.losses, GENERATOR_Z))}` : "no record";
      const s = `in-league ${half(b.raw.inLeague)}; all-leagues ${half(b.raw.allLeagues)}; ranks by ${b.chosenFrom === null ? "nothing" : b.chosenFrom === "IN_LEAGUE" ? "in-league" : "all-leagues"} ${rankText(b.chosen)}`;
      out.push(`    ${was === is ? "  " : is ? "+ " : "- "}${g.gameLabel}: ${p.capperId} ${p.betDetail} ${odds} · WILSON ${w} ${was ? "passes" : "fails"} · SCORING ${is ? "passes" : "fails"} (${s})`);
    }
  }
  return out;
}
const lines: string[] = [`Consensus Hybrid scoring frozen diff: ${before.capturedFrom} -> SCORING (${version}), gates ${FROZEN_GATES.join(" / ")}.`];
lines.push(`The before capture is frozen from origin/main 5f64665, when the WILSON rollback still existed (removed in PR 9); ${Object.keys(before.cases).length} case/gate runs.`, "");
lines.push("Legend: - position gone, + new, ~ changed. Post lines: + passes now (failed before), - fails now (passed before), blank = same verdict.", "");
let moved = 0;
for (const c of FROZEN_CASES) {
  const label = (id: string) => c.slate.find((g) => g.id === id)?.label ?? id;
  for (const gate of FROZEN_GATES) {
    const k = captureKey(c, gate);
    const a = before.cases[k];
    const b = scoring.cases[k];
    const d = [...positionDiff(a, b, label), ...resultDiff(a, b, label)];
    if (d.length === 0) continue;
    moved++;
    lines.push(k, ...d);
    const touched = new Set<string>();
    for (const x of [...(a.positions as Pos[]), ...(b.positions as Pos[])]) touched.add(x[0].split("|")[0]);
    const changedGames = new Set(
      [...touched].filter((id) => {
        const of = (cc: CapturedCase) => JSON.stringify([(cc.positions as Pos[]).filter((p) => p[0].startsWith(id + "|")).map((p) => [p[0], p[1], p[3].map((s) => s[0])]), cc.skipped.filter((s) => s[0] === id)]);
        return of(a) !== of(b);
      })
    );
    for (const s of a.skipped) if (JSON.stringify(s) !== JSON.stringify(b.skipped.find((x) => x[0] === s[0]))) changedGames.add(s[0]);
    for (const s of b.skipped) if (!a.skipped.some((x) => x[0] === s[0])) changedGames.add(s[0]);
    if (changedGames.size > 0) lines.push("  posts on the games that changed:", ...postLines(c, gate, changedGames));
    lines.push("");
  }
}
lines.push(`Case/gate runs that changed: ${moved} of ${Object.keys(before.cases).length}. Every other run is byte-identical to before.`, "");
lines.push("=== Box-eligible games, boxes and legs, before -> after (case @ gate) ===");
const shape = (cc: CapturedCase) => {
  const d = (cc.result as { d: Delivery }).d;
  return `${cc.boxes.length} box-eligible, ${d.boxes} boxes, ${d.deliveredLegs}/${d.requestedLegs} legs, ${cc.positions.length} positions`;
};
for (const k of Object.keys(before.cases)) lines.push(`${k.padEnd(38)} ${shape(before.cases[k])}  ->  ${shape(scoring.cases[k])}`);

// ---- Pinned outcomes ----
const at = (name: string, gate: number) => scoring.cases[`${name} @ ${gate}%`];
const has = (cc: CapturedCase, id: string, family: string) => (cc.positions as Pos[]).some((p) => p[0].startsWith(id + "|" + family + "|"));
check("raw gate: the 0-3 dog at +300 makes no position at any gate above 0", [45, 55, 60].map((g) => has(at("long dogs", g), "LD1", "SIDE")), [false, false, false]);
check("...and does at 0 (any graded record)", has(at("long dogs", 0), "LD1", "SIDE"), true);
check("either record: the 30-20 all / 2-8 in-league capper (Wide) qualifies at 55 and 60 on the all-leagues record", [55, 60].map((g) => has(at("all-leagues vs in-league", g), "AL1", "SIDE")), [true, true]);
check("either record: the 8-0 in-league / 20-30 overall capper (Local) is a position at every gate, 0 to 60", FROZEN_GATES.map((g) => has(at("all-leagues vs in-league", g), "AL2", "SIDE")), [true, true, true, true]);
// Devils @ Stars total: Porter PICKS' Under is 4-2 in the NHL (12-19 overall), so it passes the raw gate at 55 and 60
// (the shrunk gate dropped it). At 55 the direction contest is decided by the shrunk score, and Porter's -5.5 loses to
// O2's 5-4 Over (+0.7): the Over is the position, Porter an opposer. At 60 O2 (55.6%) fails the gate and the Under stands.
const devilsTotal = (g: number) => (at("slate-10-27", g).positions as Pos[]).filter((p) => p[0].startsWith("NHL2|TOTAL|")).map((p) => [p[0].split("|")[2], p[3].map((s) => s[0]), p[4]]);
check("Devils @ Stars has its total back at 55 (a box again): the Over by O2, with Porter PICKS' Under an opposer", devilsTotal(55), [["OVER", ["O2"], ["Porter PICKS"]]]);
check("...and at 60 it is Porter PICKS' Under", devilsTotal(60), [["UNDER", ["Porter PICKS"], []]]);
const b55 = (before.cases["slate-10-27 @ 55%"].result as { d: Delivery }).d;
check("the 10/27 slate before: 5 boxes, 10 of 15 legs", [b55.boxes, b55.deliveredLegs, b55.requestedLegs], [5, 10, 15]);

const text = lines.join("\n") + "\n";
if (process.argv.includes("--write")) {
  writeFileSync(DIFF, text);
  console.log(text);
  process.exit(0);
}
check("the diff matches hybrid-scoring-diff.txt", text === readFileSync(DIFF, "utf8").replace(/\r\n/g, "\n"), true);
console.log(text);
console.log(failures > 0 ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
if (failures > 0) process.exit(1);
