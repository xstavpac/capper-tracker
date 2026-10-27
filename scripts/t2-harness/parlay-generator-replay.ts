// Read-only replay of the Parlay Generator over an anonymized snapshot: three
// rule sets on the SAME inputs (lib/generator-replay-slates.ts), every changed
// leg listed with why. Harness-only - nothing under src/ is changed, the DB is
// only read.
//
//   A  LEGACY_RULES          all-leagues market record, z=1.96, headcount
//   B  record scope only     in-league record (PR 1), z=1.96, its bands
//   C  GENERATOR_RULES       in-league record, the generator's z and bands
//
// A leg in A but not C (or C but not A) is put down to the league record when
// B already has the change, else to the soft sample adjustment. Also: band
// calibration (each band covers the same share of near-ties at the new z as
// the old band did at 1.96), Regenerate behavior and determinism.
//
// Usage (DATABASE_URL must point at a disposable local DB restored from the
// snapshot - never production; guarded):
//   node --require ./scripts/server-only-stub.cjs --import tsx scripts/t2-harness/parlay-generator-replay.ts <out.json> [--z=0.8] [--pick-band=x] [--game-band=y]
import { writeFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import { categoryRecordKey, leagueRecordKey } from "@/lib/record-keys";
import { recordForGate } from "@/lib/parlay/pick-record";
import { qualifies } from "@/lib/parlay/qualification-core";
import { wilsonLowerBound } from "@/lib/wilson-lower-bound";
import { keepsPick } from "@/lib/parlay/include-picks";
import { buildGeneratedParlay, GENERATOR_RULES, LEGACY_RULES, type GeneratedParlay, type GeneratorRules, type GeneratorSettings, type GeneratorSnapshot } from "@/lib/parlay/generator";
import { loadReplaySlates, REPLAY_SETTINGS, wl } from "./lib/generator-replay-slates";

const args = Object.fromEntries(process.argv.slice(3).map((a) => a.replace(/^--/, "").split("=")));
const A: GeneratorRules = LEGACY_RULES;
const B: GeneratorRules = { ...LEGACY_RULES, recordScope: "LEAGUE_FIRST", contrarianHeadcount: false };
const C: GeneratorRules = {
  ...GENERATOR_RULES,
  ...(args.z ? { z: Number(args.z) } : {}),
  ...(args["pick-band"] ? { pickTieBand: Number(args["pick-band"]) } : {}),
  ...(args["game-band"] ? { gameBand: Number(args["game-band"]) } : {}),
};
const REGENERATES = 5;

type Leg = GeneratedParlay["legs"][number];
const idsOf = (p: GeneratedParlay) => new Set(p.legs.map((l) => l.pick.pickId));
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] : NaN;
};
const share = (xs: number[], band: number) => (xs.length ? xs.filter((x) => x <= band + 1e-12).length / xs.length : NaN);

// Every gated candidate's Wilson per game, as the engine ranks them (no slip).
function candidateScores(snapshot: GeneratorSnapshot, settings: GeneratorSettings, z: number): number[][] {
  return snapshot.games.map((g) =>
    g.picks
      .filter((p) => keepsPick(settings.include, p))
      .map((p) => recordForGate(p, snapshot.leagueRecords, snapshot.categoryRecords))
      .filter((r): r is NonNullable<typeof r> => r !== null && qualifies(r))
      .map((r) => wilsonLowerBound(r.wins, r.losses, z))
      .sort((a, b) => b - a)
  );
}

function bandGaps(snapshot: GeneratorSnapshot, settings: GeneratorSettings, z: number) {
  const lists = candidateScores(snapshot, settings, z).filter((l) => l.length > 0);
  const pick = lists.flatMap((l) => l.slice(1).map((s) => l[0] - s));
  const tops = lists.map((l) => l[0]).sort((a, b) => b - a);
  const need = settings.legCount;
  const game = tops.length > need ? tops.slice(need).map((t) => tops[need - 1] - t) : [];
  return { pick, game };
}

