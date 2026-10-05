// Shared (client-safe) contract of the /cappers panels: keys, windows, row shapes. The SQL lives in
// server/data/cappers-page-aggregates.ts; the dropdown route is app/api/cappers/panel/route.ts.
import type { ActivityEntry } from "@/server/data/cappers";

// Biggest Winners: net units over the panel window (the old "Hottest this week").
// wins / losses are the same window's record.
export type WinnerEntry = { capperId: string; name: string; colorTag: string | null; netUnits: number; wins: number; losses: number };

// Most Active: totalPicks is the window's picks across the whole roster (the same on every row).
export type ActiveEntry = ActivityEntry & { totalPicks: number };

// Hottest / Coldest: a capper's CURRENT consecutive win / loss streak. `units` is only present on
// Coldest (net units lost across the streak, negative, odds-0 picks left out).
export type StreakEntry = { capperId: string; name: string; colorTag: string | null; streak: number; units?: number };

export type PanelKey = "active" | "hottest" | "winners" | "coldest";
export const PANEL_KEYS: readonly PanelKey[] = ["active", "hottest", "winners", "coldest"];
export type PanelWindow = "today" | "week" | "30d";
export const PANEL_WINDOWS: readonly PanelWindow[] = ["today", "week", "30d"];
export const DEFAULT_PANEL_WINDOW: PanelWindow = "week";
export const PANEL_WINDOW_LABELS: Record<PanelWindow, string> = { today: "Today", week: "This week", "30d": "Last 30 days" };

// A streak panel needs at least this long a run to appear.
export const STREAK_PANEL_MIN = 3;
// The streak lookup reads at most this many of a capper's newest WIN/LOSS picks (index-ordered), so
// no capper's full history is ever scanned. A run longer than this reads as this long.
export const STREAK_LOOKBACK = 100;

export type PanelRows = ActiveEntry[] | WinnerEntry[] | StreakEntry[];

// Rising Fast / Falling off / Most Consistent are windowless: they read each capper's newest decided (WIN / LOSS)
// picks by count, never the time tabs or the dropdown, so they are not PanelKeys (no /api/cappers/panel).
// Decided picks are examined newest first in the canonical ORDER_DESC, at most FORM_LOOKBACK per capper.
export const FORM_LOOKBACK = 100;
// Rising Fast: recent = newest RISING_RECENT; baseline = the picks BEFORE those (never the combined set),
// needing at least RISING_MIN_BASELINE of them. Score = recent win% - baseline win%, positive only.
// Falling off is its mirror: the same read and score, negative only, most negative first.
// Either way the score must round to at least FORM_TREND_MIN_PTS points, so a "+0" / "−0" never shows.
export const RISING_RECENT = 10;
export const RISING_MIN_BASELINE = 30;
export const FORM_TREND_MIN_PTS = 1;
// Most Consistent: the newest CONSISTENT_PICKS decided picks (all required) in CONSISTENT_BLOCKS
// sequential blocks; the mean block win% must be at least CONSISTENT_MIN_MEAN_PCT.
export const CONSISTENT_PICKS = 50;
export const CONSISTENT_BLOCKS = 5;
export const CONSISTENT_MIN_MEAN_PCT = 50;
export const FORM_PANEL_COUNT = 5;

export type FormPanelKey = "rising" | "falling" | "consistent";

// A Rising Fast or Falling off row (`pts` is negative on Falling off).
// `pts`: the score in whole percentage points (recent win% - baseline win%). `results`: the newest
// RISING_RECENT decided picks, oldest first, true = win. `baseline`: the baseline win rate as a
// fraction (0-1), the same one `pts` is measured against.
export type RisingEntry = { capperId: string; name: string; colorTag: string | null; pts: number; results: boolean[]; baseline: number };

// "+12 pts" / "−12 pts".
export const ptsLabel = (pts: number) => (pts < 0 ? "−" : "+") + Math.abs(pts) + " pts";

// The chart line of Rising Fast ("wins above their norm") and Falling off ("wins below their norm"): 0 before the first of the recent picks, then after
// each pick the running sum of (result - baseline) in points, where a win is 1 and a loss is 0. One pick
// is worth 100 / RISING_RECENT points, so the last value is recent win% - baseline win%: the score.
export function risingSeries(results: boolean[], baseline: number): number[] {
  const perPick = 100 / RISING_RECENT;
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
