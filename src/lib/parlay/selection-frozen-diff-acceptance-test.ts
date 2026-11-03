// The selection layer (PR 5), leg by leg: the scoring switch's slate through the engine before selection.ts
// (selection-before-frozen.json, captured from a2a012f) and through it now, on SELECTION_CASES. Every leg is
// listed with its old score (the -110 equivalent the bands read, %) and its new one (the edge in points);
// every leg that came or went, and every Hedge alternate that changed, says why. The table is frozen in
// selection-diff.txt. Contrarian was byte-identical here through PR 6; PR 7 redefined it (contrarian-diff.txt), so
// only its Swap-setting scope is still checked here.
// Pure - no DB.
//   npx tsx src/lib/parlay/selection-frozen-diff-acceptance-test.ts
//   (re-freeze the table, only for an intended change: add --write)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGeneratedParlay, GENERATOR_RULES, type EngineSwap } from "@/lib/parlay/generator";
import { buildSnapshot, NOW } from "@/lib/parlay/scoring-switch-fixture";
import { SELECTION_CASES } from "@/lib/parlay/selection-frozen-cases";
import { EMPTY_PLATFORM_RATES, scorePick } from "@/lib/parlay/scoring";
import { SWAP_SCOPES } from "@/lib/parlay/swap-scope";

type Before = { legs: { id: string; source: string; score: number | null }[]; hedge: (string | null)[]; contrarian: Record<string, EngineSwap> };
const before = JSON.parse(readFileSync(join(__dirname, "selection-before-frozen.json"), "utf8")) as { capturedFrom: string; cases: Record<string, Before> };

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

const f1 = (x: number | null | undefined) => (x === null || x === undefined ? "-" : x.toFixed(2));

const lines: string[] = [`Before: ${before.capturedFrom}. Old score = the -110 equivalent (%), new = edge in points (rankScore x 100).`, ""];
for (const c of SELECTION_CASES) {
  const snap = buildSnapshot(undefined, c.slip);
  const was = before.cases[c.label];
  const now = buildGeneratedParlay(snap, c.settings, null, NOW, GENERATOR_RULES);
  const ctx = { leagueRecords: snap.leagueRecords, categoryRecords: snap.categoryRecords, propMarketRecords: snap.propMarketRecords, platformRates: snap.platformRates ?? EMPTY_PLATFORM_RATES, minWinPct: c.settings.minWinPct ?? 55 };
  const pts = (id: string) => {
    const pick = snap.games.flatMap((g) => g.picks).find((p) => p.pickId === id) ?? snap.slipPicks.find((p) => p.pickId === id);
    const s = pick ? scorePick(pick, ctx) : null;
    return s?.status === "SCORED" ? s.rankScore * 100 : null;
  };
  // The long-shot rule (ls1) is what fails it: the edge alone still clears the gate.
  const rawFails = (id: string) => {
    const pick = snap.games.flatMap((g) => g.picks).find((p) => p.pickId === id) ?? snap.slipPicks.find((p) => p.pickId === id);
    const s = pick ? scorePick(pick, ctx) : null;
    return s?.status === "SCORED" && s.gate.raw !== null && !s.gate.raw.clears;
  };
  const oldIds = was.legs.map((l) => l.id);
  const newIds = now.legs.map((l) => l.pick.pickId);
  lines.push(`=== ${c.label} ===`);
  lines.push(`old legs: ${oldIds.join(", ") || "(none)"}`);
  lines.push(`new legs: ${newIds.join(", ") || "(none)"}`);
  for (const l of was.legs) {
    const kept = newIds.includes(l.id);
    const scoreOld = l.score === null ? "slip" : `${(l.score * 100).toFixed(2)}%`;
    lines.push(`  ${kept ? "same" : "OUT "} ${l.id} [${l.source}] old ${scoreOld} -> new ${f1(pts(l.id))} pts${kept ? "" : " - see the reason under IN"}`);
  }
  const added = now.legs.filter((l) => !oldIds.includes(l.pick.pickId));
  for (const l of added) {
    const why =
      c.settings.fillFrom === "YOUR_PICKS_ONLY"
        ? "Generate's tie-break is now score, betKey, pick id (was score, decided, pick id)"
        : l.pick.betType === "PLAYER_PROP" && l.pick.leagueName === "NBA"
          ? "an NBA prop now stacks on its game: the same-game rules read it with its sport (the NBA same-game fix, after PR 7)"
          : "single-swap repair: the greedy fill came up short and dropping one leg let two fit (selection.ts selectLegs)";
    lines.push(`  IN   ${l.pick.pickId} [${l.source}] new ${f1(l.score ?? pts(l.pick.pickId))} pts - ${why}`);
  }
  // Hedge.
  const hedgeNow = now.hedge.ALL.legs.map((l) => l.swap?.pick.pickId ?? null);
  const hedgeLines: string[] = [];
  now.hedge.ALL.legs.forEach((l, i) => {
    const old = oldIds.indexOf(l.original.pick.pickId) >= 0 ? was.hedge[oldIds.indexOf(l.original.pick.pickId)] : undefined;
    const nowAlt = l.swap?.pick.pickId ?? null;
    if (old === undefined) hedgeLines.push(`  new leg ${l.original.pick.pickId}: alternate ${nowAlt ?? `none (${l.unchangedReason})`}`);
    else if (old !== nowAlt) {
      const why =
        nowAlt && oldIds.includes(nowAlt) && !newIds.includes(nowAlt)
          ? `${nowAlt} was a leg before and no longer is, so it is free to be the alternate`
          : old && rawFails(old)
            ? `${old} no longer clears the gate: the long-shot rule (ls1), its raw record is under its own price's break-even`
            : "selection.ts order (score, betKey, id)";
      hedgeLines.push(`  leg ${l.original.pick.pickId}: ${old ?? "none"} (${f1(old ? pts(old) : null)}) -> ${nowAlt ?? "none"} (${f1(nowAlt ? pts(nowAlt) : null)}) - ${why}`);
    }
    void i;
  });
  lines.push("Hedge (Swap = All):", ...(hedgeLines.length ? hedgeLines : [`  (no change) ${hedgeNow.map((h) => h ?? "-").join(", ")}`]));
  // Contrarian: PR 5 left it byte-identical; PR 7 redefined it (the other side of the same bet, scored). Its
  // before/after is contrarian-frozen-diff-acceptance-test.ts (contrarian-diff.txt), on these same cases.
  // What still holds here: the Swap setting leaves exactly the same legs out of scope.
  const samePrimary = JSON.stringify(was.legs.map((l) => [l.id, l.source])) === JSON.stringify(now.legs.map((l) => [l.pick.pickId, l.source]));
  if (samePrimary) {
    for (const scope of SWAP_SCOPES) {
      const outOf = (s: EngineSwap) => s.legs.map((l) => l.unchangedReason === "OUT_OF_SCOPE");
      check(`${c.label} · Contrarian ${scope}: the same legs out of scope`, outOf(now.contrarian[scope]), outOf(was.contrarian[scope]));
    }
  }
  lines.push("Contrarian: redefined in PR 7 - see contrarian-diff.txt.");
  lines.push("");
}

const text = lines.join("\n");
const path = join(__dirname, "selection-diff.txt");
if (process.argv.includes("--write")) {
  writeFileSync(path, text);
  console.log(text);
  process.exit(0);
}
check("per-leg table matches selection-diff.txt", text === readFileSync(path, "utf8").replace(/\r\n/g, "\n"), true);
console.log(text);
console.log(failures > 0 ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures > 0 ? 1 : 0);
