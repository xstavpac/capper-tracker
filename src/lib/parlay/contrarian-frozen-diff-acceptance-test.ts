// PR 7's frozen diff: Contrarian before (contrarian-before-frozen.json, captured from de0719e: the classifier's
// R2/R3, the raw win-% gate, Wilson order) and now (the other side of the same bet, scoring.ts's gate,
// selection.ts) on CONTRARIAN_CASES. Everything but Contrarian (Primary, Hedge, notes) must be byte-identical
// to before; every Contrarian leg that changed is listed with its reason in contrarian-diff.txt, with
// availability old vs new by market and why the new rule missed. Pure - no DB.
// `--write` rewrites contrarian-diff.txt.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGeneratedParlay, GENERATOR_RULES } from "@/lib/parlay/generator";
import { SWAP_SCOPES, type SwapScope } from "@/lib/parlay/swap-scope";
import { TraceCollector, type SwapLegTrace } from "@/lib/parlay/run-trace";
import { CONTRARIAN_MARKETS, contrarianMarketOf, isSoccer, YES_NO_PROP_MARKETS, type ContrarianMarket } from "@/lib/parlay/contrarian-match";
import { describeProp } from "@/lib/parlay/relationship-classifier";
import { CONTRARIAN_CASES, nowOf, snapshotOf } from "@/lib/parlay/contrarian-frozen-cases";
import type { GeneratorPick } from "@/lib/parlay/auto-generate";

type Row = [string, string | null, string | null];
type Before = { legs: string[]; restSha: string; contrarian: Record<SwapScope, Row[]> };
const before = JSON.parse(readFileSync(join(__dirname, "contrarian-before-frozen.json"), "utf8")) as { capturedFrom: string; cases: Record<string, Before> };

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}
const sha = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 16);
const pct = (n: number, d: number) => (d === 0 ? "  -  " : `${((n / d) * 100).toFixed(0).padStart(3)}%`);

// Why a leg can't have a Contrarian at all under the new rule, whatever is on the board.
function excludedMarket(p: GeneratorPick): boolean {
  if (p.betType === "MONEYLINE") return isSoccer(p.leagueName);
  if (p.betType !== "PLAYER_PROP") return false;
  const d = describeProp({ betType: p.betType, period: p.period, betDetail: p.rawBetDetail, line: p.line }, p.leagueName);
  return d.status === "OK" && YES_NO_PROP_MARKETS.has(d.market);
}

type Miss = "OUTSIDE_TOLERANCE" | "BELOW_GATE" | "NO_OPPOSITE" | "EXCLUDED_MARKET";
const MISSES: Miss[] = ["OUTSIDE_TOLERANCE", "BELOW_GATE", "NO_OPPOSITE", "EXCLUDED_MARKET"];
// oldCross: old Contrarians on another betType (ML <-> spread), which the same-bet rule drops by design.
type Tally = { legs: number; old: number; oldCross: number; now: number; misses: Record<Miss, number> };
const tally = new Map<ContrarianMarket | "OTHER", Tally>();
const tallyOf = (k: ContrarianMarket | "OTHER") => {
  let t = tally.get(k);
  if (!t) tally.set(k, (t = { legs: 0, old: 0, oldCross: 0, now: 0, misses: { OUTSIDE_TOLERANCE: 0, BELOW_GATE: 0, NO_OPPOSITE: 0, EXCLUDED_MARKET: 0 } }));
  return t;
};

const lines: string[] = [
  `Contrarian before (${before.capturedFrom}: classifier R2/R3, raw win-% gate, Wilson) vs now (same bet, other side; scoring.ts gate; selection.ts).`,
  "Per leg, Swap = All: leg -> old alternate (rule or reason) | new alternate (market, line gap) or reason.",
  "",
];

