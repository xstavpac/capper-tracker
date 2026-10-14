// Shared (client-safe) contract of the /cappers panels: keys, windows, row shapes. The SQL lives in
// server/data/cappers-page-aggregates.ts; the dropdown route is app/api/cappers/panel/route.ts.
import type { ActivityEntry } from "@/server/data/cappers";
import { startOfEasternDay } from "@/lib/dates";

// Biggest Winners: net units over the panel window (the old "Hottest this week").
// wins / losses / pushes are the same window's record.
export type WinnerEntry = { capperId: string; name: string; colorTag: string | null; netUnits: number; wins: number; losses: number; pushes: number };

// Biggest Winners at "Today", empty because the day has no graded pick yet.
export const TODAYS_WINNERS_NO_GRADED = "No graded picks yet today.";

// Most Active: totalPicks is the window's picks across the whole roster (the same on every row).
export type ActiveEntry = ActivityEntry & { totalPicks: number };

// Hottest / Coldest: a capper's CURRENT consecutive win / loss streak. `units` is only present on
// Coldest (net units lost across the streak, negative, odds-0 picks left out).
export type StreakEntry = { capperId: string; name: string; colorTag: string | null; streak: number; units?: number };

export type PanelKey = "active" | "hottest" | "winners" | "coldest";
export const PANEL_KEYS: readonly PanelKey[] = ["active", "hottest", "winners", "coldest"];
export type PanelWindow = "today" | "yesterday" | "week" | "30d";
export const PANEL_WINDOWS: readonly PanelWindow[] = ["today", "yesterday", "week", "30d"];
export const DEFAULT_PANEL_WINDOW: PanelWindow = "week";
export const PANEL_WINDOW_LABELS: Record<PanelWindow, string> = { today: "Today", yesterday: "Yesterday", week: "This week", "30d": "Last 30 days" };

// A panel window as an instant range [start, end). `closed`: the window ended before `now`, so the
// panels bound it above as well as below.
export type PanelRange = { start: Date; end: Date; closed?: boolean };

const DAY_MS = 86400000;
// The previous Eastern CALENDAR day: Eastern midnight to Eastern midnight (the same boundary "Today"
// starts on), never the 24 hours before `now`. The start is found by stepping back into the previous
// day and taking ITS midnight, not by subtracting 24 hours: the day a clock change falls on is 23 or
// 25 hours long.
export function yesterdayRange(now: Date): { start: Date; end: Date } {
  const end = startOfEasternDay(now);
  return { start: startOfEasternDay(new Date(end.getTime() - DAY_MS / 2)), end };
}

// "Today" is the Eastern calendar day so far, "Yesterday" the whole Eastern calendar day before it;
// the others roll back from `now`.
export function panelRange(w: PanelWindow, now: Date): PanelRange {
  if (w === "today") return { start: startOfEasternDay(now), end: now };
  if (w === "yesterday") return { ...yesterdayRange(now), closed: true };
  return { start: new Date(now.getTime() - (w === "week" ? 7 : 30) * DAY_MS), end: now };
}

// A streak panel needs at least this long a run to appear.
export const STREAK_PANEL_MIN = 3;
// The streak lookup reads at most this many of a capper's newest WIN/LOSS picks (index-ordered), so
// no capper's full history is ever scanned. A run longer than this reads as this long.
export const STREAK_LOOKBACK = 100;

export type PanelRows = ActiveEntry[] | WinnerEntry[] | StreakEntry[];

