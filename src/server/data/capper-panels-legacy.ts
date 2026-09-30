// Frozen copy of capper-panels.ts's raw-pick computeCapperPanels (the full-history
// `pick.findMany` + JS windowing it ran before the panels moved to the SQL
// aggregates in capper-list-aggregates.ts). Uncached. Kept only as the parity
// reference the T2 harness (`old` entry, capture-output.ts --surface=panels) and
// capper-panels-acceptance-test.ts compare the SQL version against; NO production
// code imports it. Delete together with those comparisons once the SQL version has
// had its observation period, same convention as sport-category-panel-legacy.ts.
//
// Logic is deliberately unchanged. The thresholds are imported from
// capper-panels.ts, not copied, so both implementations always run the same
// thresholds. The only edit is the dead `category` filter,
// which nothing ever set, removed from both implementations.
import { prisma } from "@/lib/prisma";
import { computeStats, weightedRoiScore, round2, RANKING_MIN_SAMPLE, SCORECARD_WIN_THRESHOLD } from "@/server/data/stats";
import { getCappersForUser } from "@/server/data/cappers";
import { comparePicksByGradedAtDesc } from "@/lib/pick-order";
import {
  ACTIVITY_WINDOW_DAYS,
  STREAK_PANEL_MIN,
  TRENDING_WINDOW,
  TRENDING_CONFIRM_WINDOW,
  TRENDING_THRESHOLD_PTS,
  RECENT_FORM_WINDOW,
  RECENT_FORM_MIN_SAMPLE,
  FALLING_OFF_WINDOW,
  FALLING_OFF_MIN_SAMPLE,
  FALLING_OFF_THRESHOLD_PTS,
  RECENT_FORM_SHRINKAGE_K,
  EMPTY_PANELS,
  type CapperPanels,
  type CapperPanelsFilter,
  type StreakPanelEntry,
  type RisingPanelEntry,
  type FallingOffPanelEntry,
  type BestLast20Entry,
} from "@/server/data/capper-panels";

type PanelCapperBase = { capperId: string; name: string; colorTag: string | null };

function windowWinPct(picks: { status: string }[]): number | null {
  const wins = picks.filter((p) => p.status === "WIN").length;
  const losses = picks.filter((p) => p.status === "LOSS").length;
  return wins + losses > 0 ? round2((wins / (wins + losses)) * 100) : null;
}