for (const c of CONTRARIAN_CASES) {
  const was = before.cases[c.label];
  if (!was) {
    check(`${c.label}: captured before`, false, true);
    continue;
  }
  const snap = snapshotOf(c);
  const betTypeOf = new Map(snap.games.flatMap((g) => g.picks).map((p) => [p.pickId, p.betType]));
  const trace = new TraceCollector({ mode: "STANDARD", trigger: "GENERATE", origin: "CLIENT", scoringVersion: "test", settings: {} }, false);
  const now = buildGeneratedParlay(snap, c.settings, null, nowOf(c), GENERATOR_RULES, trace);
  const { contrarian, ...rest } = now;
  check(`${c.label} · Primary unchanged`, now.legs.map((l) => l.pick.pickId), was.legs);
  check(`${c.label} · Primary, Hedge and notes byte-identical`, sha(rest), was.restSha);
  // The Swap setting decides which legs are searched exactly as before.
  for (const scope of SWAP_SCOPES) {
    const outNow = contrarian[scope].legs.map((l) => l.unchangedReason === "OUT_OF_SCOPE");
    const outWas = was.contrarian[scope].map((r) => r[2] === "OUT_OF_SCOPE");
    check(`${c.label} · Swap ${scope}: the same legs out of scope`, outNow, outWas);
  }
  const legTraces = new Map<string, SwapLegTrace>(
    (trace.finish().extras.swaps ?? []).find((m) => m.mode === "CONTRARIAN" && m.scope === "ALL")?.legs.map((l) => [l.pick.id, l]) ?? []
  );

  lines.push(c.label);
  contrarian.ALL.legs.forEach((l, i) => {
    const id = l.original.pick.pickId;
    const [, oldTo, oldWhy] = was.contrarian.ALL[i];
    const newTo = l.swap?.pick.pickId ?? null;
    const t = tallyOf(contrarianMarketOf(l.original.pick.betType) ?? "OTHER");
    t.legs++;
    if (oldTo) t.old++;
    if (oldTo && betTypeOf.get(oldTo) !== l.original.pick.betType) t.oldCross++;
    let newText: string;
    if (l.swap) {
      t.now++;
      const gap = l.swap.contrarian?.lineGap;
      newText = `${newTo} (${l.swap.contrarian?.market}${gap === null || gap === undefined ? "" : `, gap ${gap}`})`;
    } else {
      const ct = legTraces.get(id)?.contrarian;
      const miss: Miss = excludedMarket(l.original.pick)
        ? "EXCLUDED_MARKET"
        : ct && ct.opposite > 0
          ? "BELOW_GATE"
          : ct && ct.lineTooFar > 0
            ? "OUTSIDE_TOLERANCE"
            : "NO_OPPOSITE";
      t.misses[miss]++;
      newText = `none (${l.unchangedReason}: ${miss})`;
    }
    const oldText = oldTo ? `${oldTo} (${oldWhy})` : `none (${oldWhy})`;
    lines.push(`  ${oldTo === newTo ? " " : "*"} ${id} -> old ${oldText} | new ${newText}`);
  });
  lines.push("");
}

// Availability: every leg of every case under Swap = All (a leg that appears in several cases counts each time).
const order: (ContrarianMarket | "OTHER")[] = [...CONTRARIAN_MARKETS, "OTHER"];
const total: Tally = { legs: 0, old: 0, oldCross: 0, now: 0, misses: { OUTSIDE_TOLERANCE: 0, BELOW_GATE: 0, NO_OPPOSITE: 0, EXCLUDED_MARKET: 0 } };
lines.push("Availability (Swap = All, every case's legs): legs with a Contrarian, old vs new.");
lines.push("market      legs   old         old same-type   new         new misses: outside tolerance / below gate / no opposite pick / excluded market");
const flagged: string[] = [];
for (const k of order) {
  const t = tally.get(k);
  if (!t) continue;
  total.legs += t.legs;
  total.old += t.old;
  total.oldCross += t.oldCross;
  total.now += t.now;
  for (const mm of MISSES) total.misses[mm] += t.misses[mm];
  if (t.old > 0 && t.now * 2 < t.old) flagged.push(k);
  lines.push(
    `${k.padEnd(10)} ${String(t.legs).padStart(5)}   ${String(t.old).padStart(3)} ${pct(t.old, t.legs)}    ${String(t.old - t.oldCross).padStart(3)} ${pct(t.old - t.oldCross, t.legs)}        ${String(t.now).padStart(3)} ${pct(t.now, t.legs)}    ${MISSES.map((mm) => t.misses[mm]).join(" / ")}${t.old > 0 && t.now * 2 < t.old ? "   << new under half of old" : ""}`
  );
}
lines.push(
  `${"ALL".padEnd(10)} ${String(total.legs).padStart(5)}   ${String(total.old).padStart(3)} ${pct(total.old, total.legs)}    ${String(total.old - total.oldCross).padStart(3)} ${pct(total.old - total.oldCross, total.legs)}        ${String(total.now).padStart(3)} ${pct(total.now, total.legs)}    ${MISSES.map((mm) => total.misses[mm]).join(" / ")}`
);
lines.push("old same-type = old Contrarians whose alternate was the same betType (the ML <-> spread cross pairs taken out).");
lines.push(flagged.length > 0 ? `FLAG: new availability is under half of old for ${flagged.join(", ")}${total.now * 2 < total.old ? " (and overall)" : ""}.` : "No market fell under half of its old availability.");
lines.push("");

const text = lines.join("\n");
const path = join(__dirname, "contrarian-diff.txt");
if (process.argv.includes("--write")) {
  writeFileSync(path, text);
  console.log(text);
  process.exit(0);
}
check("per-leg table and availability match contrarian-diff.txt", text === readFileSync(path, "utf8").replace(/\r\n/g, "\n"), true);
console.log(text);
console.log(failures > 0 ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
if (failures > 0) process.exit(1);
