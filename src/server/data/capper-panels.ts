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

// Best/Worst Last-20's window - "last 20 graded picks" is the panel's own name.
const RECENT_FORM_WINDOW = 20;
// Need at least half the window decided before recent form means anything.
const RECENT_FORM_MIN_SAMPLE = 10;

// Falling Off gets its own, narrower window (originally spec'd as "last 10-15
// picks", separate from Best/Worst-20's 20). This isn't just a smaller number for
// its own sake: with a 20-pick window, no capper can ever show a drop until they
// have MORE than 20 decided picks - below that, "recent 20" and "lifetime" are
// the same picks by construction, so dropPts is always exactly 0 no matter how
// bad someone's last few picks are. A real user's cappers rarely rack up more
// than 20 decided picks, so at window=20 this panel is effectively unreachable in
// practice - confirmed against real data, where every capper showed a 0.0pt drop.
// A 10-pick window lets it fire for anyone with as few as ~11-13 decided picks.
const FALLING_OFF_WINDOW = 10;
const FALLING_OFF_MIN_SAMPLE = 5;
// "Meaningfully worse" for Falling Off - a flat 10-percentage-point drop.
const FALLING_OFF_THRESHOLD_PTS = 10;
// Same shrinkage strength as weightedRoiScore, applied to win% instead of
// ROI for Best Last-20 - kept identical for consistency across the page's
// two weighted-ranking mechanisms. Ranks the panel only - the displayed
// record/win% is always the raw recent rate, never the shrunk score.
const RECENT_FORM_SHRINKAGE_K = 10;

type PanelCapperBase = { capperId: string; name: string; colorTag: string | null };

export type StreakPanelEntry = PanelCapperBase & {
  streakCount: number;
  weightedScore: number;
  stats: OverallStats;
};
// Deliberately minimal - just the record. winPct (for the progress-bar fill)
// is derived from wins/losses/pushes by the UI, same as everywhere else.
export type RisingPanelEntry = PanelCapperBase & { wins: number; losses: number; pushes: number };
export type FallingOffPanelEntry = PanelCapperBase & {
  lifetimeWinPct: number;
  recentWinPct: number;
  dropPts: number;
};
// Deliberately simple - just the raw record and win% over the last 20 graded
// picks. No lifetime comparison here (that's what Falling Off is for).
export type BestLast20Entry = PanelCapperBase & {
  wins: number;
  losses: number;
  pushes: number;
  recentWinPct: number;
  weightedScore: number; // ranks the panel only, never displayed
};

export type CapperPanels = {
  hotStreaks: StreakPanelEntry[];
  coolingOff: StreakPanelEntry[];
  rising: RisingPanelEntry[];
  fallingOff: FallingOffPanelEntry[];
  bestLast20: BestLast20Entry[];
  worstLast20: BestLast20Entry[];
};

const EMPTY_PANELS: CapperPanels = {
  hotStreaks: [],
  coolingOff: [],
  rising: [],
  fallingOff: [],
  bestLast20: [],
  worstLast20: [],
};

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
      .sort((a, b) => (b.gradedAt?.getTime() ?? 0) - (a.gradedAt?.getTime() ?? 0));

    // Rising: below the main ranking's sample cutoff, AND actively on a win
    // streak right now - not just a net-positive record that happens to
    // include a loss. A capper sitting on a loss as their most recent result
    // isn't "catching fire," even if their overall small-sample record is
    // still positive - currentStreak already captures "most recent result
    // streak," the same definition Hot Streaks uses.
    if (
      decidedCount > 0 &&
      decidedCount < RANKING_MIN_SAMPLE &&
      stats.currentStreak.type === "WIN" &&
      stats.currentStreak.count >= STREAK_PANEL_MIN
    ) {
      rising.push({ ...base, wins: stats.wins, losses: stats.losses, pushes: stats.pushes });
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
  rising.sort(
    (a, b) =>
      (b.wins - b.losses - (a.wins - a.losses)) ||
      (b.wins + b.losses + b.pushes - (a.wins + a.losses + a.pushes))
  );
  fallingOff.sort((a, b) => b.dropPts - a.dropPts);
  bestLast20.sort((a, b) => b.weightedScore - a.weightedScore);
  // Same recent-form pool as Best Last-20, just sorted the other way -
  // small pools can genuinely overlap (e.g. only 2 eligible cappers means
  // the "worst" is also someone's "best"), same as any top-N/bottom-N pair.
  const worstLast20 = [...bestLast20].sort((a, b) => a.weightedScore - b.weightedScore);

  return { hotStreaks, coolingOff, rising, fallingOff, bestLast20, worstLast20 };
}
