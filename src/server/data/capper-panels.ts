import {
  round2,
  ALL_TIME_WINDOW,
  RANKING_MIN_SAMPLE,
  SCORECARD_WIN_THRESHOLD,
  DASHBOARD_REPORTS_CACHE_TTL_SECONDS,
  type RecordStats,
} from "@/server/data/stats";
import { getCappersForUser } from "@/server/data/cappers";
import { statsFromRows } from "@/server/data/pick-aggregates-cappers-adapter";
import { queryWindowTotals, queryRecentForm } from "@/server/data/capper-list-aggregates";
import { getStreakPanels } from "@/server/data/cappers-page-aggregates";
import type { StreakEntry } from "@/lib/cappers-panels";
import { cachedByTag } from "@/server/data/cached";
import { cacheKeys } from "@/lib/cache-keys";

// Cappers with no picks logged (datePosted) in this window drop off the four
// recent-form panels below, and reappear the moment they log a new one - confirmed
// with the user as panels-only (the main ranked list has no activity cutoff). The
// two streak panels have /cappers' own eligibility instead (see CapperPanels).
export const ACTIVITY_WINDOW_DAYS = 14;

// Read only by the frozen capper-panels-legacy.ts now: the streak panels here are
// /cappers' Hot Hand / Coldest, with that page's own minimum (lib/cappers-panels.ts).
export const STREAK_PANEL_MIN = 2;

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
export const TRENDING_WINDOW = 5;
export const TRENDING_CONFIRM_WINDOW = 8;
export const TRENDING_THRESHOLD_PTS = 10;

// Best/Worst Last-20's window - "last 20 graded picks" is the panel's own name.
export const RECENT_FORM_WINDOW = 20;
// Need at least half the window decided before recent form means anything.
export const RECENT_FORM_MIN_SAMPLE = 10;

// Falling Off gets its own, narrower window (originally spec'd as "last 10-15
// picks", separate from Best/Worst-20's 20). This isn't just a smaller number for
// its own sake: with a 20-pick window, no capper can ever show a drop until they
// have MORE than 20 decided picks - below that, "recent 20" and "lifetime" are
// the same picks by construction, so dropPts is always exactly 0 no matter how
// bad someone's last few picks are. A real user's cappers rarely rack up more
// than 20 decided picks, so at window=20 this panel is effectively unreachable in
// practice - confirmed against real data, where every capper showed a 0.0pt drop.
// A 10-pick window lets it fire for anyone with as few as ~11-13 decided picks.
export const FALLING_OFF_WINDOW = 10;
export const FALLING_OFF_MIN_SAMPLE = 5;
// "Meaningfully worse" for Falling Off - a flat 10-percentage-point drop.
export const FALLING_OFF_THRESHOLD_PTS = 10;
// Same shrinkage strength as weightedRoiScore, applied to win% instead of
// ROI for Best Last-20 - kept identical for consistency across the page's
// two weighted-ranking mechanisms. Ranks the panel only - the displayed
// record/win% is always the raw recent rate, never the shrunk score.
export const RECENT_FORM_SHRINKAGE_K = 10;
// The line between Best and Worst Last-20: the app-wide win% color rule (getRecordColor).
export const BEST_LAST20_MIN_WIN_PCT = 50;

type PanelCapperBase = { capperId: string; name: string; colorTag: string | null };