// Generate, then REGENERATES Regenerates, each with the parlays before it as history.
function regenerateChain(snapshot: GeneratorSnapshot, settings: GeneratorSettings, now: Date, rules: GeneratorRules) {
  const first = buildGeneratedParlay(snapshot, settings, null, now, rules);
  const history: string[][] = [first.legs.filter((l) => l.source === "GENERATED").map((l) => l.pick.pickId)];
  const out = [first];
  for (let i = 0; i < REGENERATES; i++) {
    const p = buildGeneratedParlay(snapshot, settings, { seed: 1000 + i * 31, history: [...history] }, now, rules);
    out.push(p);
    history.unshift(p.legs.filter((l) => l.source === "GENERATED").map((l) => l.pick.pickId));
  }
  return out;
}

async function main() {
  const out = process.argv[2];
  const { slates, window, users } = await loadReplaySlates();

  type Change = { day: string; user: string; setting: string; change: "gained" | "lost"; cause: string; detail: string; game: string; pick: string; capper: string; allTime: string; inLeague: string; basis: string; wilson196: string; wilsonZ: string };
  const changes: Change[] = [];
  const swapChanges: { day: string; user: string; setting: string; mode: string; primary: string; old: string; new: string; cause: string }[] = [];
  // PR 1's "lost - own league record ranks it lower": in A, not in B, still qualifies in B.
  const rankedLower: { day: string; user: string; setting: string; pick: string; capper: string; inLeague: string; inC: boolean }[] = [];
  let parlays = 0;
  let changedAC = 0;
  let deterministic = true;
  const legsTotal = { A: 0, B: 0, C: 0 };
  const legStats = { A: { winPct: 0, n: 0, nList: [] as number[] }, B: { winPct: 0, n: 0, nList: [] as number[] }, C: { winPct: 0, n: 0, nList: [] as number[] } };
  const gaps = { B: { pick: [] as number[], game: [] as number[] }, C: { pick: [] as number[], game: [] as number[] } };
  const regen = {
    B: { varied: 0, noAlternative: 0, replaced: 0, slots: 0, winPctGen: 0, winPctRegen: 0, nGen: 0, nRegen: 0, belowGate: 0, regenerates: 0 },
    C: { varied: 0, noAlternative: 0, replaced: 0, slots: 0, winPctGen: 0, winPctRegen: 0, nGen: 0, nRegen: 0, belowGate: 0, regenerates: 0 },
  };

  for (const { day, user, now, snapshot } of slates) {
    for (const { name, settings } of REPLAY_SETTINGS) {
      parlays++;
      const a = buildGeneratedParlay(snapshot, settings, null, now, A);
      const b = buildGeneratedParlay(snapshot, settings, null, now, B);
      const c = buildGeneratedParlay(snapshot, settings, null, now, C);
      if (JSON.stringify(c) !== JSON.stringify(buildGeneratedParlay(snapshot, settings, null, now, C))) deterministic = false;
      legsTotal.A += a.legs.length;
      legsTotal.B += b.legs.length;
      legsTotal.C += c.legs.length;
      for (const [k, p] of [["A", a], ["B", b], ["C", c]] as const) {
        for (const l of p.legs) {
          legStats[k].winPct += l.record!.winPct;
          legStats[k].n += l.record!.n;
          legStats[k].nList.push(l.record!.n);
        }
      }
      const [ia, ib, ic] = [idsOf(a), idsOf(b), idsOf(c)];

      const describe = (leg: Leg, kind: "gained" | "lost") => {
        const p = leg.pick;
        const all = snapshot.categoryRecords[categoryRecordKey(p.capperId, p.category!)];
        const gate = recordForGate(p, snapshot.leagueRecords, snapshot.categoryRecords);
        const card = snapshot.leagueRecords.records[leagueRecordKey(p.capperId, p.leagueName, p.category!)];
        const byLeague = kind === "gained" ? ib.has(p.pickId) : !ib.has(p.pickId);
        let detail: string;
        if (byLeague) {
          const sameRecord = !!gate && !!all && gate.wins === all.wins && gate.losses === all.losses;
          if (kind === "gained") detail = !qualifies(all) && qualifies(gate) ? "own league record clears 55% (all-time didn't)" : sameRecord ? "knock-on" : "own league record ranks it higher";
          else detail = qualifies(all) && !qualifies(gate) ? "own league record fails 55% (all-time cleared)" : sameRecord ? "knock-on" : "own league record ranks it lower";
        } else detail = kind === "gained" ? "ranks higher at the softer z" : "outranked at the softer z";
        changes.push({
          day, user, setting: name, change: kind, cause: byLeague ? "league record" : "soft adjustment", detail,
          game: `${p.leagueName} ${p.gameLabel}`, pick: p.betDetail, capper: p.capperName, allTime: wl(all), inLeague: wl(card?.league), basis: gate ? gate.source : "none",
          wilson196: gate ? wilsonLowerBound(gate.wins, gate.losses).toFixed(3) : "-",
          wilsonZ: gate ? wilsonLowerBound(gate.wins, gate.losses, C.z).toFixed(3) : "-",
        });
      };
      for (const l of c.legs) if (!ia.has(l.pick.pickId)) describe(l, "gained");
      for (const l of a.legs) if (!ic.has(l.pick.pickId)) describe(l, "lost");
      // Changes that cancel out (A in, B out, C back in) are not A-vs-C changes; the
      // PR 1 "ranks it lower" set is followed separately below.
      for (const l of a.legs) {
        if (ib.has(l.pick.pickId)) continue;
        const p = l.pick;
        const all = snapshot.categoryRecords[categoryRecordKey(p.capperId, p.category!)];
        const gate = recordForGate(p, snapshot.leagueRecords, snapshot.categoryRecords);
        const sameRecord = !!gate && !!all && gate.wins === all.wins && gate.losses === all.losses;
        if (qualifies(gate) && !sameRecord) rankedLower.push({ day, user, setting: name, pick: p.betDetail, capper: p.capperName, inLeague: wl(gate), inC: ic.has(p.pickId) });
      }
      let changed = [...ia].some((id) => !ic.has(id)) || [...ic].some((id) => !ia.has(id));
      for (const mode of ["hedge", "contrarian"] as const) {
        for (const cl of c[mode].SUGGESTED.legs) {
          const al = a[mode].SUGGESTED.legs.find((x) => x.original.pick.pickId === cl.original.pick.pickId);
          const bl = b[mode].SUGGESTED.legs.find((x) => x.original.pick.pickId === cl.original.pick.pickId);
          if (!al) continue;
          const show = (l: typeof cl) => (l.swap ? `${l.swap.pick.betDetail} · ${l.swap.pick.capperName} ${l.swap.record.wins}-${l.swap.record.losses}` : `unchanged (${l.unchangedReason})`);
          if (show(al) === show(cl)) continue;
          const cause = bl && show(bl) === show(cl) ? (mode === "contrarian" && al.unchangedReason === "NOT_MAJORITY" ? "headcount rule dropped" : "league record") : "soft adjustment";
          swapChanges.push({ day, user, setting: name, mode, primary: `${cl.original.pick.betDetail} · ${cl.original.pick.capperName}`, old: show(al), new: show(cl), cause });
          changed = true;
        }
      }
      if (changed) changedAC++;

      // Bands and Regenerate: B (z=1.96, old bands) against C.
      for (const [key, rules] of [["B", B], ["C", C]] as const) {
        const g = bandGaps(snapshot, settings, rules.z);
        gaps[key].pick.push(...g.pick);
        gaps[key].game.push(...g.game);
        const chain = regenerateChain(snapshot, settings, now, rules);
        if (JSON.stringify(chain) !== JSON.stringify(regenerateChain(snapshot, settings, now, rules))) deterministic = false;
        const r = regen[key];
        const gen = chain[0].legs.filter((l) => l.source === "GENERATED");
        const genIds = new Set(gen.map((l) => l.pick.pickId));
        for (const p of chain.slice(1)) {
          r.regenerates++;
          if (p.variety === "VARIED") r.varied++;
          else if (p.variety === "NO_ALTERNATIVE") r.noAlternative++;
          const legs = p.legs.filter((l) => l.source === "GENERATED");
          r.slots += legs.length;
          r.replaced += legs.filter((l) => !genIds.has(l.pick.pickId)).length;
          for (const l of legs) {
            r.winPctRegen += l.record!.winPct;
            r.nRegen++;
            if (l.record!.winPct < 55) r.belowGate++;
          }
        }
        for (const l of gen) {
          r.winPctGen += l.record!.winPct;
          r.nGen++;
        }
      }
    }
  }

  const tally = (xs: string[]) => xs.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
  const bandCal = (() => {
    const fPick = share(gaps.B.pick, B.pickTieBand);
    const fGame = share(gaps.B.game, B.gameBand);
    return {
      oldPickBand: B.pickTieBand,
      oldPickShare: +fPick.toFixed(3),
      pickBandForSameShareAtZ: +quantile(gaps.C.pick, fPick).toFixed(4),
      newPickBand: C.pickTieBand,
      newPickShare: +share(gaps.C.pick, C.pickTieBand).toFixed(3),
      oldGameBand: B.gameBand,
      oldGameShare: +fGame.toFixed(3),
      gameBandForSameShareAtZ: +quantile(gaps.C.game, fGame).toFixed(4),
      newGameBand: C.gameBand,
      newGameShare: +share(gaps.C.game, C.gameBand).toFixed(3),
      pickGapPairs: gaps.C.pick.length,
      gameGapPairs: gaps.C.game.length,
    };
  })();
  const regenSummary = Object.fromEntries(
    (Object.keys(regen) as ("B" | "C")[]).map((k) => {
      const r = regen[k];
      return [k, { regenerates: r.regenerates, varied: r.varied, noAlternative: r.noAlternative, legsReplacedPct: +((100 * r.replaced) / r.slots).toFixed(1), avgWinPctGenerate: +(r.winPctGen / r.nGen).toFixed(1), avgWinPctRegenerate: +(r.winPctRegen / r.nRegen).toFixed(1), legsBelow55: r.belowGate }];
    })
  );
  const report = {
    window,
    users,
    slates: slates.length,
    parlays,
    rules: { A, B, C },
    deterministic,
    legs: legsTotal,
    perLeg: Object.fromEntries(
      (["A", "B", "C"] as const).map((k) => {
        const s = [...legStats[k].nList].sort((x, y) => x - y);
        return [k, { avgWinPct: +(legStats[k].winPct / legsTotal[k]).toFixed(1), avgSample: +(legStats[k].n / legsTotal[k]).toFixed(1), medianSample: s[Math.floor(s.length / 2)], legsUnder5: s.filter((x) => x < 5).length }];
      })
    ),
    parlaysChangedAvsC: changedAC,
    legChangesAvsC: changes.length,
    legChangesByCause: tally(changes.map((c) => `${c.change} · ${c.cause} · ${c.detail}`)),
    swapChangesByCause: tally(swapChanges.map((c) => `${c.mode} · ${c.cause}`)),
    pr1RankedLower: { total: rankedLower.length, backAtSofterZ: rankedLower.filter((r) => r.inC).length },
    bands: bandCal,
    regenerate: regenSummary,
    changes,
    swapChanges_: swapChanges,
    rankedLower_: rankedLower,
  };
  writeFileSync(out, JSON.stringify(report, null, 1));
  const { changes: _c, swapChanges_: _s, rankedLower_: _r, ...summary } = report;
  console.log(JSON.stringify(summary, null, 1));
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