// Falling off / Most Consistent are windowless: they read each capper's newest decided (WIN / LOSS)
// picks by count, never the time tabs or the dropdown, so they are not PanelKeys (no /api/cappers/panel).
// Decided picks are examined newest first in the canonical ORDER_DESC, at most FORM_LOOKBACK per capper.
export const FORM_LOOKBACK = 100;
// Falling off: recent = newest TREND_RECENT; baseline = the picks BEFORE those (never the combined set),
// needing at least TREND_MIN_BASELINE of them. The card shows and ranks by the decline as a percentage
// of the capper's own baseline: (recent win% - baseline win%) / baseline win%, negative only, steepest
// first. The gap itself must round to at least FORM_TREND_MIN_PTS percentage points, so a capper level
// with their norm ("58% → 58%") never shows.
export const TREND_RECENT = 10;
export const TREND_MIN_BASELINE = 30;
export const FORM_TREND_MIN_PTS = 1;
// What the card says about those rules, so none of them is hidden: the windows it compares, the decided
// picks a capper needs before they can appear at all, and an empty state that only speaks for the
// cappers who qualify.
export const FALLING_MIN_DECIDED = TREND_RECENT + TREND_MIN_BASELINE;
export const FALLING_SUBLABEL = "Recent form vs prior up to " + (FORM_LOOKBACK - TREND_RECENT);
export const FALLING_REQUIREMENT = "Needs " + FALLING_MIN_DECIDED + "+ decided picks";
export const FALLING_EMPTY = "No qualifying capper is below their normal form.";
// Most Consistent: the newest CONSISTENT_PICKS decided picks (all required) in CONSISTENT_BLOCKS
// sequential blocks; the mean block win% must be at least CONSISTENT_MIN_MEAN_PCT.
export const CONSISTENT_PICKS = 50;
export const CONSISTENT_BLOCKS = 5;
export const CONSISTENT_MIN_MEAN_PCT = 50;
export const FORM_PANEL_COUNT = 5;
// Best / Worst last 20 (/dashboard): the rows a card shows, and the rows "See more" opens it to.
export const LAST20_COLLAPSED_COUNT = 5;
export const LAST20_PANEL_COUNT = 10;

export type FormPanelKey = "falling" | "consistent";

// A Falling off row (`pct` and `pts` are negative).
// `pct`: the decline as a whole percentage of the baseline, (recent win% - baseline win%) / baseline
// win%: what the card shows and ranks by. 0 wins in the recent picks is always -100. `pts`: the same
// gap in whole percentage points (recent win% - baseline win%), which only decides who is in.
// `results`: the newest TREND_RECENT decided picks, oldest first, true = win. `baseline`: the baseline
// win rate as a fraction (0-1), the one both are measured against; never 0 on a row (nobody is below 0%).
export type FallingEntry = { capperId: string; name: string; colorTag: string | null; pct: number; pts: number; results: boolean[]; baseline: number };

// "−31%" / "+12%".
export const pctLabel = (pct: number) => (pct < 0 ? "−" : "+") + Math.abs(pct) + "%";

// A win rate (a fraction) as a whole percent: "58%".
export const ratePct = (rate: number) => Math.round(rate * 100) + "%";
// The win rate of the recent picks, as a fraction.
export const recentRate = (results: boolean[]) => (results.length === 0 ? 0 : results.filter(Boolean).length / results.length);
// "58% → 40%": the capper's normal win rate, then the recent picks'.
export const rateShift = (results: boolean[], baseline: number) => ratePct(baseline) + " → " + ratePct(recentRate(results));

// The decline as a percentage of the baseline, unrounded: (recent - baseline) / baseline x 100. A
// baseline of 0 has nothing to be a percentage of (and no row has one): 0.
export function declinePct(results: boolean[], baseline: number): number {
  return baseline > 0 ? ((recentRate(results) - baseline) / baseline) * 100 : 0;
}

// Falling off's chart line ("win% against their norm"): 0 before the first of the recent picks, then
// after each pick the running sum of (result - baseline) / baseline in percent, where a win is 1 and a
// loss is 0 and each pick is 1 / TREND_RECENT of the window. So the last value is declinePct: the
// percentage on the row's label. A baseline of 0 draws flat (see declinePct).
export function trendSeries(results: boolean[], baseline: number): number[] {
  if (!(baseline > 0)) return [0, ...results.map(() => 0)];
  const perPick = 100 / TREND_RECENT / baseline;
  let sum = 0;
  return [0, ...results.map((win) => (sum += ((win ? 1 : 0) - baseline) * perPick))];
}
// `blocks`: each block's win % (0-100), oldest block first - the sparkline series. `sd`: their
// population standard deviation (the ranking key).
export type ConsistentEntry = { capperId: string; name: string; colorTag: string | null; blocks: number[]; sd: number };

// Most Consistent's confidence score (0-100, higher = steadier) and its tier.
export function consistencyScore(sd: number): number {
  return Math.min(100, Math.max(0, Math.round(100 - 2.5 * sd)));
}
export type ConsistencyTier = "Elite" | "Rock Solid" | "Steady";
// Lowest score for each tier; anything under rockSolid is Steady. Tuned (2026-10) so the five rows
// the panel shows do not all read the same: retune here.
export const CONSISTENCY_TIER_CUTOFFS = { elite: 85, rockSolid: 80 } as const;
export function consistencyTier(score: number): ConsistencyTier {
  return score >= CONSISTENCY_TIER_CUTOFFS.elite ? "Elite" : score >= CONSISTENCY_TIER_CUTOFFS.rockSolid ? "Rock Solid" : "Steady";
}
