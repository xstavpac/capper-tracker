// Every threshold the /admin ops console judges by, in one place: what a tab's
// page flags and what turns its red dot on. Each tab's PR adds its section.
// The exact red-dot rule per tab is in docs/design/ops-console.md.

// ---------------------------------------------------------------------------
// Red dots
// ---------------------------------------------------------------------------

// How long the layout's red-dot summary (getAdminStatus) is cached. The tab
// pages themselves always read fresh.
export const ADMIN_STATUS_CACHE_SECONDS = 180;

// ---------------------------------------------------------------------------
// DB Monitor
// ---------------------------------------------------------------------------

// Average rows per call above which a statement is flagged (overridable per
// page load with ?threshold=).
export const DB_ROW_THRESHOLD_DEFAULT = 500;

// Daily refresh-scores reads that pull a sport's full history on purpose
// (odds snapshots for tendencies, game observations, persisted decay-delta
// ids). Under this average they are shown as expected, not flagged; over it
// they flag like anything else. Remove once those reads are bounded.
export const EXPECTED_HEAVY_MAX_AVG_ROWS = 5000;
export const EXPECTED_HEAVY_NOTE = "expected (daily cron, full history)";

// ---------------------------------------------------------------------------
// Crons
// ---------------------------------------------------------------------------

// How late a cron may start before it counts as overdue: its schedule's
// latest fire time must be this many minutes past with no run started.
export const CRON_GRACE_MINUTES = {
  "grade-picks": 20, // every 15 min
  "backfill-odds": 30, // every 4h
  "refresh-scores": 60, // daily
  "refresh-odds": 60,
  "nhl-goal-scorer-odds": 60,
  "refresh-rosters": 60,
} as const;

// A run still RUNNING this long past its route's maxDuration was killed.
export const CRON_TIMEOUT_GRACE_SECONDS = 60;

// ---------------------------------------------------------------------------
// Odds API
// ---------------------------------------------------------------------------

// Red when the latest call's account-wide credits are at least this used...
// Same number as CREDIT_ALERT_THRESHOLD in server/data/odds-api-usage.ts (the
// "[odds-api-usage] credits ALERT" log line); odds-api-status-acceptance-test
// pins the two together.
export const ODDS_CREDITS_ALERT_PCT = 0.85;
// ...or fewer than this many are left. Same env var and default as the
// "[odds-api] credits LOW" watermark in odds.ts.
export const ODDS_CREDITS_LOW_REMAINING = Number(process.env.ODDS_API_CREDITS_LOW_WATERMARK) || 1000;

// An in-season sport with no odds snapshot for today's ET date this long
// after today's refresh-odds run (05:05 UTC) is stale.
export const ODDS_SNAPSHOT_SEED_GRACE_HOURS = 2;

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

// "Stuck pending": a PENDING pick in a sport the cron grades, inside the
// regrade lookback, whose matched game went final this long ago...
export const GRADING_STUCK_AFTER_FINAL_HOURS = 3;
// ...or, with no final found for it at all, whose game started this long ago
// (long enough for any game to have finished and its score to have landed).
export const GRADING_STUCK_NO_RESULT_HOURS = 8;
// The fuzzy-graded count's window.
export const GRADING_FUZZY_WINDOW_DAYS = 14;
// How many stuck picks the page (and its report) lists.
export const GRADING_STUCK_LIST_LIMIT = 50;

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

// The window the Imports tab and its dot look at.
export const IMPORT_WINDOW_HOURS = 24;
// Skipped-line stages that turn the dot on (no matched game, or a line the
// parser / recovery pass couldn't read). Any one in the window is enough,
// as is any pick inserted with no matched game (import_runs.fallbackUnmatched).
export const IMPORT_ALERT_STAGES = ["GAME_UNMATCHED", "PARSE_UNRESOLVED", "RECOVERY_UNRESOLVED"] as const;
// Listed on the page, never a dot.
export const IMPORT_LISTED_STAGES = ["PARSE_SILENT", "PROP_UNSUPPORTED"] as const;
// How many lines / fallback picks / ambiguity rows the page lists.
export const IMPORT_LIST_LIMIT = 30;
