// Acceptance check for the production qualification/ranking module
// (src/lib/parlay/qualification-ranking.ts - docs/parlay-white-paper.md,
// Sections 3, 5, 7). Re-simulates the same 1,015 parlays as the Wilson
// generation-floor sweep (wilson-floor-sweep.ts) - same method (per-user,
// per-day, ALL+per-sport>=3 scope pools, ranked by bestAvailableWinPct,
// N=3..min(len,10)) - but drives the actual per-leg qualification/mode-
// filter/headcount/Wilson-ranking logic through the NEW production
// `rankCandidates` function instead of reimplementing it here. Point-in-time
// records (scripts/t2-harness/lib/point-in-time.ts) are passed in as data,
// shaped like getCapperCategoryRecords' own return value.
//
// Section 9 conflict-filtering (checking a candidate against the parlay's
// OTHER legs) is explicitly out of scope for `rankCandidates` itself, so
// this harness script applies it as a wrapper around rankCandidates' output,
// reusing picksConflict (pick-matching.ts) OR-ed with a production
// classifyPair "NEITHER" result against every other leg - the same
// definition wilson-floor-sweep.ts used.
//
// Per Section 7 Step 4 (no generation floor in v1): a parlay gets "Parlay B"
// for a mode iff ANY leg has at least one conflict-filtered qualifying
// candidate for that mode.
//
// TARGET (current baseline, established after two fixes - see git history
// on this file/on contrarianHeadcountPasses for the prior, since-corrected
// numbers): Auto Hedge 60.59% (615/1015), Contrarian 33.10% (336/1015).
// This baseline reflects:
//   1. point-in-time.ts's PitPick carrying real odds/line, so pickCategory's
//      FAV_ML/DOG_ML split (which needs `odds`) can actually categorize
//      MONEYLINE picks - previously a missing-field bug silently zeroed out
//      every MONEYLINE point-in-time lookup.
//   2. contrarianHeadcountPasses (Section 5(b)) counting the primary's own
//      capperId toward its own side unconditionally - the primary is
//      definitionally a member of its own side regardless of when it was
//      logged; only OTHER same-game picks are gated by the "posted before
//      this game started" datePosted filter.
// This script asserts an EXACT match against that baseline below (TARGET),
// not just informational numbers - a future change to rankCandidates,
// contrarianHeadcountPasses, or the classifier that shifts these counts
// should fail this check loudly, the same way any other acceptance test
// would, rather than silently drifting.
//
// Usage (DATABASE_URL must already point at the disposable run DB):
//   node --import tsx scripts/t2-harness/qualification-ranking-acceptance-check.ts
//
// Prints ONE JSON object as the last line of stdout.
import { prisma } from "@/lib/prisma";
import { pickCategory } from "@/server/data/stats";
import type { CategoryBreakdownItem } from "@/server/data/stats";
import { startOfEasternDay, easternDateKey } from "@/lib/dates";
import { PointInTimeIndex } from "./lib/point-in-time";
import { picksConflict, type MatchPick } from "./lib/pick-matching";
import { classifyPair, type ParlayCandidate } from "@/lib/parlay/relationship-classifier";
import { rankCandidates, type ParlayLeg } from "@/lib/parlay/qualification-ranking";
import { categoryRecordKey } from "@/server/data/picks";

const MAX_N = 10;
const MODES = ["AUTO_HEDGE", "CONTRARIAN"] as const;
type SwapMode = (typeof MODES)[number];

type DbPick = Awaited<ReturnType<typeof prisma.pick.findMany>>[number] & { sport: { name: string } };

function gameKey(p: MatchPick): string {
  return `${p.homeTeam}|||${p.awayTeam}|||${p.gameTime.getTime()}`;
}

function groupBy<T, K extends string>(items: T[], keyFn: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const item of items) {
    const k = keyFn(item);
    (m.get(k) ?? m.set(k, []).get(k)!).push(item);
  }
  return m;
}

function toLeg(p: DbPick): ParlayLeg {
  return {
    pickId: p.id,
    capperId: p.capperId,
    betType: p.betType,
    period: p.period,
    betDetail: p.betDetail,
    line: p.line,
    odds: p.odds,
    datePosted: p.datePosted,
    homeTeam: p.homeTeam,
    awayTeam: p.awayTeam,
    gameTime: p.gameTime,
    sportName: p.sport.name,
  };
}

function toParlayCandidate(p: DbPick): ParlayCandidate {
  return {
    pick: { betType: p.betType, period: p.period, betDetail: p.betDetail, line: p.line },
    game: { homeTeam: p.homeTeam, awayTeam: p.awayTeam, gameTime: p.gameTime, sportName: p.sport.name },
  };
}

// Same "conflict OR correlated" definition wilson-floor-sweep.ts used, just
// operating on DbPick rows for the harness-side Section 9 wrapper.
function conflictsWithOther(a: DbPick, b: DbPick, sportName: string): boolean {
  if (picksConflict(a, b, sportName)) return true;
  const r = classifyPair(toParlayCandidate(a), toParlayCandidate(b));
  return r.outcome === "RULE" && r.mode === "NEITHER";
}