// The streak row of the frozen capper-panels-legacy.ts (LegacyCapperPanels); not produced here.
export type StreakPanelEntry = PanelCapperBase & {
  streakCount: number;
  weightedScore: number;
  // RecordStats, not OverallStats: the panels never read the longest-streak fields.
  stats: RecordStats;
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
  // /cappers' Hot Hand and Coldest at "This week" (getStreakPanels): the same rows in
  // the same order, so the dashboard and /cappers always name the same cappers with
  // the same streaks. Unlike the panels below they exclude test cappers, have no
  // 14-day activity cutoff and are never sport-scoped.
  hotStreaks: StreakEntry[];
  coolingOff: StreakEntry[];
  rising: RisingPanelEntry[];
  fallingOff: FallingOffPanelEntry[];
  // Best: recent win% at or above BEST_LAST20_MIN_WIN_PCT; Worst: below it. One pool
  // split in two, so no capper is ever in both.
  bestLast20: BestLast20Entry[];
  worstLast20: BestLast20Entry[];
};
// What capper-panels-legacy.ts returns: the pre-swap streak rows, and Worst as Best reversed.
export type LegacyCapperPanels = Omit<CapperPanels, "hotStreaks" | "coolingOff"> & { hotStreaks: StreakPanelEntry[]; coolingOff: StreakPanelEntry[] };

// Win% over a slice of decided picks, pushes excluded from the denominator -
// same convention computeStats' winPct uses. Null (not 0) when the slice has
// no decided W/L picks at all, so callers can distinguish "0% window" from
// "nothing to measure" rather than accidentally comparing against a 0.
function windowWinPct({ wins, losses }: { wins: number; losses: number }): number | null {
  return wins + losses > 0 ? round2((wins / (wins + losses)) * 100) : null;
}

// `satisfies`, not an annotation: the empty arrays then also fit LegacyCapperPanels.
export const EMPTY_PANELS = {
  hotStreaks: [],
  coolingOff: [],
  rising: [],
  fallingOff: [],
  bestLast20: [],
  worstLast20: [],
} satisfies CapperPanels;

// Only a league scope survives as a filter: the bet-category filter the original
// signature also carried was never set by any caller and is gone.
export type CapperPanelsFilter = { sportName?: string };

// The cache slot is chosen by this string alone (cachedByTag's callback text is
// identical for every user/filter), so every input that changes the result must
// appear here. Distinct from cacheKeys.dashboard - that one is only the shared
// invalidation tag. "v2": the streak rows changed shape, and an entry cached by the
// previous deploy must not be read as the new one.
export function capperPanelsCacheKey(userId: string, filter?: CapperPanelsFilter): string {
  return `capper-panels:v2:${userId}:${filter?.sportName ?? ""}`;
}

// Reads only Pick rows (plus the roster), so it shares getDashboardSummary's
// invalidation tag and TTL: every pick mutation already calls
// revalidateTag(cacheKeys.dashboard(userId)) (docs/cache-invalidation-contract.md).
export async function getCapperPanels(userId: string, filter?: CapperPanelsFilter): Promise<CapperPanels> {
  return cachedByTag(
    capperPanelsCacheKey(userId, filter),
    DASHBOARD_REPORTS_CACHE_TTL_SECONDS,
    () => computeCapperPanels(userId, filter),
    [cacheKeys.dashboard(userId)]
  );
}

// The recent-form slices, derived from the window constants above so the SQL and
// the thresholds cannot drift apart. Ranks are over the capper's decided picks,
// most recently graded first.
const RECENT_FORM_SLICES = {
  recent5: [1, TRENDING_WINDOW],
  previous5: [TRENDING_WINDOW + 1, TRENDING_WINDOW * 2],
  recent8: [1, TRENDING_CONFIRM_WINDOW],
  previous8: [TRENDING_CONFIRM_WINDOW + 1, TRENDING_CONFIRM_WINDOW * 2],
  recentDrop: [1, FALLING_OFF_WINDOW],
  recentForm: [1, RECENT_FORM_WINDOW],
} as const;

