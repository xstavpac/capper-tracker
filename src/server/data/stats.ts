import { prisma } from "@/lib/prisma";
import type { Pick, PickStatus } from "@prisma/client";
import { favoriteOrUnderdog, extractLine, nrfiSide } from "@/lib/bet-line";
import { formatEastern, startOfEasternDay } from "@/lib/dates";

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

function currentStreak(
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

// Coarse, fixed odds bands - no precedent for this anywhere else in the app
// (odds is a raw Int on Pick), and MLB/NFL/NBA all use roughly the same
// American-odds shape, so one universal set of bands works across sports.
// Deliberately broad rather than tight (e.g. the classic -110/-120/-130
// splits) - narrower bands would leave most cappers without a real sample in
// more than one bucket to compare, defeating the point of "which range are
// they best in."
export type OddsBucketKey = "HEAVY_FAV" | "FAV" | "EVEN" | "DOG" | "HEAVY_DOG";

export const ODDS_BUCKET_LABELS: Record<OddsBucketKey, string> = {
  HEAVY_FAV: "-200 or shorter",
  FAV: "-199 to -110",
  EVEN: "-109 to +109",
  DOG: "+110 to +199",
  HEAVY_DOG: "+200 or longer",
};

export function oddsBucket(odds: number): OddsBucketKey {
  if (odds <= -200) return "HEAVY_FAV";
  if (odds <= -110) return "FAV";
  if (odds <= 109) return "EVEN";
  if (odds <= 199) return "DOG";
  return "HEAVY_DOG";
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
  | "PLAYER_PROP"
  | "F5"
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
  "PLAYER_PROP",
  "F5",
  "NRFI",
  "YRFI",
];
const SCORECARD_BUCKET_LABELS: Record<ScorecardBucketKey, string> = {
  MONEYLINE: "Moneyline",
  SPREAD_MINUS: "Spread -",
  SPREAD_PLUS: "Spread +",
  SPREAD: "Spread",
  TOTAL: "Total",
  PLAYER_PROP: "Player Prop",
  F5: "F5",
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
  if (pick.period === "FIRST_HALF") return "F5";
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

// A finer split than ScorecardBucketKey, built for the Cappers-page
// league/bet-type filter chips - e.g. "Fav ML" and "Dog ML" are both
// MONEYLINE picks but represent opposite sides, so they can't share a
// bucket the way the scorecard (which only cares about bet type + F5) does.
export type PickCategoryKey =
  | "FAV_ML"
  | "DOG_ML"
  | "SPREAD_MINUS"
  | "SPREAD_PLUS"
  | "OVER"
  | "UNDER"
  | "F5_ML"
  | "FIRST_HALF_ML"
  | "FIRST_HALF_OVER"
  | "FIRST_HALF_UNDER"
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
  | "TEAM_TOTAL";

export const PICK_CATEGORY_LABELS: Record<PickCategoryKey, string> = {
  FAV_ML: "Fav ML",
  DOG_ML: "Dog ML",
  SPREAD_MINUS: "Spread -",
  SPREAD_PLUS: "Spread +",
  OVER: "Over",
  UNDER: "Under",
  F5_ML: "F5 ML",
  FIRST_HALF_ML: "1st Half ML",
  FIRST_HALF_OVER: "1st Half Over",
  FIRST_HALF_UNDER: "1st Half Under",
  TD_PROP: "TD Prop",
  NRFI: "NRFI",
  YRFI: "YRFI",
  F5_SPREAD_MINUS: "F5 Spread -",
  F5_SPREAD_PLUS: "F5 Spread +",
  F5_OVER: "F5 Over",
  F5_UNDER: "F5 Under",
  TEAM_TOTAL: "Team Total",
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
  "TEAM_TOTAL",
];

// The remaining leagues the Team Total tile was asked for (NCAAB, NHL, WNBA,
// KBO) have no bespoke chip set of their own today - they all fall back to
// DEFAULT_CHIP_SET via chipSetForLeague. DEFAULT_CHIP_SET itself is also
// shared by every OTHER sport this app recognizes but wasn't asked to get
// this tile (CFL, MLS, UFC/MMA, ATP - see parse-catalog.ts's KNOWN_SPORTS),
// so adding TEAM_TOTAL there directly would hand it to those too. Each of
// the four gets its own one-line set (DEFAULT_CHIP_SET plus TEAM_TOTAL)
// instead, registered below - same "a map entry, not a new branch"
// reasoning CHIP_SET_BY_SPORT's own comment already gives. NBA used to be
// in this group too (DEFAULT_CHIP_SET + TEAM_TOTAL, nothing sport-specific)
// until it got its own first-half score source - see NBA_CHIP_SET above.
const NCAAB_CHIP_SET: PickCategoryKey[] = [...DEFAULT_CHIP_SET, "TEAM_TOTAL"];
const NHL_CHIP_SET: PickCategoryKey[] = [...DEFAULT_CHIP_SET, "TEAM_TOTAL"];
const WNBA_CHIP_SET: PickCategoryKey[] = [...DEFAULT_CHIP_SET, "TEAM_TOTAL"];
const KBO_CHIP_SET: PickCategoryKey[] = [...DEFAULT_CHIP_SET, "TEAM_TOTAL"];

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
// 1st Half ML, or NRFI) without it being filtered out by a sport-specific
// list like MLB_CHIP_SET, which deliberately does NOT include FIRST_HALF_ML
// (or NFL_CHIP_SET's FIRST_HALF_OVER/FIRST_HALF_UNDER/TD_PROP).
export const ALL_CATEGORY_KEYS: PickCategoryKey[] = [
  ...MLB_CHIP_SET,
  "FIRST_HALF_ML",
  "FIRST_HALF_OVER",
  "FIRST_HALF_UNDER",
  "TD_PROP",
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
    const side = favoriteOrUnderdog(pick);
    return side === "FAVORITE" ? "FAV_ML" : side === "UNDERDOG" ? "DOG_ML" : null;
  }

  if (pick.betType === "SPREAD") {
    const side = spreadSide(pick);
    if (pick.period === "FIRST_HALF") {
      // Same MLB-only carve-out as F5_ML above - non-MLB first-half spread
      // picks have no category key of their own yet, same as before.
      if (pick.sportName.toUpperCase() !== "MLB") return null;
      return side === "FAVORITE" ? "F5_SPREAD_MINUS" : side === "UNDERDOG" ? "F5_SPREAD_PLUS" : null;
    }
    return side === "FAVORITE" ? "SPREAD_MINUS" : side === "UNDERDOG" ? "SPREAD_PLUS" : null;
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
  OVER: "Overs specialist",
  UNDER: "Unders specialist",
  F5_ML: "First-half specialist",
  FIRST_HALF_ML: "First-half specialist",
  FIRST_HALF_OVER: "First-half overs specialist",
  FIRST_HALF_UNDER: "First-half unders specialist",
  TD_PROP: "Touchdown-prop specialist",
  NRFI: "NRFI specialist",
  YRFI: "YRFI specialist",
  F5_SPREAD_MINUS: "F5 favorite spread specialist",
  F5_SPREAD_PLUS: "F5 underdog spread specialist",
  F5_OVER: "F5 overs specialist",
  F5_UNDER: "F5 unders specialist",
  TEAM_TOTAL: "Team-total specialist",
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

export type CategoryBreakdownItem = {
  key: PickCategoryKey;
  label: string;
  wins: number;
  losses: number;
  pushes: number;
  winPct: number;
  count: number; // decided picks: wins + losses + pushes
};

// All-time record split by pickCategory (the same favorite/underdog,
// over/under classifier the Cappers-page filter chips use) - answers "am I
// better off following favorites or dogs, overs or unders" at a glance.
// Same shape as computeScorecard, just a different grouping key. `order`
// controls which categories appear and in what sequence - callers covering
// multiple sports at once (the Dashboard) must pass DEFAULT_CHIP_SET, since
// F5 ML and NRFI only mean anything for MLB; a single-sport view can pass
// chipSetForLeague(sportName) to get those back.
export function computeCategoryBreakdown(
  picks: (Pick & { sport: { name: string } })[],
  order: PickCategoryKey[]
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
    const stats = computeStats(byCategory.get(key)!);
    const count = stats.wins + stats.losses + stats.pushes;
    return {
      key,
      label: PICK_CATEGORY_LABELS[key],
      wins: stats.wins,
      losses: stats.losses,
      pushes: stats.pushes,
      winPct: stats.winPct,
      count,
    };
  });
}

/** All picks for a user, scoped by userId — never call prisma.pick directly. */
export async function getUserPicks(userId: string) {
  return prisma.pick.findMany({
    where: { userId },
    include: { capper: true, sport: true, league: true },
    orderBy: { gameTime: "desc" },
  });
}

/** Dashboard summary: overall stats, category breakdown, recent picks. */
export async function getDashboardSummary(userId: string) {
  const picks = await getUserPicks(userId);
  const overall = computeStats(picks);

  return {
    overall,
    totalPicks: picks.length,
    // DEFAULT_CHIP_SET, not chipSetForLeague - this mixes every sport
    // together, and F5 ML/NRFI only mean anything within MLB (see
    // getSportCategoryPanelData in server/data/cappers.ts for the per-sport
    // equivalent, which also powers that panel's per-category leaderboards).
    categoryBreakdown: computeCategoryBreakdown(picks, DEFAULT_CHIP_SET),
    pendingCount: picks.filter((p) => p.status === "PENDING").length,
    recentPicks: picks.slice(0, 10),
  };
}

export type ReportBreakdownItem = { name: string; stats: OverallStats; count: number };

export async function getReportsData(userId: string) {
  const picks = await getUserPicksWithRelations(userId);
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
    name: p.period === "FIRST_HALF" ? "First half / F5" : "Full game",
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

async function getUserPicksWithRelations(userId: string) {
  return prisma.pick.findMany({
    where: { userId },
    include: { capper: true, sport: true, league: true },
  });
}

export type UnitsChartPoint = { date: string; cumulativeUnits: number };

export function computeUnitsChartData(picks: Pick[]): UnitsChartPoint[] {
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
    return {
      date: formatEastern(pick.gameTime, { month: "short", day: "numeric" }),
      cumulativeUnits: Math.round(running * 100) / 100,
    };
  });
}
