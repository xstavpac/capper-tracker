// PICK_CATEGORY_VERSION 5 (per-market prop categories, lib/prop-category.ts) through the Parlay
// Generator, frozen: every Contrarian / NBA same-game case (NBA_SAMEGAME_CASES) and every Standard
// selection case (SELECTION_CASES on the scoring-switch slate), run three ways:
//   before   the fixture as it is: every prop stored as the blended TD_PROP, its category records
//            the blended ones (what the --props backfill finds in production).
//   renamed  each prop restamped with its version 5 key (pickCategory), category records re-keyed
//            with the SAME numbers. Must equal `before` (category / label strings aside): the code
//            change alone moves nothing.
//   split    restamped AND each prop's category records replaced by its own market's record (the
//            per-market record the snapshot already carries - after the backfill the capper's
//            PTS_PROP card in the NBA is exactly that record). This is what the backfill changes.
// prop-category-v5-diff.txt pins every case whose output moves between `before` and `split`.
// Pure - no DB. `--write` rewrites the .txt.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGeneratedParlay, type GeneratorSnapshot } from "@/lib/parlay/generator";
import { NBA_SAMEGAME_CASES, nowOf, snapshotOf } from "@/lib/parlay/nba-samegame-frozen-cases";
import { buildSnapshot, NOW } from "@/lib/parlay/scoring-switch-fixture";
import { SELECTION_CASES } from "@/lib/parlay/selection-frozen-cases";
import { categoryRecordKey, leagueRecordKey, propMarketRecordKey } from "@/lib/record-keys";
import { propMarketKey } from "@/lib/prop-market-key";
import { pickCategory, PICK_CATEGORY_LABELS, type PickCategoryKey } from "@/server/data/stats";
import type { GeneratorPick } from "@/lib/parlay/auto-generate";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

function v5Category(p: GeneratorPick): PickCategoryKey | null {
  return pickCategory({
    betType: p.betType as never,
    period: p.period as never,
    betDetail: p.rawBetDetail ?? p.betDetail,
    odds: p.odds,
    line: p.line,
    sportName: p.leagueName,
    oddsSource: null,
    propMarket: (p.propMarket ?? null) as never,
  });
}

const col = (w: number, l: number, pu: number) => ({ wins: w, losses: l, pushes: pu, winPct: w + l > 0 ? (w / (w + l)) * 100 : 0, count: w + l + pu });

// The snapshot after the --props backfill: prop picks carry their version 5 key; `split` also
// swaps each prop's category records for its market's own.
function restamped(snap: GeneratorSnapshot, split: boolean): GeneratorSnapshot {
  const records = { ...snap.leagueRecords.records };
  const categoryRecords = { ...snap.categoryRecords };
  const games = snap.games.map((g) => ({
    ...g,
    picks: g.picks.map((p) => {
      if (p.betType !== "PLAYER_PROP" || p.category !== "TD_PROP") return p;
      const cat = v5Category(p);
      if (!cat || cat === "TD_PROP") return { ...p, category: cat };
      const oldCard = snap.leagueRecords.records[leagueRecordKey(p.capperId, p.leagueName, "TD_PROP")] ?? null;
      const oldAll = snap.categoryRecords[categoryRecordKey(p.capperId, "TD_PROP")] ?? null;
      const key = propMarketKey({ betType: p.betType, sportName: p.leagueName, propMarket: p.propMarket });
      const market = split && key ? (snap.propMarketRecords?.[propMarketRecordKey(p.capperId, p.leagueName, key)] ?? null) : null;
      const label = PICK_CATEGORY_LABELS[cat];
      if (split) {
        records[leagueRecordKey(p.capperId, p.leagueName, cat)] = market
          ? { category: cat, label, overall: market.allTime, league: market.league, ...(market.priced ? { priced: { overall: market.priced.allTime, league: market.priced.league } } : {}) }
          : null;
        const a = market?.allTime;
        categoryRecords[categoryRecordKey(p.capperId, cat)] = a ? { key: cat, label, ...col(a.wins, a.losses, a.pushes) } : null;
      } else {
        records[leagueRecordKey(p.capperId, p.leagueName, cat)] = oldCard ? { ...oldCard, category: cat, label } : null;
        categoryRecords[categoryRecordKey(p.capperId, cat)] = oldAll ? { ...oldAll, key: cat, label } : null;
      }
      return { ...p, category: cat };
    }),
  }));
  return { ...snap, games, leagueRecords: { ...snap.leagueRecords, records }, categoryRecords };
}