async function main() {
  const allPicks = (await prisma.pick.findMany({ include: { sport: { select: { name: true } } } })) as DbPick[];

  const byUser = groupBy(allPicks, (p) => p.userId as string);

  let totalParlays = 0;
  const bCount: Record<SwapMode, number> = { AUTO_HEDGE: 0, CONTRARIAN: 0 };

  for (const [, userPicksRaw] of byUser) {
    const userPicks = userPicksRaw as DbPick[];
    const pit = new PointInTimeIndex(
      userPicks.map((p) => ({
        id: p.id,
        capperId: p.capperId,
        betType: p.betType,
        period: p.period,
        betDetail: p.betDetail,
        odds: p.odds,
        line: p.line,
        status: p.status,
        gradedAt: p.gradedAt,
        gameTime: p.gameTime,
        datePosted: p.datePosted,
        homeTeam: p.homeTeam,
        awayTeam: p.awayTeam,
        sportName: p.sport.name,
      }))
    );

    const byGame = groupBy(userPicks, (p) => gameKey(p));
    const byDate = groupBy(userPicks, (p) => easternDateKey(p.gameTime));

    for (const [dateKey, dayPicksRaw] of byDate) {
      const dayPicks = dayPicksRaw as DbPick[];
      const cutoff = startOfEasternDay(dayPicks[0].gameTime);
      const sportsToday = new Set(dayPicks.map((p) => p.sport.name));

      const pools: Array<{ scope: string; pool: DbPick[] }> = [{ scope: "ALL", pool: dayPicks }];
      for (const sportName of sportsToday) {
        const restricted = dayPicks.filter((p) => p.sport.name === sportName);
        if (restricted.length >= 3) pools.push({ scope: sportName, pool: restricted });
      }

      for (const { pool } of pools) {
        if (pool.length < 3) continue;
        const ranked = [...pool].sort((a, b) => {
          const catA = pickCategory({ ...a, sportName: a.sport.name });
          const catB = pickCategory({ ...b, sportName: b.sport.name });
          const scoreA = pit.bestAvailableWinPct(a.capperId, a.sport.name, catA, cutoff);
          const scoreB = pit.bestAvailableWinPct(b.capperId, b.sport.name, catB, cutoff);
          return scoreB - scoreA;
        });

        const maxN = Math.min(ranked.length, MAX_N);

        for (let N = 3; N <= maxN; N++) {
          const legs = ranked.slice(0, N);
          totalParlays++;

          const parlayHasSwap: Record<SwapMode, boolean> = { AUTO_HEDGE: false, CONTRARIAN: false };

          for (const leg of legs) {
            const sportName = leg.sport.name;
            const gk = gameKey(leg);
            const otherLegIds = new Set(legs.filter((x) => x.id !== leg.id).map((x) => x.id));
            const candidatePicks = (byGame.get(gk) ?? []).filter((c) => c.id !== leg.id && !otherLegIds.has(c.id));
            const others = legs.filter((x) => x.id !== leg.id);

            if (candidatePicks.length === 0) continue;

            const primaryLeg = toLeg(leg);
            const candidateLegs = candidatePicks.map(toLeg);
            // Full same-game pool (not just `candidatePicks`) for the
            // Section 5(b) headcount - it must count every tracked capper on
            // the primary's market, including ones already used as OTHER
            // legs in this parlay (excluded from `candidatePicks` since
            // they're not available as swaps, but still real headcount
            // votes) and the primary itself.
            const sameGamePicks = (byGame.get(gk) ?? []).map(toLeg);

            // Build the records map exactly shaped like getCapperCategoryRecords'
            // own return value, keyed by categoryRecordKey, from point-in-time
            // data - one entry per distinct candidate capperId+category.
            const records: Record<string, CategoryBreakdownItem | null> = {};
            for (const cand of candidatePicks) {
              const category = pickCategory({ ...cand, sportName });
              if (!category) continue;
              const key = categoryRecordKey(cand.capperId, category);
              if (key in records) continue;
              const r = pit.categoryRecord(cand.capperId, category, cutoff);
              records[key] = { key: category, label: "", wins: r.wins, losses: r.losses, pushes: r.pushes, winPct: r.winPct, count: r.n };
            }

            for (const mode of MODES) {
              if (parlayHasSwap[mode]) continue; // already have a swap for this mode from an earlier leg
              const ranked_ = rankCandidates(primaryLeg, candidateLegs, mode, records, sameGamePicks);
              const survivor = ranked_.find((rc) => {
                const candPick = candidatePicks.find((c) => c.id === rc.leg.pickId)!;
                return !others.some((o) => conflictsWithOther(candPick, o, sportName));
              });
              if (survivor) parlayHasSwap[mode] = true;
            }
          }

          for (const mode of MODES) if (parlayHasSwap[mode]) bCount[mode]++;
        }
      }
    }
  }

  // Current baseline (see header comment) - exact match required.
  const TARGET = { autoHedge: { b: 615, n: 1015 }, contrarian: { b: 336, n: 1015 } };

  const autoHedge = { b: bCount.AUTO_HEDGE, n: totalParlays, pct: (bCount.AUTO_HEDGE / totalParlays) * 100 };
  const contrarian = { b: bCount.CONTRARIAN, n: totalParlays, pct: (bCount.CONTRARIAN / totalParlays) * 100 };
  const autoHedgeMatch = autoHedge.b === TARGET.autoHedge.b && autoHedge.n === TARGET.autoHedge.n;
  const contrarianMatch = contrarian.b === TARGET.contrarian.b && contrarian.n === TARGET.contrarian.n;

  const report = {
    totalParlays,
    autoHedge,
    contrarian,
    target: TARGET,
    autoHedgeMatch,
    contrarianMatch,
    allMatch: autoHedgeMatch && contrarianMatch,
  };

  console.log(JSON.stringify(report));
  await prisma.$disconnect();
  if (!report.allMatch) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
