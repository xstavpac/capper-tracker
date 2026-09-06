import { prisma } from "@/lib/prisma";
import type { Pick, PickStatus, PickedSide } from "@prisma/client";
import { favoriteOrUnderdog, extractLine, nrfiSide, oddsBucket, ODDS_BUCKET_LABELS, formatPickLabel, periodLabel, type OddsBucketKey } from "@/lib/bet-line";
import { formatEastern, startOfEasternDay } from "@/lib/dates";
import { cacheKeys } from "@/lib/cache-keys";
import { cachedByTag } from "@/server/data/cached";
import { downsampleUnitsChart } from "@/server/data/units-chart-downsample";

export type OverallStats = {
  wins: number;
  losses: number;
  pushes: number;
  winPct: number;
  unitsWon: number;
  unitsLost: number;
  netUnits: number;
  roi: number;
  currentStreak: { type: "WIN" | "LOSS" | "NONE"; count: number };
  longestWinStreak: number;
  longestLossStreak: number;
};

/**
 * Converts American odds + units risked into units returned on a win.
 * Positive odds (+150): profit = units * (odds / 100)
 * Negative odds (-110): profit = units * (100 / abs(odds))
 */
export function unitsWonOnBet(units: number, odds: number): number {
  if (odds > 0) return units * (odds / 100);
  return units * (100 / Math.abs(odds));
}

/**
 * Computes overall record, ROI, units, and streaks for a set of picks.
 * This is called with all of a user's picks (dashboard) or a single
 * capper's picks (capper page) — same math, different scope.
 */
export function computeStats(picks: Pick[]): OverallStats {
  // Streaks depend on chronological order, so sort oldest -> newest first.
  const sorted = [...picks].sort(
    (a, b) => a.gameTime.getTime() - b.gameTime.getTime()
  );

  let wins = 0;
  let losses = 0;
  let pushes = 0;
  let unitsWon = 0;
  let unitsLost = 0;
  let unitsRisked = 0;

  let longestWinStreak = 0;
  let longestLossStreak = 0;
  let runningWin = 0;
  let runningLoss = 0;

  for (const pick of sorted) {
    if (pick.status === "PENDING" || pick.status === "CANCELLED") continue;

    unitsRisked += pick.units;

    if (pick.status === "WIN") {
      wins++;
      unitsWon += unitsWonOnBet(pick.units, pick.odds);
      runningWin++;
      runningLoss = 0;
      longestWinStreak = Math.max(longestWinStreak, runningWin);
    } else if (pick.status === "LOSS") {
      losses++;
      unitsLost += pick.units;
      runningLoss++;
      runningWin = 0;
      longestLossStreak = Math.max(longestLossStreak, runningLoss);
    } else if (pick.status === "PUSH") {
      pushes++;
      runningWin = 0;
      runningLoss = 0;
    }
  }

  const decided = wins + losses;
  const netUnits = unitsWon - unitsLost;

  return {
    wins,
    losses,
    pushes,
    winPct: decided > 0 ? (wins / decided) * 100 : 0,
    unitsWon: round2(unitsWon),
    unitsLost: round2(unitsLost),
    netUnits: round2(netUnits),
    roi: unitsRisked > 0 ? round2((netUnits / unitsRisked) * 100) : 0,
    currentStreak: currentStreak(sorted),
    longestWinStreak,
    longestLossStreak,
  };
}

// Exported (not just used internally by computeStats) so computeMomentum
// below can call this exact same function repeatedly over successive
// prefixes of a capper's picks, rather than re-deriving streak logic of its
// own - see computeMomentum's comment for why that matters here specifically.
export function currentStreak(
  sortedOldestFirst: Pick[]
): { type: "WIN" | "LOSS" | "NONE"; count: number } {
  const decided = sortedOldestFirst.filter(
    (p) => p.status === "WIN" || p.status === "LOSS"
  );
  if (decided.length === 0) return { type: "NONE", count: 0 };

  const last = decided[decided.length - 1];
  const type = last.status as "WIN" | "LOSS";
  let count = 0;

  for (let i = decided.length - 1; i >= 0; i--) {
    if (decided[i].status === type) count++;
    else break;
  }

  return { type, count };
}

export type MomentumStreakLength = "1" | "2" | "3" | "4+";

export type MomentumRow = {
  length: MomentumStreakLength;
  wins: number;
  losses: number;
  winPct: number;
  netUnits: number;
  sampleSize: number;
};

export type MomentumBreakdown = {
  afterLoss: MomentumRow[]; // fixed 4 rows, in order: "1", "2", "3", "4+"
  afterWin: MomentumRow[];
};

const MOMENTUM_LENGTHS: MomentumStreakLength[] = ["1", "2", "3", "4+"];

function momentumBucketKey(count: number): MomentumStreakLength {
  return count >= 4 ? "4+" : (String(count) as MomentumStreakLength);
}

// How a capper has performed on the pick immediately following a losing or
// winning streak of each length - "after 2L" means every decided pick that
// came right after exactly 2 consecutive losses (not 2+; a 3rd loss's
// following pick counts toward "after 3L" instead), with "4+" bucketing
// every streak of 4 or longer together.
//
// Reuses currentStreak() above directly rather than re-implementing streak
// tracking: for each pick, the streak "entering" it is exactly what
// currentStreak() would report for every pick strictly before it in
// chronological order, so this just calls that function once per pick
// against a growing prefix of the (already win/loss-filtered, chronologically
// sorted) picks array. That also means this automatically inherits
// currentStreak()'s own convention for pushes - they're filtered out before
// the scan even starts (same as currentStreak's own `decided` filter), so a
// push is invisible to streak tracking here exactly like it is for the
// "Current streak" stat card, not a streak-breaker and not itself a pick
// that gets bucketed as "after" anything. O(n^2) in the number of a
// capper's decided picks, which is trivial at realistic volumes (low
// hundreds at most) and far simpler/safer than a second streak
// implementation that could quietly drift from the displayed current streak.
export function computeMomentum(picks: Pick[]): MomentumBreakdown {
  const decided = [...picks]
    .filter((p) => p.status === "WIN" || p.status === "LOSS")
    .sort((a, b) => a.gameTime.getTime() - b.gameTime.getTime());

  const emptyBuckets = (): Record<MomentumStreakLength, { wins: number; losses: number; netUnits: number }> => ({
    "1": { wins: 0, losses: 0, netUnits: 0 },
    "2": { wins: 0, losses: 0, netUnits: 0 },
    "3": { wins: 0, losses: 0, netUnits: 0 },
    "4+": { wins: 0, losses: 0, netUnits: 0 },
  });
  const afterLossBuckets = emptyBuckets();
  const afterWinBuckets = emptyBuckets();

  for (let i = 1; i < decided.length; i++) {
    const preceding = currentStreak(decided.slice(0, i));
    if (preceding.type === "NONE") continue;

    const bucket = (preceding.type === "LOSS" ? afterLossBuckets : afterWinBuckets)[momentumBucketKey(preceding.count)];
    const pick = decided[i];
    if (pick.status === "WIN") {
      bucket.wins++;
      bucket.netUnits += unitsWonOnBet(pick.units, pick.odds);
    } else {
      bucket.losses++;
      bucket.netUnits -= pick.units;
    }
  }

  const toRows = (buckets: Record<MomentumStreakLength, { wins: number; losses: number; netUnits: number }>): MomentumRow[] =>
    MOMENTUM_LENGTHS.map((length) => {
      const b = buckets[length];
      const sampleSize = b.wins + b.losses;
      return {
        length,
        wins: b.wins,
        losses: b.losses,
        winPct: sampleSize > 0 ? (b.wins / sampleSize) * 100 : 0,
        netUnits: round2(b.netUnits),
        sampleSize,
      };
    });

  return { afterLoss: toRows(afterLossBuckets), afterWin: toRows(afterWinBuckets) };
}

