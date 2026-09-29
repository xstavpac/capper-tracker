// Shared (client-safe) contract of the /cappers panels: keys, windows, row shapes. The SQL lives in
// server/data/cappers-page-aggregates.ts; the dropdown route is app/api/cappers/panel/route.ts.
import type { ActivityEntry } from "@/server/data/cappers";

// Biggest Winners: net units over the panel window (the old "Hottest this week").
export type WinnerEntry = { capperId: string; name: string; colorTag: string | null; netUnits: number };

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

export type PanelRows = ActivityEntry[] | WinnerEntry[] | StreakEntry[];