type Shape = { legs: [string, string | null][]; dropped: [string, string][]; hedge: [string, string | null][]; contrarian: [string, string | null][] };
// What a viewer sees of a parlay, category / label strings stripped (they are renamed on purpose).
function shapeOf(snap: GeneratorSnapshot, settings: Parameters<typeof buildGeneratedParlay>[1], now: Date): { shape: Shape; rest: string } {
  const p = buildGeneratedParlay(snap, settings, null, now);
  const row = (s: typeof p.hedge.ALL) => s.legs.map((l) => [l.original.pick.pickId, l.swap?.pick.pickId ?? l.unchangedReason ?? null] as [string, string | null]);
  const legRecord = (l: (typeof p.legs)[number]) => {
    const r = (l as { record?: { wins: number; losses: number } | null }).record;
    return r ? `${r.wins}-${r.losses}` : null;
  };
  const shape: Shape = {
    legs: p.legs.map((l) => [l.pick.pickId, legRecord(l)]),
    dropped: p.dropped.map((d) => [d.pickId, d.reason]),
    hedge: row(p.hedge.ALL),
    contrarian: row(p.contrarian.ALL),
  };
  const rest = JSON.stringify(p, (k, v) => (k === "category" || k === "label" || k === "historyBetKeys" ? undefined : v));
  return { shape, rest };
}

const cases: { label: string; snap: () => GeneratorSnapshot; settings: Parameters<typeof buildGeneratedParlay>[1]; now: Date }[] = [
  ...NBA_SAMEGAME_CASES.map((c) => ({ label: `${c.slate} · ${c.label}`, snap: () => snapshotOf(c), settings: c.settings, now: nowOf(c) })),
  ...SELECTION_CASES.map((c) => ({ label: `SELECTION · ${c.label}`, snap: () => buildSnapshot(undefined, c.slip), settings: c.settings, now: NOW })),
];

const fmt = (rows: [string, string | null][]) => rows.map(([a, b]) => (b === null ? a : `${a}(${b})`)).join(", ") || "(none)";
const lines: string[] = [];
let propPicks = 0;
let moved = 0;
for (const c of cases) {
  const snap = c.snap();
  propPicks += snap.games.flatMap((g) => g.picks).filter((p) => p.betType === "PLAYER_PROP" && p.category === "TD_PROP").length;
  const before = shapeOf(snap, c.settings, c.now);
  const renamed = shapeOf(restamped(snap, false), c.settings, c.now);
  const split = shapeOf(restamped(snap, true), c.settings, c.now);
  check(`${c.label}: renaming the categories alone changes nothing`, renamed.rest, before.rest);
  const out: string[] = [];
  const a = before.shape;
  const b = split.shape;
  if (JSON.stringify(a.legs) !== JSON.stringify(b.legs)) {
    out.push(`  legs: ${fmt(a.legs)}`, `     -> ${fmt(b.legs)}`);
    const ids = (r: [string, string | null][]) => r.map(([x]) => x);
    const gone = ids(a.legs).filter((x) => !ids(b.legs).includes(x));
    const added = ids(b.legs).filter((x) => !ids(a.legs).includes(x));
    if (gone.length || added.length) out.push(`     out: ${gone.join(", ") || "(none)"}; in: ${added.join(", ") || "(none)"}`);
  }
  if (JSON.stringify(a.dropped) !== JSON.stringify(b.dropped)) out.push(`  dropped: ${JSON.stringify(a.dropped)}`, `       -> ${JSON.stringify(b.dropped)}`);
  if (JSON.stringify(a.hedge) !== JSON.stringify(b.hedge)) out.push(`  hedge: ${fmt(a.hedge)}`, `      -> ${fmt(b.hedge)}`);
  if (JSON.stringify(a.contrarian) !== JSON.stringify(b.contrarian)) out.push(`  contrarian: ${fmt(a.contrarian)}`, `           -> ${fmt(b.contrarian)}`);
  if (out.length === 0 && before.rest !== split.rest) out.push("  (legs, drops, hedge and contrarian unchanged; other output fields changed)");
  if (out.length) {
    moved++;
    lines.push(c.label, ...out);
  }
}
const text =
  `=== PICK_CATEGORY_VERSION 5 restamp (TD_PROP -> per-market keys, split records): ${cases.length} cases, ${propPicks} TD_PROP prop picks across them ===\n` +
  `${moved} case(s) moved\n` +
  (lines.length ? lines.join("\n") + "\n" : "");

const path = join(__dirname, "prop-category-v5-diff.txt");
if (process.argv.includes("--write")) {
  writeFileSync(path, text);
  console.log(text);
  process.exit(0);
}
check("the before -> split diff matches prop-category-v5-diff.txt", text === readFileSync(path, "utf8").replace(/\r\n/g, "\n"), true);
console.log("\n" + text);
console.log(failures > 0 ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
if (failures > 0) process.exit(1);