export function round2(n: number) {
  return Math.round(n * 100) / 100;
}

// Minimum decided (win+loss+push) picks before a capper gets a numbered rank
// on the main Cappers leaderboard - confirmed with the user alongside the
// weighted-ranking approach below. Below this, a capper's raw ROI is too
// noisy to rank on (a 1-0 capper "looks" better than a 40-10 one by ROI
// alone) - they're deliberately left off the main ranking and surfaced
// instead by the "Rising" panel, which is built for exactly this case.
export const RANKING_MIN_SAMPLE = 5;

// Shrinkage strength in "pseudo-picks", pulling a capper's weighted score
// toward a 0% (breakeven) prior until real volume outweighs it - a capper
// with only RANKING_MIN_SAMPLE picks has just 5/(5+10) = 1/3 of their raw
// ROI reflected in the score, while one with 50 picks has 50/60 = 5/6.
// Chosen (not derived) as a "modest" prior per the user's confirmed
// ROI-based Bayesian shrinkage approach - tune here if rankings feel too
// flat (raise) or too swingy on small samples (lower... within reason,
// samples below RANKING_MIN_SAMPLE never reach this function at all).
const RANKING_SHRINKAGE_K = 10;

// Confidence-weighted ranking score - the main leaderboard's default sort,
// so a small hot streak can't outrank a large real sample. The raw record/
// ROI is still shown alongside this for transparency; this only changes
// sort order, never displayed numbers.
export function weightedRoiScore(stats: OverallStats): number {
  const n = stats.wins + stats.losses + stats.pushes;
  if (n === 0) return 0;
  return round2((stats.roi * n) / (n + RANKING_SHRINKAGE_K));
}

export type OddsRangeStat = {
  bucket: OddsBucketKey;
  label: string;
  wins: number;
  losses: number;
  pushes: number;
  winPct: number;
  count: number;
};

// Minimum decided picks a bucket needs before its win% is trusted enough to
// call it a capper's "best" range - same CATEGORY_LEADERBOARD_MIN_PICKS
// threshold used for the Live page's per-category leaderboards, reused here
// for the same "don't rank on 1-0" reason.
const ODDS_RANGE_MIN_SAMPLE = 3;

// The single odds band this capper performs best in, or null if no band has
// enough of a sample to trust. Ties (equal win%) break toward whichever
// bucket has more decided picks - more evidence behind the same number beats
// less.
export function computeBestOddsRange(picks: Pick[]): OddsRangeStat | null {
  const byBucket = new Map<OddsBucketKey, Pick[]>();
  for (const pick of picks) {
    if (pick.status !== "WIN" && pick.status !== "LOSS" && pick.status !== "PUSH") continue;
    const bucket = oddsBucket(pick.odds);
    const list = byBucket.get(bucket);
    if (list) list.push(pick);
    else byBucket.set(bucket, [pick]);
  }

  let best: OddsRangeStat | null = null;
  for (const [bucket, bucketPicks] of byBucket) {
    if (bucketPicks.length < ODDS_RANGE_MIN_SAMPLE) continue;
    const stats = computeStats(bucketPicks);
    const count = stats.wins + stats.losses + stats.pushes;
    const candidate: OddsRangeStat = {
      bucket,
      label: ODDS_BUCKET_LABELS[bucket],
      wins: stats.wins,
      losses: stats.losses,
      pushes: stats.pushes,
      winPct: stats.winPct,
      count,
    };
    if (!best || candidate.winPct > best.winPct || (candidate.winPct === best.winPct && count > best.count)) {
      best = candidate;
    }
  }
  return best;
}

export type ConsistencyLabel = "Steady" | "Volatile";

// Below this many decided picks, a variance measurement is itself too noisy
// to label anything - same RANKING_MIN_SAMPLE bar used for the main
// leaderboard's numbered rank, reused here for the same reason.
const CONSISTENCY_MIN_SAMPLE = RANKING_MIN_SAMPLE;

// "Steady" vs "Volatile" cutoff, expressed as a coefficient of variation
// (stdev of per-bet unit returns, divided by average units wagered) - not
// derived from any external benchmark, just a judgment call: a capper
// whose per-bet swings are on the same order as their typical bet size
// reads as consistent; one whose swings regularly dwarf their typical bet
// size (mixing -300 locks with +400 fliers) reads as volatile.
const CONSISTENCY_CV_THRESHOLD = 1.5;

