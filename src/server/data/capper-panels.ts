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

// Trending: recent-5-vs-previous-5 momentum, confirmed by an independent
// recent-8-vs-previous-8 check both clearing the same bar. A single 5-pick
// window can swing 20pts on one result (5 picks = 20pt granularity), so a
// lone window-5 hit is as likely to be noise as a real trend - requiring an
// 8-pick window to independently agree filters that out while still staying
// responsive enough to catch someone who's turned a corner recently, not
// just someone who's always been good (which is what a lifetime-vs-recent
// comparison conflates). Confirmed against real account data: of several
// window sizes and single/hybrid rules tested, 5-and-8-together was the only
// one that (a) survived cross-window consistency and (b) wasn't left with
// zero measurable population.
const TRENDING_WINDOW = 5;
const TRENDING_CONFIRM_WINDOW = 8;
const TRENDING_THRESHOLD_PTS = 10;

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
// Momentum, not standing: recent-5 win% vs the previous-5 win% right before
// it - same shape as FallingOffPanelEntry (a before/after pair plus the
// delta), just comparing two recent windows instead of recent-vs-lifetime.
export type RisingPanelEntry = PanelCapperBase & {
  previousWinPct: number;
  recentWinPct: number;
  risePts: number;
};
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

// Win% over a slice of decided picks, pushes excluded from the denominator -
// same convention computeStats' winPct uses. Null (not 0) when the slice has
// no decided W/L picks at all, so callers can distinguish "0% window" from
// "nothing to measure" rather than accidentally comparing against a 0.
function windowWinPct(picks: { status: string }[]): number | null {
  const wins = picks.filter((p) => p.status === "WIN").length;
  const losses = picks.filter((p) => p.status === "LOSS").length;
  return wins + losses > 0 ? round2((wins / (wins + losses)) * 100) : null;
}

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