// Data source: the database summarizes (capper-list-aggregates.ts - lifetime
// totals from the same query /cappers uses, plus queryRecentForm for the last-N
// slices and the last-posted instant; getStreakPanels for the two streak panels)
// and this function only applies the thresholds. The pick history is never fetched.
async function computeCapperPanels(userId: string, filter?: CapperPanelsFilter): Promise<CapperPanels> {
  const cappers = await getCappersForUser(userId, filter);
  if (cappers.length === 0) return EMPTY_PANELS;

  const now = new Date();
  const [totalRows, streaks, formRows] = await Promise.all([
    queryWindowTotals({ userId, sportName: filter?.sportName, windows: [ALL_TIME_WINDOW], now }),
    getStreakPanels({ userId, now }),
    queryRecentForm({ userId, sportName: filter?.sportName, slices: RECENT_FORM_SLICES }),
  ]);
  const totalsByCapper = new Map(totalRows.map((r) => [r.capperId!, r]));
  const formByCapper = new Map(formRows.map((r) => [r.capperId, r]));

  const activityCutoff = new Date(now.getTime() - ACTIVITY_WINDOW_DAYS * 86400000);

  const rising: RisingPanelEntry[] = [];
  const fallingOff: FallingOffPanelEntry[] = [];
  const bestLast20: BestLast20Entry[] = [];

  for (const capper of cappers) {
    // No row = the capper has no picks at all.
    const form = formByCapper.get(capper.id);
    if (!form) continue;

    const isActive = form.lastPostedAt >= activityCutoff;
    if (!isActive) continue;

    const base: PanelCapperBase = { capperId: capper.id, name: capper.name, colorTag: capper.colorTag };
    const stats = statsFromRows(totalsByCapper.get(capper.id), undefined);
    const decidedCount = stats.wins + stats.losses + stats.pushes;

    const { recent5, previous5, recent8, previous8, recentDrop, recentForm } = form.slices;

    // Trending: needs both windows fully populated (8*2=16 decided also
    // covers window-5's smaller 5*2=10 requirement), and both the 5-window
    // and 8-window rise must independently clear the threshold. No sample
    // ceiling and no "new capper only" gate - an established capper with
    // hundreds of decided picks qualifies exactly the same as one with 16.
    if (decidedCount >= TRENDING_CONFIRM_WINDOW * 2) {
      const recent5Pct = windowWinPct(recent5);
      const previous5Pct = windowWinPct(previous5);
      const recent8Pct = windowWinPct(recent8);
      const previous8Pct = windowWinPct(previous8);

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
      const recentForDropDecided = recentDrop.wins + recentDrop.losses + recentDrop.pushes;
      if (recentForDropDecided >= FALLING_OFF_MIN_SAMPLE) {
        const recentWins = recentDrop.wins;
        const recentWinPct = round2((recentWins / recentForDropDecided) * 100);
        const dropPts = round2(stats.winPct - recentWinPct);

        if (dropPts >= FALLING_OFF_THRESHOLD_PTS) {
          fallingOff.push({ ...base, lifetimeWinPct: round2(stats.winPct), recentWinPct, dropPts });
        }
      }
    }

    const recentDecided = recentForm.wins + recentForm.losses + recentForm.pushes;

    if (decidedCount >= RANKING_MIN_SAMPLE && recentDecided >= RECENT_FORM_MIN_SAMPLE) {
      const recentWins = recentForm.wins;
      const recentLosses = recentForm.losses;
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

  rising.sort((a, b) => b.risePts - a.risePts);
  fallingOff.sort((a, b) => b.dropPts - a.dropPts);
  // One recent-form pool, split on the displayed win%: Best is the half at or above
  // the line (best first), Worst the half below it (worst first).
  bestLast20.sort((a, b) => b.weightedScore - a.weightedScore);
  const isBest = (e: BestLast20Entry) => e.recentWinPct >= BEST_LAST20_MIN_WIN_PCT;

  return {
    hotStreaks: streaks.hottest,
    coolingOff: streaks.coldest,
    rising,
    fallingOff,
    bestLast20: bestLast20.filter(isBest),
    worstLast20: bestLast20.filter((e) => !isBest(e)).sort((a, b) => a.weightedScore - b.weightedScore),
  };
}
