// Every threshold the /admin ops console judges by, in one place: what a tab's
// page flags and what turns its red dot on. Each tab's PR adds its section.

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