export async function getCapperPanelsLegacy(userId: string, filter?: CapperPanelsFilter): Promise<CapperPanels> {
  const cappers = await getCappersForUser(userId, filter);
  if (cappers.length === 0) return EMPTY_PANELS;

  const where = {
    userId,
    capperId: { in: cappers.map((c) => c.id) },
    // Applied here, in the WHERE - the sport relation is not needed for this.
    ...(filter?.sportName ? { sport: { name: filter.sportName } } : {}),
  };
  const scoped = await prisma.pick.findMany({ where });

  const byCapper = new Map<string, typeof scoped>();
  for (const pick of scoped) {
    const list = byCapper.get(pick.capperId);
    if (list) list.push(pick);
    else byCapper.set(pick.capperId, [pick]);
  }

  const activityCutoff = new Date(Date.now() - ACTIVITY_WINDOW_DAYS * 86400000);

  const hotStreaks: StreakPanelEntry[] = [];
  const coolingOff: StreakPanelEntry[] = [];
  const rising: RisingPanelEntry[] = [];
  const fallingOff: FallingOffPanelEntry[] = [];
  const bestLast20: BestLast20Entry[] = [];

  for (const capper of cappers) {
    const capperPicks = byCapper.get(capper.id) ?? [];
    if (capperPicks.length === 0) continue;

    const isActive = capperPicks.some((p) => p.datePosted >= activityCutoff);
    if (!isActive) continue;

    const base: PanelCapperBase = { capperId: capper.id, name: capper.name, colorTag: capper.colorTag };
    const stats = computeStats(capperPicks);
    const decidedCount = stats.wins + stats.losses + stats.pushes;

    if (stats.currentStreak.count >= STREAK_PANEL_MIN) {
      const entry: StreakPanelEntry = { ...base, streakCount: stats.currentStreak.count, weightedScore: weightedRoiScore(stats), stats };
      if (stats.currentStreak.type === "WIN") hotStreaks.push(entry);
      else if (stats.currentStreak.type === "LOSS") coolingOff.push(entry);
    }

    // Most-recently-graded-first, for the recent-form panels below.
    // gradedAt is always set for decided (WIN/LOSS/PUSH) picks.
    const decidedPicks = capperPicks
      .filter((p) => p.status === "WIN" || p.status === "LOSS" || p.status === "PUSH")
      .sort(comparePicksByGradedAtDesc);

    // Trending: needs both windows fully populated (8*2=16 decided also
    // covers window-5's smaller 5*2=10 requirement), and both the 5-window
    // and 8-window rise must independently clear the threshold. No sample
    // ceiling and no "new capper only" gate - an established capper with
    // hundreds of decided picks qualifies exactly the same as one with 16.
    if (decidedPicks.length >= TRENDING_CONFIRM_WINDOW * 2) {
      const recent5Pct = windowWinPct(decidedPicks.slice(0, TRENDING_WINDOW));
      const previous5Pct = windowWinPct(decidedPicks.slice(TRENDING_WINDOW, TRENDING_WINDOW * 2));
      const recent8Pct = windowWinPct(decidedPicks.slice(0, TRENDING_CONFIRM_WINDOW));
      const previous8Pct = windowWinPct(decidedPicks.slice(TRENDING_CONFIRM_WINDOW, TRENDING_CONFIRM_WINDOW * 2));

      if (recent5Pct !== null && previous5Pct !== null && recent8Pct !== null && previous8Pct !== null) {
        const rise5 = round2(recent5Pct - previous5Pct);
        const rise8 = round2(recent8Pct - previous8Pct);

        if (rise5 >= TRENDING_THRESHOLD_PTS && rise8 >= TRENDING_THRESHOLD_PTS) {
          rising.push({ ...base, previousWinPct: previous5Pct, recentWinPct: recent5Pct, risePts: rise5 });
        }
      }
    }

    // Falling Off needs a real lifetime baseline (RANKING_MIN_SAMPLE) and enough
    // of its own, narrower window decided to mean anything.
    if (decidedCount >= RANKING_MIN_SAMPLE) {
      const recentForDrop = decidedPicks.slice(0, FALLING_OFF_WINDOW);
      const recentForDropDecided = recentForDrop.length;
      if (recentForDropDecided >= FALLING_OFF_MIN_SAMPLE) {
        const recentWins = recentForDrop.filter((p) => p.status === "WIN").length;
        const recentWinPct = round2((recentWins / recentForDropDecided) * 100);
        const dropPts = round2(stats.winPct - recentWinPct);

        if (dropPts >= FALLING_OFF_THRESHOLD_PTS) {
          fallingOff.push({ ...base, lifetimeWinPct: round2(stats.winPct), recentWinPct, dropPts });
        }
      }
    }

    const recent = decidedPicks.slice(0, RECENT_FORM_WINDOW);
    const recentDecided = recent.length;

    if (decidedCount >= RANKING_MIN_SAMPLE && recentDecided >= RECENT_FORM_MIN_SAMPLE) {
      const recentWins = recent.filter((p) => p.status === "WIN").length;
      const recentLosses = recent.filter((p) => p.status === "LOSS").length;
      const recentPushes = recentDecided - recentWins - recentLosses;
      const recentWinPct = round2((recentWins / recentDecided) * 100);

      // Same shrinkage idea as weightedRoiScore, but pulling toward the
      // -110 breakeven win% (52.4) instead of a 0% ROI prior - ranks Best
      // Last-20 only; the displayed record/win% is always the raw recent
      // rate, same "sort weighted, show raw" pattern as the main leaderboard.
      const weightedScore = round2(
        (recentDecided * recentWinPct + RECENT_FORM_SHRINKAGE_K * SCORECARD_WIN_THRESHOLD) /
          (recentDecided + RECENT_FORM_SHRINKAGE_K)
      );
      bestLast20.push({
        ...base,
        wins: recentWins,
        losses: recentLosses,
        pushes: recentPushes,
        recentWinPct,
        weightedScore,
      });
    }
  }

  hotStreaks.sort((a, b) => b.streakCount - a.streakCount || b.weightedScore - a.weightedScore);
  coolingOff.sort((a, b) => b.streakCount - a.streakCount);
  rising.sort((a, b) => b.risePts - a.risePts);
  fallingOff.sort((a, b) => b.dropPts - a.dropPts);
  bestLast20.sort((a, b) => b.weightedScore - a.weightedScore);
  // Same recent-form pool as Best Last-20, just sorted the other way -
  // small pools can genuinely overlap (e.g. only 2 eligible cappers means
  // the "worst" is also someone's "best"), same as any top-N/bottom-N pair.
  const worstLast20 = [...bestLast20].sort((a, b) => a.weightedScore - b.weightedScore);

  return { hotStreaks, coolingOff, rising, fallingOff, bestLast20, worstLast20 };
}
