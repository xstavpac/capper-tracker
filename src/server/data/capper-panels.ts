import { prisma } from "@/lib/prisma";
import {
  computeStats,
  pickCategory,
  weightedRoiScore,
  round2,
  RANKING_MIN_SAMPLE,
  SCORECARD_WIN_THRESHOLD,
  type OverallStats,
} from "@/server/data/stats";
import { getCappersForUser, type CapperLeagueFilter } from "@/server/data/cappers";

// Cappers with no picks logged (datePosted) in this window drop off every
// panel below, and reappear the moment they log a new one - confirmed with
// the user as panels-only (the main ranked list has no activity cutoff).
const ACTIVITY_WINDOW_DAYS = 14;

// Same win-streak-badge threshold used in the main ranked list's flame/
// snowflake badge - a single win/loss isn't a "streak" worth surfacing here.
const STREAK_PANEL_MIN = 2;

// Window size shared by Falling Off and Best Last-10, per the user's request
// (both look at "recent form").
const RECENT_FORM_WINDOW = 10;
// Need at least half the window decided before recent form means anything.
const RECENT_FORM_MIN_SAMPLE = 5;
// "Meaningfully worse" for Falling Off - a flat 10-percentage-point drop.
const FALLING_OFF_THRESHOLD_PTS = 10;
// Same shrinkage strength as weightedRoiScore, applied to win% instead of
// ROI for Best Last-10 - kept identical for consistency across the page's
// two weighted-ranking mechanisms.
const RECENT_FORM_SHRINKAGE_K = 10;

type PanelCapperBase = { capperId: string; name: string; colorTag: string | null };

export type StreakPanelEntry = PanelCapperBase & {
  streakCount: number;
  weightedScore: number;
  stats: OverallStats;
};
export type RisingPanelEntry = PanelCapperBase & { wins: number; losses: number; pushes: number };
export type FallingOffPanelEntry = PanelCapperBase & {
  lifetimeWinPct: number;
  recentWinPct: number;
  dropPts: number;
};
export type BestLast10Entry = PanelCapperBase & {
  recentWinPct: number;
  lifetimeWinPct: number;
  deltaPts: number;
  weightedScore: number;
};

export type CapperPanels = {
  hotStreaks: StreakPanelEntry[];
  coolingOff: StreakPanelEntry[];
  rising: RisingPanelEntry[];
  fallingOff: FallingOffPanelEntry[];
  bestLast10: BestLast10Entry[];
};

const EMPTY_PANELS: CapperPanels = { hotStreaks: [], coolingOff: [], rising: [], fallingOff: [], bestLast10: [] };

export async function getCapperPanels(userId: string, filter?: CapperLeagueFilter): Promise<CapperPanels> {
  const cappers = await getCappersForUser(userId, filter);
  if (cappers.length === 0) return EMPTY_PANELS;

  const picks = await prisma.pick.findMany({
    where: {
      userId,
      capperId: { in: cappers.map((c) => c.id) },
      ...(filter?.sportName ? { sport: { name: filter.sportName } } : {}),
    },
  });
  const scoped = filter?.category ? picks.filter((p) => pickCategory(p) === filter.category) : picks;

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
  const bestLast10: BestLast10Entry[] = [];

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

    // Rising: below the main ranking's sample cutoff, but net positive so far -
    // the spot the weighted ranking deliberately keeps these cappers off of.
    if (decidedCount > 0 && decidedCount < RANKING_MIN_SAMPLE && stats.wins > stats.losses) {
      rising.push({ ...base, wins: stats.wins, losses: stats.losses, pushes: stats.pushes });
    }

    // Recent-10 window: most recently graded picks first. gradedAt is always
    // set for decided (WIN/LOSS/PUSH) picks, so this sort is safe.
    const decidedPicks = capperPicks
      .filter((p) => p.status === "WIN" || p.status === "LOSS" || p.status === "PUSH")
      .sort((a, b) => (b.gradedAt?.getTime() ?? 0) - (a.gradedAt?.getTime() ?? 0));
    const recent = decidedPicks.slice(0, RECENT_FORM_WINDOW);
    const recentDecided = recent.length;

    // Both recent-form panels need a real lifetime baseline (RANKING_MIN_SAMPLE)
    // and enough of the recent window decided to mean anything.
    if (decidedCount >= RANKING_MIN_SAMPLE && recentDecided >= RECENT_FORM_MIN_SAMPLE) {
      const recentWins = recent.filter((p) => p.status === "WIN").length;
      const recentWinPct = round2((recentWins / recentDecided) * 100);
      const dropPts = round2(stats.winPct - recentWinPct);

      if (dropPts >= FALLING_OFF_THRESHOLD_PTS) {
        fallingOff.push({ ...base, lifetimeWinPct: stats.winPct, recentWinPct, dropPts });
      }

      // Same shrinkage idea as weightedRoiScore, but pulling toward the
      // -110 breakeven win% (52.4) instead of a 0% ROI prior - this ranks
      // Best Last-10, while the displayed 77%-style number stays the raw
      // recent rate for transparency, same pattern as the main leaderboard.
      const weightedScore = round2(
        (recentDecided * recentWinPct + RECENT_FORM_SHRINKAGE_K * SCORECARD_WIN_THRESHOLD) /
          (recentDecided + RECENT_FORM_SHRINKAGE_K)
      );
      bestLast10.push({
        ...base,
        recentWinPct,
        lifetimeWinPct: stats.winPct,
        deltaPts: round2(recentWinPct - stats.winPct),
        weightedScore,
      });
    }
  }

  hotStreaks.sort((a, b) => b.streakCount - a.streakCount || b.weightedScore - a.weightedScore);
  coolingOff.sort((a, b) => b.streakCount - a.streakCount);
  rising.sort(
    (a, b) =>
      (b.wins - b.losses - (a.wins - a.losses)) ||
      (b.wins + b.losses + b.pushes - (a.wins + a.losses + a.pushes))
  );
  fallingOff.sort((a, b) => b.dropPts - a.dropPts);
  bestLast10.sort((a, b) => b.weightedScore - a.weightedScore);

  return { hotStreaks, coolingOff, rising, fallingOff, bestLast10 };
}
