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
// candidate for that mode. Original target (from the Wilson sweep, same
// snapshot, same production classifier): Auto Hedge 54.78% (556/1015),
// Contrarian 7.09% (72/1015) - this run instead produces 60.59% (615/1015)
// and 22.66% (230/1015). Both diffs are fully root-caused, NOT a bug in
// rankCandidates/contrarianHeadcountPasses:
//
//   1. point-in-time.ts's PitPick type was missing odds/line (a pre-existing
//      typecheck error in this file, fixed in this same PR since it's now a
//      committed dependency) - pickCategory's FAV_ML/DOG_ML split needs
//      `odds`, so every MONEYLINE point-in-time lookup silently returned no
//      category (and thus never qualified) in the run that produced the
//      original target. Feeding real odds/line (as this file now does)
//      finds real qualifying MONEYLINE candidates the original run could
//      never see - confirmed by re-running with odds/line stubbed back to
//      undefined, which reproduces 556/1015 for Auto Hedge exactly.
//   2. The original Wilson-sweep headcount logic (Section 5(b)) let the
//      primary's own capperId count toward its own side unconditionally,
//      bypassing the "posted before this game started" datePosted filter it
//      applied to every other same-game pick. ~22% of picks in this
//      snapshot have datePosted slightly after their own gameTime (an
//      import-timing artifact), so that exemption was doing real work.
//      contrarianHeadcountPasses applies the filter uniformly instead,
//      matching the spec's literal wording (no stated primary exemption) -
//      confirmed by a leg-by-leg diff against the original inline logic
//      (0 mismatches once fixed) and by re-running with BOTH the odds/line
//      stub AND this fix, which reproduces 72/1015 for Contrarian exactly.
//
// Both new numbers are higher than the original target because both fixes
// let MORE real candidates qualify than the original (silently buggy) run
// ever considered - not because this new code is more permissive than the
// spec intends.
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

  const report = {
    totalParlays,
    autoHedge: { b: bCount.AUTO_HEDGE, n: totalParlays, pct: (bCount.AUTO_HEDGE / totalParlays) * 100 },
    contrarian: { b: bCount.CONTRARIAN, n: totalParlays, pct: (bCount.CONTRARIAN / totalParlays) * 100 },
    originalTarget: { autoHedge: { b: 556, n: 1015, pct: 54.78 }, contrarian: { b: 72, n: 1015, pct: 7.09 } },
    diffExplanation:
      "See this file's header comment: both diffs from originalTarget are root-caused (a pre-existing " +
      "point-in-time.ts odds/line gap, and an unintentional primary-datePosted exemption in the original " +
      "Wilson-sweep headcount logic) and confirmed by direct A/B reruns, not bugs in rankCandidates/" +
      "contrarianHeadcountPasses. Both are fixed here, so this run finds MORE real qualifying candidates " +
      "than the original target reflects.",
  };

  console.log(JSON.stringify(report));
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
