// Read-only replay of the Parlay Generator over an anonymized snapshot: old
// rules versus new on the SAME inputs, every changed leg listed with why.
// Harness-only - nothing under src/ is changed, the DB is only read.
//
// Each (user, Eastern day) in the snapshot is one full-slate Generate: the
// day's picks in the Live leagues are the board (as pending), and the
// records are point-in-time - only that user's picks graded on games before
// the day count, per capper and category, all leagues and per league, the way
// getCapperRecordBundle aggregates them. Categories come from pickCategory, as
// the boards stamp them.
//
// Usage (DATABASE_URL must point at a disposable local DB restored from the
// snapshot - never production; guarded):
//   node --require ./scripts/server-only-stub.cjs --import tsx scripts/t2-harness/parlay-record-scope-replay.ts <out.json>
import { writeFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import { pickCategory, PICK_CATEGORY_LABELS, type CategoryBreakdownItem, type PickCategoryKey } from "@/server/data/stats";
import type { CapperLeagueRecords } from "@/server/data/picks";
import { LIVE_SPORTS } from "@/server/data/odds";
import { toExpanderPick } from "@/server/data/expander-pick";
import { easternDateKey, startOfEasternDay } from "@/lib/dates";
import { leagueRecordKey, categoryRecordKey } from "@/lib/record-keys";
import { recordForGate } from "@/lib/parlay/pick-record";
import { qualifies } from "@/lib/parlay/qualification-core";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import {
  buildGeneratedParlay,
  GENERATOR_RULES,
  LEGACY_RULES,
  type GeneratedParlay,
  type GeneratorRules,
  type GeneratorSettings,
  type GeneratorSnapshot,
} from "@/lib/parlay/generator";
import { assertNotProd } from "./lib/prod-guard.mjs";

const url = process.env.DATABASE_URL ?? "";
assertNotProd(url, "replay DATABASE_URL");
if (!/localhost|127\.0\.0\.1/.test(url)) throw new Error("replay must run against a local disposable DB");

const WARMUP_DAYS = 14;
const SETTINGS: { name: string; settings: GeneratorSettings }[] = [
  { name: "4 legs, max 1/game", settings: { legCount: 4, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE" } },
  { name: "8 legs, max 2/game", settings: { legCount: 8, maxLegsPerGame: 2, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE" } },
];
const OLD: GeneratorRules = LEGACY_RULES;
const NEW: GeneratorRules = GENERATOR_RULES;

type Row = {
  id: string;
  userId: string;
  capperId: string;
  capperName: string;
  sport: string;
  homeTeam: string;
  awayTeam: string;
  betType: string;
  betDetail: string | null;
  odds: number;
  line: number | null;
  period: string;
  units: number;
  status: string;
  datePosted: Date;
  gameTime: Date;
  pickedSide: string | null;
  mlFavoredSide: string | null;
  propMarket: string | null;
};

const col = (w: number, l: number, p: number) => ({ wins: w, losses: l, pushes: p, winPct: w + l > 0 ? (w / (w + l)) * 100 : 0, count: w + l + p });
const wl = (r: { wins: number; losses: number } | null | undefined) => (r && r.wins + r.losses > 0 ? `${r.wins}-${r.losses} (${((r.wins / (r.wins + r.losses)) * 100).toFixed(1)}%)` : "none");

async function main() {
  const out = process.argv[2];
  const rows = (await prisma.$queryRawUnsafe(`
    SELECT p.id, p."userId", p."capperId", c.name AS "capperName", s.name AS sport, p."homeTeam", p."awayTeam",
           p."betType"::text AS "betType", p."betDetail", p.odds, p.line, p.period::text AS period, p.units,
           p.status::text AS status, p."datePosted", p."gameTime", p."pickedSide"::text AS "pickedSide",
           p."mlFavoredSide"::text AS "mlFavoredSide", p."propMarket"::text AS "propMarket"
    FROM picks p JOIN cappers c ON c.id = p."capperId" JOIN sports s ON s.id = p."sportId"
    WHERE p.status::text <> 'CANCELLED'
    ORDER BY p."gameTime", p.id`)) as Row[];
  const live = new Map(LIVE_SPORTS.map((s) => [s.label.toLowerCase(), s]));
  const catOf = new Map<string, PickCategoryKey | null>();
  for (const r of rows) catOf.set(r.id, pickCategory({ ...r, sportName: r.sport } as Parameters<typeof pickCategory>[0]));

  const days = Array.from(new Set(rows.map((r) => easternDateKey(r.gameTime)))).sort();
  const replayDays = days.slice(WARMUP_DAYS);
  const users = Array.from(new Set(rows.map((r) => r.userId))).sort();

  type Change = {
    day: string;
    user: string;
    setting: string;
    change: "gained" | "lost";
    cause: string;
    game: string;
    pick: string;
    capper: string;
    allTime: string;
    inLeague: string;
    newBasis: string;
  };
  type SwapChange = { day: string; user: string; setting: string; mode: string; primary: string; old: string; new: string; cause: string };
  const changes: Change[] = [];
  const swapChanges: SwapChange[] = [];
  let slates = 0;
  let parlays = 0;
  let parlaysChanged = 0;
  let legsOld = 0;
  let legsNew = 0;
  let deterministic = true;
  const basisCount: Record<string, number> = {};

  for (const user of users) {
    const mine = rows.filter((r) => r.userId === user);
    for (const day of replayDays) {
      const pool = mine.filter((r) => easternDateKey(r.gameTime) === day && live.has(r.sport.toLowerCase()) && catOf.get(r.id));
      if (pool.length === 0) continue;
      const dayStart = startOfEasternDay(pool[0].gameTime);
      const history = mine.filter((r) => r.gameTime.getTime() < dayStart.getTime() && (r.status === "WIN" || r.status === "LOSS" || r.status === "PUSH"));

      // Point-in-time records, as the bundle aggregates them.
      const agg = new Map<string, [number, number, number]>();
      const bump = (k: string, s: string) => {
        const a = agg.get(k) ?? [0, 0, 0];
        a[s === "WIN" ? 0 : s === "LOSS" ? 1 : 2]++;
        agg.set(k, a);
      };
      for (const h of history) {
        const c = catOf.get(h.id);
        if (!c) continue;
        bump(categoryRecordKey(h.capperId, c), h.status);
        bump(leagueRecordKey(h.capperId, live.get(h.sport.toLowerCase())?.label ?? h.sport, c), h.status);
      }
      const categoryRecords: Record<string, CategoryBreakdownItem | null> = {};
      const leagueRecords: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };
      const games = new Map<string, GeneratorGame>();
      for (const r of pool) {
        const sport = live.get(r.sport.toLowerCase())!;
        const category = catOf.get(r.id)!;
        const ck = categoryRecordKey(r.capperId, category);
        const a = agg.get(ck);
        categoryRecords[ck] = a ? { key: category, label: PICK_CATEGORY_LABELS[category], ...col(...a) } : null;
        const lk = leagueRecordKey(r.capperId, sport.label, category);
        const l = agg.get(lk) ?? [0, 0, 0];
        leagueRecords.records[lk] = a ? { category, label: PICK_CATEGORY_LABELS[category], overall: col(...a), league: col(...l) } : null;
        const gameId = `${sport.label}|${r.awayTeam}@${r.homeTeam}|${r.gameTime.toISOString()}`;
        const pick = toExpanderPick(
          { ...r, capper: { name: r.capperName, colorTag: null, isFavorite: false }, oddsSource: null, gameNumber: null, status: "PENDING" } as unknown as Parameters<typeof toExpanderPick>[0],
          { id: gameId, homeTeam: r.homeTeam, awayTeam: r.awayTeam, commenceTime: r.gameTime.toISOString() },
          sport.key,
          sport.label
        ) as GeneratorPick;
        const g = games.get(gameId) ?? { gameId, gameLabel: pick.gameLabel, gameTime: r.gameTime.toISOString(), leagueName: sport.label, picks: [], doubleheader: false };
        g.picks.push(pick);
        games.set(gameId, g);
      }
      const snapshot: GeneratorSnapshot = { builtAt: dayStart.toISOString(), games: Array.from(games.values()), slipPicks: [], targets: [], leagueRecords, categoryRecords };
      slates++;

      for (const { name, settings } of SETTINGS) {
        const a = buildGeneratedParlay(snapshot, settings, null, dayStart, OLD);
        const b = buildGeneratedParlay(snapshot, settings, null, dayStart, NEW);
        if (JSON.stringify(b) !== JSON.stringify(buildGeneratedParlay(snapshot, settings, null, dayStart, NEW))) deterministic = false;
        parlays++;
        legsOld += a.legs.length;
        legsNew += b.legs.length;
        for (const l of b.legs) basisCount[String(l.basis)] = (basisCount[String(l.basis)] ?? 0) + 1;
        const aIds = new Set(a.legs.map((l) => l.pick.pickId));
        const bIds = new Set(b.legs.map((l) => l.pick.pickId));
        let changed = false;
        const describe = (leg: GeneratedParlay["legs"][number], kind: "gained" | "lost") => {
          const p = leg.pick;
          const all = categoryRecords[categoryRecordKey(p.capperId, p.category!)];
          const gate = recordForGate(p, leagueRecords, categoryRecords);
          const card = leagueRecords.records[leagueRecordKey(p.capperId, p.leagueName, p.category!)];
          const oldQ = qualifies(all);
          const newQ = qualifies(gate);
          // Own record: the gate flipped, or it ranks on a different record. Knock-on:
          // its record is the same either way - another pick's moved it.
          const sameRecord = !!gate && !!all && gate.wins === all.wins && gate.losses === all.losses;
          let cause: string;
          if (kind === "gained") cause = !oldQ && newQ ? "own league record clears 55% (all-time didn't)" : sameRecord ? "knock-on (another pick's league record)" : "own league record ranks it higher";
          else cause = oldQ && !newQ ? "own league record fails 55% (all-time cleared)" : sameRecord ? "knock-on (another pick's league record)" : "own league record ranks it lower";
          changes.push({
            day,
            user: user.slice(-6),
            setting: name,
            change: kind,
            cause,
            game: `${p.leagueName} ${p.gameLabel}`,
            pick: p.betDetail,
            capper: p.capperName,
            allTime: wl(all),
            inLeague: wl(card?.league),
            newBasis: gate ? gate.source : "none",
          });
          changed = true;
        };
        for (const l of b.legs) if (!aIds.has(l.pick.pickId)) describe(l, "gained");
        for (const l of a.legs) if (!bIds.has(l.pick.pickId)) describe(l, "lost");
        for (const mode of ["hedge", "contrarian"] as const) {
          for (const bl of b[mode].legs) {
            const al = a[mode].legs.find((x) => x.original.pick.pickId === bl.original.pick.pickId);
            if (!al) continue; // its primary changed - counted above
            const show = (l: typeof bl) => (l.swap ? `${l.swap.pick.betDetail} · ${l.swap.pick.capperName} ${l.swap.record.wins}-${l.swap.record.losses}` : `unchanged (${l.unchangedReason})`);
            if (show(al) === show(bl)) continue;
            const cause = mode === "contrarian" && al.unchangedReason === "NOT_MAJORITY" ? "headcount rule dropped" : "league record";
            swapChanges.push({ day, user: user.slice(-6), setting: name, mode, primary: `${bl.original.pick.betDetail} · ${bl.original.pick.capperName}`, old: show(al), new: show(bl), cause });
            changed = true;
          }
        }
        if (changed) parlaysChanged++;
      }
    }
  }

  const tally = (xs: { [k: string]: unknown }[], key: string) => xs.reduce<Record<string, number>>((m, x) => ((m[String(x[key])] = (m[String(x[key])] ?? 0) + 1), m), {});
  const report = {
    window: `${replayDays[0]} .. ${replayDays[replayDays.length - 1]} (after ${WARMUP_DAYS} warm-up days)`,
    users: users.length,
    slates,
    parlays,
    parlaysChanged,
    deterministic,
    legsOld,
    legsNew,
    newLegBasis: basisCount,
    legChanges: changes.length,
    legChangesByCause: tally(changes.map((c) => ({ k: `${c.change} · ${c.cause}` })), "k"),
    swapChanges: swapChanges.length,
    swapChangesByCause: tally(swapChanges.map((c) => ({ k: `${c.mode} · ${c.cause}` })), "k"),
    changes,
    swapChanges_: swapChanges,
  };
  writeFileSync(out, JSON.stringify(report, null, 1));
  const { changes: _c, swapChanges_: _s, ...summary } = report;
  console.log(JSON.stringify(summary, null, 1));
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