function standardDeviation(values: number[]): number {
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// null below CONSISTENCY_MIN_SAMPLE decided picks, or if average units
// wagered is 0 (can't compute a coefficient of variation against a zero
// denominator - shouldn't happen in practice since units > 0 is required at
// pick-creation time, but stay defensive rather than divide by zero).
export function computeConsistency(picks: Pick[]): { label: ConsistencyLabel; cv: number } | null {
  const decided = picks.filter((p) => p.status === "WIN" || p.status === "LOSS" || p.status === "PUSH");
  if (decided.length < CONSISTENCY_MIN_SAMPLE) return null;

  const returns = decided.map((p) => {
    if (p.status === "WIN") return unitsWonOnBet(p.units, p.odds);
    if (p.status === "LOSS") return -p.units;
    return 0;
  });
  const avgUnits = decided.reduce((sum, p) => sum + p.units, 0) / decided.length;
  if (avgUnits === 0) return null;

  const cv = standardDeviation(returns) / avgUnits;
  return { label: cv >= CONSISTENCY_CV_THRESHOLD ? "Volatile" : "Steady", cv: round2(cv) };
}

// A capper's record broken down by bet category, so "good overall" and "good
// at the specific bet they just gave you" can be told apart at a glance.
export type ScorecardBucketKey =
  | "MONEYLINE"
  | "SPREAD_MINUS"
  | "SPREAD_PLUS"
  | "SPREAD"
  | "TOTAL"
  // A team total (one team's own score vs a line) is a distinct market from
  // TOTAL and must never be summed into it - the same reason it's a distinct
  // BetType and a distinct pickCategory key. Was silently dropped from the
  // scorecard before this: bucketKeyForPick fell through to
  // `pick.betType as ScorecardBucketKey`, and "TEAM_TOTAL" wasn't a real key.
  | "TEAM_TOTAL"
  | "PLAYER_PROP"
  | "F5"
  // Every quarter / 2nd-half / hockey-period pick, any bet type, in one
  // bucket - same "graded against a different score, keep it out of the
  // full-game record" reasoning as F5, one step further.
  | "SEGMENT"
  | "NRFI"
  | "YRFI";
export type ScorecardBucket = {
  key: ScorecardBucketKey;
  label: string;
  wins: number;
  losses: number;
  pushes: number;
  winPct: number;
  count: number; // decided picks: wins + losses + pushes
};

// -110 breakeven (110/210) - NOT the color threshold (see getRecordColor
// below, which every color-coded record/win% in the app now goes through).
// Still used as a shrinkage prior for ranking small-sample panels (Best/
// Worst Last-20) toward a realistic baseline instead of raw win%.
export const SCORECARD_WIN_THRESHOLD = 52.4;

// The single color threshold for every win%-coded record in the app - flat
// 50/50 split, no neutral/gray zone and no sample-size gating. Previously
// different components used their own thresholds (52.4% breakeven in the
// scorecard, a 60%/50% split with a gray middle band on the Live page's
// picks section) - this replaces all of them.
export function getRecordColor(winPct: number): "green" | "red" {
  return winPct >= 50 ? "green" : "red";
}

const SCORECARD_BUCKET_ORDER: ScorecardBucketKey[] = [
  "MONEYLINE",
  "SPREAD_MINUS",
  "SPREAD_PLUS",
  "SPREAD",
  "TOTAL",
  "TEAM_TOTAL",
  "PLAYER_PROP",
  "F5",
  "SEGMENT",
  "NRFI",
  "YRFI",
];
const SCORECARD_BUCKET_LABELS: Record<ScorecardBucketKey, string> = {
  MONEYLINE: "Moneyline",
  SPREAD_MINUS: "Spread -",
  SPREAD_PLUS: "Spread +",
  SPREAD: "Spread",
  TOTAL: "Total",
  TEAM_TOTAL: "Team Total",
  PLAYER_PROP: "Player Prop",
  F5: "F5",
  SEGMENT: "Quarter / period",
  NRFI: "NRFI",
  YRFI: "YRFI",
};

// Favorite/underdog for a spread pick, falling back to parsing the line out
// of betDetail when the structured `line` column is empty - same fallback
// grading.ts already uses for older picks that predate that column. Without
// this, picks with no stored line (common for anything logged before the
// bulk-import parser started capturing it) can't be classified at all and
// would silently disappear from both the scorecard and category breakdown.
function spreadSide(pick: {
  odds: number;
  line: number | null;
  betDetail: string | null;
}): "FAVORITE" | "UNDERDOG" | null {
  const line = pick.line ?? extractLine("SPREAD", pick.betDetail ?? "");
  return favoriteOrUnderdog({ betType: "SPREAD", odds: pick.odds, line });
}

// F5 (first half) picks form their own bucket regardless of bet type - a
// first-half spread pick is grouped with other F5 picks, not the full-game
// spread record, since it's graded against a different score entirely.
//
// Full-game spread picks split by which side of the line they're on, same
// favorite/underdog signal pickCategory() uses for Fav ML/Dog ML below - a
// capper's spread record on favorites and dogs isn't the same bet. The plain
// "SPREAD" bucket stays as a fallback for the rare pick with no usable line
// (missing or pick-em/0), so those still get one, rather than being dropped.
function bucketKeyForPick(pick: Pick): ScorecardBucketKey {
  // Team total is its own bucket regardless of period (same as pickCategory's
  // TEAM_TOTAL key and betTypeFilterCategory) - checked first so a first-half
  // or quarter team total doesn't land in F5 / SEGMENT instead.
  if (pick.betType === "TEAM_TOTAL") return "TEAM_TOTAL";
  if (pick.period === "FIRST_HALF") return "F5";
  // Every non-full-game, non-first-half period (quarters, 2nd half, hockey
  // periods) shares one bucket, same as F5 - keeps the Moneyline/Spread/Total
  // records full-game-only.
  if (segmentCategoryPeriod(pick.period)) return "SEGMENT";
  if (pick.betType === "SPREAD") {
    const side = spreadSide(pick);
    if (side === "FAVORITE") return "SPREAD_MINUS";
    if (side === "UNDERDOG") return "SPREAD_PLUS";
    return "SPREAD";
  }
  if (pick.betType === "NRFI") {
    return nrfiSide(pick.betDetail) === "YES_RUN" ? "YRFI" : "NRFI";
  }
  return pick.betType as ScorecardBucketKey;
}

export function computeScorecard(picks: Pick[]): ScorecardBucket[] {
  const byBucket = new Map<ScorecardBucketKey, Pick[]>();
  for (const pick of picks) {
    const key = bucketKeyForPick(pick);
    const existing = byBucket.get(key);
    if (existing) existing.push(pick);
    else byBucket.set(key, [pick]);
  }

  return SCORECARD_BUCKET_ORDER.filter((key) => byBucket.has(key)).map((key) => {
    const stats = computeStats(byBucket.get(key)!);
    const count = stats.wins + stats.losses + stats.pushes;
    return {
      key,
      label: SCORECARD_BUCKET_LABELS[key],
      wins: stats.wins,
      losses: stats.losses,
      pushes: stats.pushes,
      winPct: stats.winPct,
      count,
    };
  });
}

export type ScorecardWindow = "TODAY" | "YESTERDAY" | "LAST_7" | "LAST_30" | "LAST_60" | "ALL";

export const SCORECARD_WINDOW_LABELS: Record<ScorecardWindow, string> = {
  TODAY: "Today",
  YESTERDAY: "Yesterday",
  LAST_7: "Last 7 days",
  LAST_30: "Last 30 days",
  LAST_60: "60 Day",
  ALL: "All time",
};

export const SCORECARD_WINDOWS: ScorecardWindow[] = ["TODAY", "YESTERDAY", "LAST_7", "LAST_30", "LAST_60", "ALL"];

// Every window besides TODAY/YESTERDAY (which pin to Eastern day boundaries
// instead) is just "N days back from now" - kept as a lookup here so adding
// another rolling window is a one-line addition, not another branch.
const WINDOW_DAYS_BACK: Partial<Record<ScorecardWindow, number>> = {
  LAST_7: 7,
  LAST_30: 30,
  LAST_60: 60,
};

// ALL is the one window meant to represent the full roster - every other
// window (TODAY/YESTERDAY and the rolling LAST_N windows alike) scopes the
// leaderboard to "who actually had picks in this period," so a capper with
// zero picks in it is meaningfully absent, not a real 0% entry. Used by
// getCapperLeaderboardTable to exclude 0-pick cappers everywhere but ALL.
export const ALL_TIME_WINDOW: ScorecardWindow = "ALL";

// Scopes the scorecard to picks whose GAME fell within a window, so "am I
// good at spread bets" can be answered for "lately" as well as all-time.
// Windows on gameTime (when the game actually happened), not gradedAt - a
// game's picks can finish grading on either side of an Eastern midnight
// boundary depending on when the async grading cron happens to catch them
// (see grading.ts), which would otherwise split one game's picks across
// Today and Yesterday. Still requires gradedAt to be set, so a pick posted
// today for a game next week (not graded yet) has no place in any window
// but ALL (where it's excluded anyway, same as everywhere else that derives
// records from decided picks only) - that guarantee doesn't require
// gradedAt to be the window's date anchor, just a non-null gate.
export function filterPicksByGameWindow<T extends { gameTime: Date; gradedAt: Date | null }>(
  picks: T[],
  window: ScorecardWindow
): T[] {
  if (window === "ALL") return picks;

  const now = new Date();
  const startOfToday = startOfEasternDay(now);

  let start: Date;
  let end: Date = now;
  if (window === "TODAY") {
    start = startOfToday;
  } else if (window === "YESTERDAY") {
    start = new Date(startOfToday.getTime() - 86400000);
    end = startOfToday;
  } else {
    start = new Date(now.getTime() - WINDOW_DAYS_BACK[window]! * 86400000);
  }

  return picks.filter((p) => p.gradedAt && p.gameTime >= start && p.gameTime < end);
}

// The capper detail page's "Recent picks" list is always scoped to whatever
// sport the "record by category" section is currently showing - including
// that section's DEFAULT sport on first load, not just after an explicit tab
// click. The two sections never disagree: if the stats above read "NCAAF
// record by category", this list reads "recent NCAAF picks". Pass
// `selectedCategorySport` (the already-resolved value, which the page derives
// from the categorySport param falling back to the capper's primary sport).
// It is undefined only when the capper has no category-eligible picks at all
// (no category section renders) - then this falls back to all-sport, since
// there is no sport to be consistent with.
//
// `picks` must be gameTime-ascending (as getPicksForCapper returns them); the
// result is the `limit` most recent, newest first, and the limit applies to
// the SCOPED set (10 recent NCAAF picks, not "NCAAF picks that survive the
// top 10 overall"). `scopedSport` is echoed back for the section heading.
export function selectCapperRecentPicks<T extends { sport: { name: string } }>(
  picks: T[],
  selectedCategorySport: string | undefined,
  limit = 10
): { picks: T[]; scopedSport: string | null } {
  const scopedSport = selectedCategorySport ?? null;
  const base = scopedSport ? picks.filter((p) => p.sport.name === scopedSport) : picks;
  return { picks: [...base].reverse().slice(0, limit), scopedSport };
}

// A finer split than ScorecardBucketKey, built for the Cappers-page
// league/bet-type filter chips - e.g. "Fav ML" and "Dog ML" are both
// MONEYLINE picks but represent opposite sides, so they can't share a
// bucket the way the scorecard (which only cares about bet type + F5) does.
export type PickCategoryKey =
  | "FAV_ML"
  | "DOG_ML"
  | "SPREAD_MINUS"
  | "SPREAD_PLUS"
  // Plain "SPREAD" is the fallback for a full-game / MLB-F5 spread pick whose
  // side can't be read (line is pick'em/0, or missing and unparseable from
  // betDetail) - it used to return null and vanish from every category stat.
  // Mirrors the scorecard's own SPREAD fallback bucket. Not in any chip set.
  | "SPREAD"
  | "OVER"
  | "UNDER"
  | "F5_ML"
  | "FIRST_HALF_ML"
  | "FIRST_HALF_OVER"
  | "FIRST_HALF_UNDER"
  // Non-MLB first-half spread. Single key (no favorite/underdog split), same
  // as FIRST_HALF_ML - a first-half spread pick used to return null here
  // ("no category yet"), silently dropping out of every category stat; it's
  // gradable now (persistFinalScores' first-half score sources), so it gets a
  // real home. MLB first-half spread stays F5_SPREAD_MINUS/PLUS below.
  | "FIRST_HALF_SPREAD"
  | "TD_PROP"
  | "NRFI"
  | "YRFI"
  | "F5_SPREAD_MINUS"
  | "F5_SPREAD_PLUS"
  | "F5_OVER"
  | "F5_UNDER"
  // One tile per sport, combining every period (full game, F5, 1st half,
  // quarters, ...) into a single record - unlike OVER/UNDER, which split by
  // period (F5_OVER vs FIRST_HALF_OVER vs OVER). Backed by BetType.TEAM_TOTAL
  // (schema.prisma), a distinct value from TOTAL - a team total (one team's
  // own score vs a line) is a different market than a game total (both teams
  // combined) and must never be conflated with it, confirmed as a real,
  // already-happened mis-grading bug during the pre-launch Team Total
  // investigation. Only picks tagged TEAM_TOTAL at import time (see
  // parsePickText's isTeamTotalText) land here - existing TOTAL rows are
  // never reclassified retroactively by this category logic.
  | "TEAM_TOTAL"
  // Segment-scoped categories: a Q1 / 2nd-half / hockey-period pick is graded
  // against a different score than the full game (grading.ts resolveOutcome),
  // so its record must never be summed into the plain FAV_ML / OVER / UNDER
  // numbers - the same reasoning FIRST_HALF_ML / FIRST_HALF_OVER already
  // apply, one step further. Key is `<Pick.period>_<side>`. SPREAD stays
  // uncategorized for a segment pick, exactly as a non-MLB first-half spread
  // already is (a consistent gap, not this change's concern). These are
  // deliberately absent from every sport chip set (MLB_CHIP_SET etc.) so the
  // capper "Record by category" tiles stay full-game-only, but they ARE in
  // ALL_CATEGORY_KEYS, so the /live game-card snippet shows a segment pick
  // its own record instead of a conflated one.
  | SegmentCategoryKey;

export const SEGMENT_CATEGORY_PERIODS = [
  "SECOND_HALF",
  "FIRST_QUARTER",
  "SECOND_QUARTER",
  "THIRD_QUARTER",
  "FOURTH_QUARTER",
  "FIRST_PERIOD",
  "SECOND_PERIOD",
  "THIRD_PERIOD",
] as const;
export type SegmentCategoryPeriod = (typeof SEGMENT_CATEGORY_PERIODS)[number];
type SegmentCategorySide = "ML" | "OVER" | "UNDER" | "SPREAD";
export type SegmentCategoryKey = `${SegmentCategoryPeriod}_${SegmentCategorySide}`;

const SEGMENT_CATEGORY_SIDES: SegmentCategorySide[] = ["ML", "OVER", "UNDER", "SPREAD"];
const SEGMENT_CATEGORY_SIDE_SET = new Set<string>(SEGMENT_CATEGORY_SIDES);

export const SEGMENT_CATEGORY_KEYS: SegmentCategoryKey[] = SEGMENT_CATEGORY_PERIODS.flatMap((p) =>
  SEGMENT_CATEGORY_SIDES.map((s) => `${p}_${s}` as SegmentCategoryKey)
);

const SEGMENT_CATEGORY_PERIOD_SET = new Set<string>(SEGMENT_CATEGORY_PERIODS);

// Narrows a raw Pick.period to a SegmentCategoryPeriod (or null for
// FULL_GAME / FIRST_HALF, which have their own category paths).
function segmentCategoryPeriod(period: string): SegmentCategoryPeriod | null {
  return SEGMENT_CATEGORY_PERIOD_SET.has(period) ? (period as SegmentCategoryPeriod) : null;
}

// Short label for a segment period, matching the F5 / 1st-Half chip style
// ("Q1 Over", "2H ML", "P1 Under").
const SEGMENT_PERIOD_SHORT: Record<SegmentCategoryPeriod, string> = {
  SECOND_HALF: "2H",
  FIRST_QUARTER: "Q1",
  SECOND_QUARTER: "Q2",
  THIRD_QUARTER: "Q3",
  FOURTH_QUARTER: "Q4",
  FIRST_PERIOD: "P1",
  SECOND_PERIOD: "P2",
  THIRD_PERIOD: "P3",
};
// Sentence phrasing for the "specialist" tag ("2nd quarter overs specialist").
const SEGMENT_PERIOD_LONG: Record<SegmentCategoryPeriod, string> = {
  SECOND_HALF: "2nd half",
  FIRST_QUARTER: "1st quarter",
  SECOND_QUARTER: "2nd quarter",
  THIRD_QUARTER: "3rd quarter",
  FOURTH_QUARTER: "4th quarter",
  FIRST_PERIOD: "1st period",
  SECOND_PERIOD: "2nd period",
  THIRD_PERIOD: "3rd period",
};
const SEGMENT_SIDE_CHIP: Record<SegmentCategorySide, string> = { ML: "ML", OVER: "Over", UNDER: "Under", SPREAD: "Spread" };

function buildSegmentCategoryMap<T>(
  fn: (period: SegmentCategoryPeriod, side: SegmentCategorySide) => T
): Record<SegmentCategoryKey, T> {
  const out = {} as Record<SegmentCategoryKey, T>;
  for (const period of SEGMENT_CATEGORY_PERIODS) {
    for (const side of SEGMENT_CATEGORY_SIDES) {
      out[`${period}_${side}` as SegmentCategoryKey] = fn(period, side);
    }
  }
  return out;
}

// Split "FIRST_QUARTER_OVER" -> { period: "FIRST_QUARTER", side: "OVER" }, or
// null for a non-segment key. Exported for the /live game-card snippet, which
// renders its own sentence-fragment phrasing off it.
export function splitSegmentCategoryKey(
  key: PickCategoryKey
): { period: SegmentCategoryPeriod; side: SegmentCategorySide } | null {
  const i = key.lastIndexOf("_");
  if (i < 0) return null;
  const period = key.slice(0, i);
  const side = key.slice(i + 1);
  if (!SEGMENT_CATEGORY_PERIOD_SET.has(period) || !SEGMENT_CATEGORY_SIDE_SET.has(side)) return null;
  return { period: period as SegmentCategoryPeriod, side: side as SegmentCategorySide };
}

export const PICK_CATEGORY_LABELS: Record<PickCategoryKey, string> = {
  FAV_ML: "Fav ML",
  DOG_ML: "Dog ML",
  SPREAD_MINUS: "Spread -",
  SPREAD_PLUS: "Spread +",
  SPREAD: "Spread",
  OVER: "Over",
  UNDER: "Under",
  F5_ML: "F5 ML",
  FIRST_HALF_ML: "1st Half ML",
  FIRST_HALF_OVER: "1st Half Over",
  FIRST_HALF_UNDER: "1st Half Under",
  FIRST_HALF_SPREAD: "1st Half Spread",
  TD_PROP: "TD Prop",
  NRFI: "NRFI",
  YRFI: "YRFI",
  F5_SPREAD_MINUS: "F5 Spread -",
  F5_SPREAD_PLUS: "F5 Spread +",
  F5_OVER: "F5 Over",
  F5_UNDER: "F5 Under",
  TEAM_TOTAL: "Team Total",
  ...buildSegmentCategoryMap((period, side) => `${SEGMENT_PERIOD_SHORT[period]} ${SEGMENT_SIDE_CHIP[side]}`),
};

// F5 and NRFI/YRFI are MLB-only chips for now, even though Period/BetType
// could technically represent a first-half bet in another sport - other
// leagues intentionally don't surface those categories yet. Non-MLB
// first-half moneyline picks get their own FIRST_HALF_ML key instead (see
// pickCategory) rather than sharing F5_ML - the two must never be summed
// together, since a capper who bets both MLB and another sport would
// otherwise have their first-half moneyline records silently blended into
// one misleading number. Non-MLB first-half spread/total picks have no
// category key at all yet (same as F5_ML's non-MLB carve-out, just not
// given a FIRST_HALF_ML-style home of their own since nothing needs it today).
export const MLB_CHIP_SET: PickCategoryKey[] = [
  "FAV_ML",
  "DOG_ML",
  "SPREAD_MINUS",
  "SPREAD_PLUS",
  "OVER",
  "UNDER",
  "F5_ML",
  "F5_SPREAD_MINUS",
  "F5_SPREAD_PLUS",
  "F5_OVER",
  "F5_UNDER",
  "NRFI",
  "YRFI",
  "TEAM_TOTAL",
];
export const DEFAULT_CHIP_SET: PickCategoryKey[] = ["FAV_ML", "DOG_ML", "SPREAD_MINUS", "SPREAD_PLUS", "OVER", "UNDER"];

// NFL's own chip set, same idea as MLB_CHIP_SET - first-half ML/over/under
// (real box-score data, see persistFinalScores' supportsFirstHalf) plus
// touchdown-prop (resolveTouchdownProp, NFL-only grading) get their own
// tiles instead of falling back to DEFAULT_CHIP_SET's universal six.
export const NFL_CHIP_SET: PickCategoryKey[] = [
  "FAV_ML",
  "DOG_ML",
  "SPREAD_MINUS",
  "SPREAD_PLUS",
  "OVER",
  "UNDER",
  "FIRST_HALF_ML",
  "FIRST_HALF_OVER",
  "FIRST_HALF_UNDER",
  "FIRST_HALF_SPREAD",
  "TD_PROP",
  "TEAM_TOTAL",
];

// Same as NFL_CHIP_SET minus TD_PROP - NCAAF has its own first-half score
// source now (getNcaafFirstHalfScore, wired into persistFinalScores'
// supportsFirstHalf) so FIRST_HALF_ML/OVER/UNDER are real, gradable
// categories here too, but touchdown-prop grading is explicitly NFL-only
// (resolveTouchdownProp) - confirmed not being built for NCAAF, so TD_PROP
// is deliberately left out rather than added as a category that could never
// leave PENDING.
export const NCAAF_CHIP_SET: PickCategoryKey[] = [
  "FAV_ML",
  "DOG_ML",
  "SPREAD_MINUS",
  "SPREAD_PLUS",
  "OVER",
  "UNDER",
  "FIRST_HALF_ML",
  "FIRST_HALF_OVER",
  "FIRST_HALF_UNDER",
  "FIRST_HALF_SPREAD",
  "TEAM_TOTAL",
];

// NBA's own chip set, same idea as NFL_CHIP_SET (minus TD_PROP - touchdown
// props obviously don't apply to basketball) - first-half ML/Spread/Over/
// Under get their own tiles instead of falling back to DEFAULT_CHIP_SET's
// universal six, now that NBA has its own first-half score source
// (getNbaFirstHalfScore, wired into persistFinalScores' supportsFirstHalf,
// same ESPN summary-endpoint pattern NCAAF's fetcher already uses).
export const NBA_CHIP_SET: PickCategoryKey[] = [
  "FAV_ML",
  "DOG_ML",
  "SPREAD_MINUS",
  "SPREAD_PLUS",
  "OVER",
  "UNDER",
  "FIRST_HALF_ML",
  "FIRST_HALF_OVER",
  "FIRST_HALF_UNDER",
  "FIRST_HALF_SPREAD",
  "TEAM_TOTAL",
];

// NCAAB, NHL, KBO have no first-half score source, so they just get
// DEFAULT_CHIP_SET plus TEAM_TOTAL - same "a map entry, not a new branch"
// reasoning CHIP_SET_BY_SPORT's own comment gives. (NBA used to be here too,
// until it got its own first-half source - see NBA_CHIP_SET above.)
const NCAAB_CHIP_SET: PickCategoryKey[] = [...DEFAULT_CHIP_SET, "TEAM_TOTAL"];
const NHL_CHIP_SET: PickCategoryKey[] = [...DEFAULT_CHIP_SET, "TEAM_TOTAL"];
const KBO_CHIP_SET: PickCategoryKey[] = [...DEFAULT_CHIP_SET, "TEAM_TOTAL"];
// WNBA has a first-half score source (persistFinalScores' supportsFirstHalf),
// so its first-half ML/Over/Under/Spread picks are real gradable categories -
// same chip set as NBA (no TD_PROP, basketball).
const WNBA_CHIP_SET: PickCategoryKey[] = [
  "FAV_ML",
  "DOG_ML",
  "SPREAD_MINUS",
  "SPREAD_PLUS",
  "OVER",
  "UNDER",
  "FIRST_HALF_ML",
  "FIRST_HALF_OVER",
  "FIRST_HALF_UNDER",
  "FIRST_HALF_SPREAD",
  "TEAM_TOTAL",
];

// Sport-specific chip sets, keyed by the sport's display label (uppercased)
// - chipSetForLeague looks this up and falls back to DEFAULT_CHIP_SET for
// every sport not listed here. A map instead of a growing ternary/switch so
// adding another sport's own set is one entry, not a new branch.
const CHIP_SET_BY_SPORT: Record<string, PickCategoryKey[]> = {
  MLB: MLB_CHIP_SET,
  NFL: NFL_CHIP_SET,
  NCAAF: NCAAF_CHIP_SET,
  NBA: NBA_CHIP_SET,
  NCAAB: NCAAB_CHIP_SET,
  NHL: NHL_CHIP_SET,
  WNBA: WNBA_CHIP_SET,
  KBO: KBO_CHIP_SET,
};

// The full universe of every PickCategoryKey value, independent of any one
// sport's own display chip set - getCapperCategoryRecord (picks.ts) relies
// on this to look up an arbitrary single category (which might be F5 ML,
// 1st Half ML, NRFI, or a segment category like Q1 Over) without it being
// filtered out by a sport-specific list like MLB_CHIP_SET, which deliberately
// does NOT include FIRST_HALF_ML (or NFL_CHIP_SET's FIRST_HALF_OVER/
// FIRST_HALF_UNDER/TD_PROP, or any segment category).
export const ALL_CATEGORY_KEYS: PickCategoryKey[] = [
  ...MLB_CHIP_SET,
  "SPREAD",
  "FIRST_HALF_ML",
  "FIRST_HALF_OVER",
  "FIRST_HALF_UNDER",
  "FIRST_HALF_SPREAD",
  "TD_PROP",
  ...SEGMENT_CATEGORY_KEYS,
];

export function chipSetForLeague(sportName: string): PickCategoryKey[] {
  return CHIP_SET_BY_SPORT[sportName.toUpperCase()] ?? DEFAULT_CHIP_SET;
}

type PickCategoryInput = {
  betType: Pick["betType"];
  period: Pick["period"];
  betDetail: string | null;
  odds: number;
  line: number | null;
  // Required (not optional) so every call site is forced to supply a real
  // value - a first-half moneyline pick's category depends on it (F5_ML vs
  // FIRST_HALF_ML below), and a forgotten/wrong value would silently blend
  // two different sports' first-half records together again.
  sportName: string;
  // Optional - only the MONEYLINE FAV_ML/DOG_ML split reads these, and only
  // when both are present (see favoriteOrUnderdog). Every real call site spreads
  // a full Pick row so they flow through automatically; the few that build a
  // partial object by hand simply fall back to the odds-sign heuristic.
  pickedSide?: PickedSide | null;
  mlFavoredSide?: PickedSide | null;
};

export function pickCategory(pick: PickCategoryInput): PickCategoryKey | null {
  if (pick.betType === "NRFI") {
    // NRFI and YRFI share one BetType (see nrfiSide's own comment for why -
    // side is derived from betDetail, never a separate stored value), but
    // they're opposite bets and must never be summed into one record.
    return nrfiSide(pick.betDetail) === "YES_RUN" ? "YRFI" : "NRFI";
  }

  if (pick.betType === "MONEYLINE") {
    if (pick.period === "FIRST_HALF") {
      // F5 ("first 5 innings") is MLB-only terminology - every other sport's
      // first-half moneyline pick gets its own FIRST_HALF_ML key instead of
      // sharing F5_ML, so an NFL capper's 1st-half ML record is never summed
      // together with an MLB capper's F5 ML record for someone who bets both.
      return pick.sportName.toUpperCase() === "MLB" ? "F5_ML" : "FIRST_HALF_ML";
    }
    const seg = segmentCategoryPeriod(pick.period);
    if (seg) return `${seg}_ML`;
    const side = favoriteOrUnderdog(pick);
    return side === "FAVORITE" ? "FAV_ML" : side === "UNDERDOG" ? "DOG_ML" : null;
  }

  if (pick.betType === "SPREAD") {
    // Quarter / 2nd-half / period spread: its own single <period>_SPREAD key
    // (no favorite/underdog split, same as the segment ML key). Never folded
    // into the full-game SPREAD_MINUS/PLUS record, and - unlike before -
    // never dropped as null.
    const seg = segmentCategoryPeriod(pick.period);
    if (seg) return `${seg}_SPREAD`;
    const side = spreadSide(pick);
    if (pick.period === "FIRST_HALF") {
      // Non-MLB first-half spread gets its own single FIRST_HALF_SPREAD key
      // (it's gradable now - persistFinalScores' first-half score sources -
      // and used to return null, silently vanishing from category stats).
      // MLB first-half spread keeps its favorite/underdog split, falling back
      // to plain SPREAD (not null) when the side can't be read.
      if (pick.sportName.toUpperCase() !== "MLB") return "FIRST_HALF_SPREAD";
      return side === "FAVORITE" ? "F5_SPREAD_MINUS" : side === "UNDERDOG" ? "F5_SPREAD_PLUS" : "SPREAD";
    }
    // Plain "SPREAD" (not null) when the pick is pick'em / has no usable line -
    // mirrors bucketKeyForPick's own SPREAD fallback bucket.
    return side === "FAVORITE" ? "SPREAD_MINUS" : side === "UNDERDOG" ? "SPREAD_PLUS" : "SPREAD";
  }

  if (pick.betType === "TEAM_TOTAL") {
    // One tile per sport regardless of period (see TEAM_TOTAL's own
    // comment) - unlike TOTAL below, which splits OVER/UNDER by period
    // (F5_OVER vs FIRST_HALF_OVER vs OVER), a team total's period doesn't
    // fork into a separate category at all.
    return "TEAM_TOTAL";
  }

  if (pick.betType === "TOTAL") {
    const detail = (pick.betDetail ?? "").toLowerCase();
    const isOver = detail.includes("over");
    const isUnder = detail.includes("under");
    if (pick.period === "FIRST_HALF") {
      // Same MLB-only vs everyone-else split as F5_ML/FIRST_HALF_ML above -
      // F5 is baseball-only terminology, every other sport's first-half
      // total gets its own FIRST_HALF_OVER/FIRST_HALF_UNDER key instead.
      // Unlike F5_ML's carve-out, this key isn't graded for every sport that
      // reaches it yet (see persistFinalScores' supportsFirstHalf - only
      // NFL/NCAAF/NBA have a first-half score source so far); any other
      // sport's first-half total pick gets a real category here but will
      // just sit ungraded (PENDING) until that sport gets its own score
      // source too.
      if (pick.sportName.toUpperCase() === "MLB") {
        if (isOver) return "F5_OVER";
        if (isUnder) return "F5_UNDER";
        return null;
      }
      if (isOver) return "FIRST_HALF_OVER";
      if (isUnder) return "FIRST_HALF_UNDER";
      return null;
    }
    const seg = segmentCategoryPeriod(pick.period);
    if (seg) {
      if (isOver) return `${seg}_OVER`;
      if (isUnder) return `${seg}_UNDER`;
      return null;
    }
    if (isOver) return "OVER";
    if (isUnder) return "UNDER";
    return null;
  }

  if (pick.betType === "PLAYER_PROP") {
    // This app only supports touchdown props today (see parseTouchdownProp's
    // own comment) - PLAYER_PROP never means anything else yet, so no
    // per-sport branch is needed here the way TOTAL/MONEYLINE have. Grading
    // itself stays NFL-only (resolveTouchdownProp), independent of this -
    // a non-NFL PLAYER_PROP pick still categorizes as TD_PROP, it just never
    // leaves PENDING since nothing resolves it.
    return "TD_PROP";
  }

  return null;
}

// Friendlier phrasing than PICK_CATEGORY_LABELS for a tag that reads as a
// sentence fragment next to a capper's name ("Underdog specialist") rather
// than a terse filter-chip label ("Dog ML").
const SPECIALIST_LABELS: Record<PickCategoryKey, string> = {
  FAV_ML: "Favorite specialist",
  DOG_ML: "Underdog specialist",
  SPREAD_MINUS: "Favorite spread specialist",
  SPREAD_PLUS: "Underdog spread specialist",
  SPREAD: "Spread specialist",
  OVER: "Overs specialist",
  UNDER: "Unders specialist",
  F5_ML: "First-half specialist",
  FIRST_HALF_ML: "First-half specialist",
  FIRST_HALF_OVER: "First-half overs specialist",
  FIRST_HALF_UNDER: "First-half unders specialist",
  FIRST_HALF_SPREAD: "First-half spread specialist",
  TD_PROP: "Touchdown-prop specialist",
  NRFI: "NRFI specialist",
  YRFI: "YRFI specialist",
  F5_SPREAD_MINUS: "F5 favorite spread specialist",
  F5_SPREAD_PLUS: "F5 underdog spread specialist",
  F5_OVER: "F5 overs specialist",
  F5_UNDER: "F5 unders specialist",
  TEAM_TOTAL: "Team-total specialist",
  ...buildSegmentCategoryMap((period, side) => {
    const noun =
      side === "ML"
        ? "moneyline specialist"
        : side === "OVER"
          ? "overs specialist"
          : side === "UNDER"
            ? "unders specialist"
            : "spread specialist";
    return `${SEGMENT_PERIOD_LONG[period]} ${noun}`;
  }),
};

// A category holding at least this share of a capper's decided volume is a
// real concentration, not incidental - confirmed with the user alongside
// the win%-floor and RANKING_MIN_SAMPLE sample-floor below.
const SPECIALIST_CONCENTRATION_THRESHOLD = 0.5;

export type SpecialistTag = { category: PickCategoryKey; label: string };

// Tags a capper as a specialist in one category when that category holds
// >=50% of their decided volume, has >=RANKING_MIN_SAMPLE decided picks of
// its own, AND its win% is at or above their overall win% - concentration
// alone isn't enough (that's just what they mostly bet, not what they're
// good at); this also requires it to actually be working. If more than one
// category clears all three bars, the one with the larger share wins.
export function computeSpecialistTag(picks: (Pick & { sport: { name: string } })[]): SpecialistTag | null {
  const decided = picks.filter((p) => p.status === "WIN" || p.status === "LOSS" || p.status === "PUSH");
  if (decided.length === 0) return null;

  const overall = computeStats(decided);

  const byCategory = new Map<PickCategoryKey, Pick[]>();
  for (const pick of decided) {
    const category = pickCategory({ ...pick, sportName: pick.sport.name });
    if (!category) continue;
    const list = byCategory.get(category);
    if (list) list.push(pick);
    else byCategory.set(category, [pick]);
  }

  let best: { category: PickCategoryKey; share: number } | null = null;
  for (const [category, categoryPicks] of byCategory) {
    const share = categoryPicks.length / decided.length;
    if (share < SPECIALIST_CONCENTRATION_THRESHOLD) continue;
    if (categoryPicks.length < RANKING_MIN_SAMPLE) continue;
    const categoryStats = computeStats(categoryPicks);
    if (categoryStats.winPct < overall.winPct) continue;
    if (!best || share > best.share) best = { category, share };
  }

  return best ? { category: best.category, label: SPECIALIST_LABELS[best.category] } : null;
}

// A capper's record over just their most recent N decided picks in one
// category - a "recent form" signal alongside the all-time record. Same
// winPct convention as everywhere else (wins / (wins + losses); pushes shown
// in the W-L-P string but not the %).
export type CategoryRecentForm = { wins: number; losses: number; pushes: number; winPct: number; count: number };

export type CategoryBreakdownItem = {
  key: PickCategoryKey;
  label: string;
  wins: number;
  losses: number;
  pushes: number;
  winPct: number;
  count: number; // decided picks: wins + losses + pushes
  // Populated ONLY when computeCategoryBreakdown is called with a recentForm
  // option AND this category has at least `minSample` decided picks - the
  // staleness-guard threshold below which "all-time" is still the honest
  // signal and no partial recent-form teaser is shown. Undefined for every
  // caller that doesn't ask for it (Dashboard / Reports / Cappers page).
  recent?: CategoryRecentForm | null;
};

// The two thresholds the /live game-card expander uses for the recent-form
// indicator (see game-picks-expander.tsx): only surface "last 20" once a
// capper has enough category volume for all-time to plausibly be stale.
export const CATEGORY_RECENT_FORM_MIN_SAMPLE = 100;
export const CATEGORY_RECENT_FORM_WINDOW = 20;

// All-time record split by pickCategory (the same favorite/underdog,
// over/under classifier the Cappers-page filter chips use) - answers "am I
// better off following favorites or dogs, overs or unders" at a glance.
// Same shape as computeScorecard, just a different grouping key. `order`
// controls which categories appear and in what sequence - callers covering
// multiple sports at once (the Dashboard) must pass DEFAULT_CHIP_SET, since
// F5 ML and NRFI only mean anything for MLB; a single-sport view can pass
// chipSetForLeague(sportName) to get those back.
//
// `recentForm`, when given, additionally attaches item.recent: the record
// over that category's most recent `window` decided picks (by gameTime desc -
// the same axis computeMomentum uses for "recent"), but only for categories
// with >= `minSample` total decided picks. It's one extra computeStats() call
// on a slice of an already-grouped list, not a second classification pass.
export function computeCategoryBreakdown(
  picks: (Pick & { sport: { name: string } })[],
  order: PickCategoryKey[],
  recentForm?: { window: number; minSample: number }
): CategoryBreakdownItem[] {
  const byCategory = new Map<PickCategoryKey, Pick[]>();
  for (const pick of picks) {
    const key = pickCategory({ ...pick, sportName: pick.sport.name });
    if (!key) continue;
    const existing = byCategory.get(key);
    if (existing) existing.push(pick);
    else byCategory.set(key, [pick]);
  }

  return order.filter((key) => byCategory.has(key)).map((key) => {
    const categoryPicks = byCategory.get(key)!;
    const stats = computeStats(categoryPicks);
    const count = stats.wins + stats.losses + stats.pushes;

    let recent: CategoryRecentForm | null | undefined;
    if (recentForm) {
      recent = null;
      if (count >= recentForm.minSample) {
        const lastN = categoryPicks
          .filter((p) => p.status === "WIN" || p.status === "LOSS" || p.status === "PUSH")
          .sort((a, b) => b.gameTime.getTime() - a.gameTime.getTime())
          .slice(0, recentForm.window);
        const rs = computeStats(lastN);
        recent = { wins: rs.wins, losses: rs.losses, pushes: rs.pushes, winPct: rs.winPct, count: rs.wins + rs.losses + rs.pushes };
      }
    }

    return {
      key,
      label: PICK_CATEGORY_LABELS[key],
      wins: stats.wins,
      losses: stats.losses,
      pushes: stats.pushes,
      winPct: stats.winPct,
      count,
      ...(recent !== undefined ? { recent } : {}),
    };
  });
}

// Lean pick rows for the dashboard + reports aggregations: every scalar
// column (computeStats / computeCategoryBreakdown / computeUnitsChartData all
// need those) plus ONLY the id/name of each relation the breakdowns group
// by. Deliberately not `include: { capper: true, ... }` - that shipped a full
// capper row per pick, which on a 10k-30k-pick history is ~10-20x this
// payload and a lot of wasted Prisma hydration. Scoped by userId - never
// call prisma.pick directly.
async function getPickRowsForStats(userId: string) {
  return prisma.pick.findMany({
    where: { userId },
    orderBy: { gameTime: "desc" },
    include: {
      sport: { select: { name: true } },
      capper: { select: { id: true, name: true } },
      league: { select: { id: true, name: true } },
    },
  });
}

// Dashboard/Reports read only Pick rows, so their caches are invalidated
// purely by pick mutations (see cacheKeys + the revalidateTag calls in the
// pick/capper server actions and the grade-picks cron). revalidate is the
// backstop for the one path that can't tag - opportunistic page-load grading,
// which runs during render where revalidateTag is illegal.
const DASHBOARD_REPORTS_CACHE_TTL_SECONDS = 60;
const STALE_PENDING_HOURS = 24;

/** Dashboard summary - fully derived; callers never re-process a pick array. */
export async function getDashboardSummary(userId: string) {
  return cachedByTag(cacheKeys.dashboard(userId), DASHBOARD_REPORTS_CACHE_TTL_SECONDS, () =>
    computeDashboardSummary(userId)
  );
}

async function computeDashboardSummary(userId: string) {
  const picks = await getPickRowsForStats(userId);
  const staleCutoff = Date.now() - STALE_PENDING_HOURS * 3600000;

  return {
    overall: computeStats(picks),
    totalPicks: picks.length,
    // DEFAULT_CHIP_SET, not chipSetForLeague - this mixes every sport
    // together, and F5 ML/NRFI only mean anything within MLB (see
    // getSportCategoryPanelData in server/data/cappers.ts for the per-sport
    // equivalent, which also powers that panel's per-category leaderboards).
    categoryBreakdown: computeCategoryBreakdown(picks, DEFAULT_CHIP_SET),
    // Derived here, once, from the array already in hand - the page must not
    // re-fetch the history to build its own chart. Downsampled for the
    // dashboard ONLY (see units-chart-downsample.ts): a 20k+ settled-pick
    // history is more points than the chart can render distinctly and bloats
    // this cached payload. computeUnitsChartData itself stays full-fidelity
    // for the per-capper page and computeMaxDrawdown.
    chartData: downsampleUnitsChart(computeUnitsChartData(picks)),
    pendingCount: picks.filter((p) => p.status === "PENDING").length,
    stalePendingCount: picks.filter((p) => p.status === "PENDING" && p.gameTime.getTime() < staleCutoff).length,
    // Flattened to exactly what the Recent Picks list renders - keeps the
    // cached payload small and free of Date-serialization ambiguity.
    recentPicks: picks.slice(0, 10).map((p) => ({
      id: p.id,
      awayTeam: p.awayTeam,
      homeTeam: p.homeTeam,
      label: formatPickLabel(p.betDetail, p.betType, p.line) ?? betTypeLabel(p.betType),
      capperName: p.capper.name,
      status: p.status,
      units: p.units,
    })),
  };
}

export type ReportBreakdownItem = { name: string; stats: OverallStats; count: number };

export async function getReportsData(userId: string) {
  return cachedByTag(cacheKeys.reports(userId), DASHBOARD_REPORTS_CACHE_TTL_SECONDS, () => computeReportsData(userId));
}

async function computeReportsData(userId: string) {
  const picks = await getPickRowsForStats(userId);
  const overall = computeStats(picks);

  function groupBy<T extends { id: string; name: string }>(
    getGroupKey: (pick: (typeof picks)[number]) => T | null
  ): ReportBreakdownItem[] {
    const map = new Map<string, { name: string; picks: typeof picks }>();
    for (const pick of picks) {
      const group = getGroupKey(pick);
      if (!group) continue;
      const existing = map.get(group.id);
      if (existing) {
        existing.picks.push(pick);
      } else {
        map.set(group.id, { name: group.name, picks: [pick] });
      }
    }
    return Array.from(map.values())
      .map((g) => ({ name: g.name, stats: computeStats(g.picks), count: g.picks.length }))
      .sort((a, b) => b.stats.roi - a.stats.roi);
  }

  const byCapper = groupBy((p) => ({ id: p.capperId, name: p.capper.name }));
  const bySport = groupBy((p) => ({ id: p.sportId, name: p.sport.name }));
  const byLeague = groupBy((p) => (p.league ? { id: p.league.id, name: p.league.name } : null));
  const byBetType = groupBy((p) => ({ id: p.betType, name: betTypeLabel(p.betType) }));
  const byPeriod = groupBy((p) => ({
    id: p.period,
    name:
      p.period === "FIRST_HALF"
        ? "First half / F5"
        : p.period === "FULL_GAME"
          ? "Full game"
          : periodLabel(p.period).replace(/^./, (c) => c.toUpperCase()),
  }));
  const byFavoriteDog = groupBy((p) => {
    const side = favoriteOrUnderdog(p);
    return side ? { id: side, name: side === "FAVORITE" ? "Favorite" : "Underdog" } : null;
  });

  return {
    overall,
    byCapper,
    bySport,
    byLeague,
    byBetType,
    byPeriod,
    byFavoriteDog,
    bestCapper: byCapper[0] ?? null,
    worstCapper: byCapper[byCapper.length - 1] ?? null,
    bestSport: bySport[0] ?? null,
    worstSport: bySport[bySport.length - 1] ?? null,
    bestBetType: byBetType[0] ?? null,
  };
}

export function betTypeLabel(betType: string) {
  switch (betType) {
    case "SPREAD":
      return "Spread";
    case "MONEYLINE":
      return "Moneyline";
    case "TOTAL":
      return "Total";
    case "TEAM_TOTAL":
      return "Team Total";
    case "PLAYER_PROP":
      return "Player Prop";
    default:
      return betType;
  }
}


export type UnitsChartPoint = { date: string; cumulativeUnits: number };
export type PickNumberChartPoint = { pickNumber: number; cumulativeUnits: number };

type CumulativeUnitsPoint = { pick: Pick; cumulativeUnits: number };

// The actual profit-curve math, shared by every consumer that needs a
// running cumulative-units total in chronological order - computeUnitsChartData
// (below, date-labeled x-axis) and computeUnitsChartByPickNumber /
// computeMaxDrawdown (index-labeled x-axis, for the capper comparison tool,
// which can't use calendar dates since two cappers' picks won't share
// days). One accumulation pass, two label projections - a date and a pick
// count are just two different names for the same position in this same
// series, not two different calculations.
function computeCumulativeUnitsSeries(picks: Pick[]): CumulativeUnitsPoint[] {
  const settled = [...picks]
    .filter((p) => p.status === "WIN" || p.status === "LOSS" || p.status === "PUSH")
    .sort((a, b) => a.gameTime.getTime() - b.gameTime.getTime());

  let running = 0;
  return settled.map((pick) => {
    if (pick.status === "WIN") {
      running += unitsWonOnBet(pick.units, pick.odds);
    } else if (pick.status === "LOSS") {
      running -= pick.units;
    }
    return { pick, cumulativeUnits: round2(running) };
  });
}

export function computeUnitsChartData(picks: Pick[]): UnitsChartPoint[] {
  return computeCumulativeUnitsSeries(picks).map((p) => ({
    date: formatEastern(p.pick.gameTime, { month: "short", day: "numeric" }),
    cumulativeUnits: p.cumulativeUnits,
  }));
}

// Same series as computeUnitsChartData, x-axis relabeled to "pick 1, 2,
// 3..." instead of calendar date - what the capper comparison tool's
// Overlay view plots both cappers on, so trajectory SHAPE is comparable
// regardless of how many picks each capper has logged or over what real
// date range.
export function computeUnitsChartByPickNumber(picks: Pick[]): PickNumberChartPoint[] {
  return computeCumulativeUnitsSeries(picks).map((p, i) => ({
    pickNumber: i + 1,
    cumulativeUnits: p.cumulativeUnits,
  }));
}

// Largest peak-to-trough decline in cumulative units ever observed, walking
// the same chronological series computeUnitsChartData/
// computeUnitsChartByPickNumber use - the standard drawdown definition
// (running peak, not just "lowest point reached"), so a capper who went
// +10u then fell to +4u shows a 6u drawdown even though they're still up
// overall, not 0 just because they never went negative. Peak starts at 0
// (before any picks are placed, cumulative units is 0 by definition), so a
// capper's very first pick being a loss already counts as a real drawdown
// from that starting point, not a value waiting to be established. Returns
// 0 for a capper with no settled picks (or one whose picks only ever went
// up) - never negative.
export function computeMaxDrawdown(picks: Pick[]): number {
  const series = computeCumulativeUnitsSeries(picks);
  let peak = 0;
  let maxDrawdown = 0;
  for (const point of series) {
    if (point.cumulativeUnits > peak) peak = point.cumulativeUnits;
    const drawdown = peak - point.cumulativeUnits;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }
  return round2(maxDrawdown);
}
