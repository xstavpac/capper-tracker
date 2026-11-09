import { describeStatement, labelFor, normalizeSql, formatNumber, formatAvg } from "@/lib/db-monitor";

// Pure half of the daily pg_stat_statements snapshot (cron db-stats-snapshot).
//
// pg_stat_statements only keeps totals since the last reset, so a spike can't be
// attributed to a query after the fact. Once a day the cron subtracts the counters it
// stored last time (query_stat_baselines, per queryid) from the current ones and adds
// the difference to one row per tracked query per day (query_stat_daily).
//
// Only the TRACKED_QUERIES below are written to the daily table. Every statement the
// prefilter lets through gets a baseline row (label null when untracked) so its text
// is read from pg_stat_statements once, not every day.

// ---------------------------------------------------------------------------
// What is tracked
// ---------------------------------------------------------------------------

export type TrackedQuery = {
  label: string;
  // The code path (and file) that sends it.
  source: string;
  matches: (normalizedText: string) => boolean;
};

// An existing DB Monitor label, matched exactly as the monitor matches it.
const monitorLabel = (label: string, source: string): TrackedQuery => ({
  label,
  source,
  matches: (text) => labelFor(describeStatement(text)) === label,
});

// The recent-swings reads have no DB Monitor label (it would need a captured fixture
// per label). Their fingerprints are the opening of each statement in
// src/server/data/recent-swings.ts, as pg_stat_statements stores it (literals -> $n).
// Not yet checked against a production capture: until a prod snapshot shows a
// non-zero row for each, treat "no calls" as "not matched" rather than "not run".
export const RECENT_SWINGS_SCORES_LABEL = "Recent swings (scores)";
export const RECENT_SWINGS_LINES_LABEL = "Recent swings (stored lines)";

export const TRACKED_QUERIES: TrackedQuery[] = [
  monitorLabel("Board window", "boardPicksInWindow (picks.ts; /live board, game detail)"),
  monitorLabel("Capper names (import / find-or-create)", "pick-dedup.ts capper-names read; findOrCreateCapper scan"),
  monitorLabel("Capper roster", "getCapperRoster (capper-roster.ts)"),
  monitorLabel("Heavy Consensus rate (per user)", "getHeavyConsensusRate (heavy-consensus.ts)"),
  monitorLabel("Heavy Consensus stored ids", "recomputeHeavyConsensusMarkets (heavy-consensus.ts)"),
  monitorLabel("Heavy Consensus history (nightly / backfill)", "loadHeavyConsensusInstances (heavy-consensus.ts)"),
  {
    label: RECENT_SWINGS_SCORES_LABEL,
    source: "readScores (recent-swings.ts)",
    matches: (t) => /^WITH recent AS \( SELECT r\."externalId", r\."gameDate", r\."homeTeam"/.test(t) && /\branked AS\b/.test(t) && /FROM game_results r\b/.test(t),
  },
  {
    label: RECENT_SWINGS_LINES_LABEL,
    source: "readStoredLines (recent-swings.ts)",
    matches: (t) => /^SELECT s\."fetchDate", g\.elem->>'id' AS "eventId"/.test(t) && /FROM odds_snapshots s\b/.test(t),
  },
];

export const TRACKED_LABELS: string[] = TRACKED_QUERIES.map((q) => q.label);

// The tracked label for a statement's text, or null. First match wins.
export function trackedLabelFor(queryText: string): string | null {
  const text = normalizeSql(queryText);
  return TRACKED_QUERIES.find((q) => q.matches(text))?.label ?? null;
}

// SQL prefilter on the statement text: only statements naming one of the tables a
// tracked query reads. Keeps the counters read small; the labels above do the real match.
export const PREFILTER_PATTERN = "(picks|cappers|heavy_consensus_markets|game_results|odds_snapshots)";

// How long daily rows are kept, and how many days the admin page shows.
export const DAILY_RETENTION_DAYS = 90;
export const TREND_DAYS = 30;

// ---------------------------------------------------------------------------
// The delta
// ---------------------------------------------------------------------------

export type CurrentStat = {
  queryid: string;
  calls: number;
  rows: number;
  // Statement text, present only for a queryid that has no baseline yet.
  query: string | null;
};

export type Baseline = { queryid: string; label: string | null; calls: number; rows: number };

export type DailyDelta = { label: string; calls: number; rows: number; avgRows: number; statsReset: boolean };

export type SnapshotPlan = {
  // Every current queryid's new baseline (insert or update).
  baselines: { queryid: string; label: string | null; calls: number; rows: number }[];
  // Baselines whose queryid is gone (evicted or reset): delete.
  staleQueryids: string[];
  // One entry per tracked label; empty on the very first run (nothing to subtract).
  daily: DailyDelta[];
  firstRun: boolean;
};

// Counters this run minus counters last run, summed per tracked label.
//
//  - First run ever (no baselines at all): only baselines are written; a delta against
//    nothing would be the whole history since the last reset, not a day.
//  - A queryid with a baseline: delta = current - previous. If either counter went
//    DOWN, the stats were reset in between. The old figure can't be subtracted, so the
//    queryid is re-baselined and the counters since the reset (all post-reset
//    activity) count as the delta; the label's row is marked statsReset because that
//    day is missing whatever ran before the reset.
//  - A queryid with no baseline on a later run is new since the last snapshot (a new
//    IN-list length, a new deploy, or an entry recreated after a reset): its counters
//    are all new activity.
//  - Every tracked label gets a row each run, zeros included, so a trend has no gaps.
export function planSnapshot(current: CurrentStat[], baselines: Baseline[], classify: (queryText: string) => string | null = trackedLabelFor): SnapshotPlan {
  const prev = new Map(baselines.map((b) => [b.queryid, b]));
  const firstRun = baselines.length === 0;
  const totals = new Map<string, DailyDelta>(TRACKED_LABELS.map((label) => [label, { label, calls: 0, rows: 0, avgRows: 0, statsReset: false }]));
  const nextBaselines: SnapshotPlan["baselines"] = [];
  const seen = new Set<string>();

  for (const c of current) {
    seen.add(c.queryid);
    const b = prev.get(c.queryid);
    const label = b ? b.label : c.query !== null ? classify(c.query) : null;
    nextBaselines.push({ queryid: c.queryid, label, calls: c.calls, rows: c.rows });
    if (firstRun || label === null) continue;
    const t = totals.get(label);
    if (!t) continue;
    if (b && (c.calls < b.calls || c.rows < b.rows)) {
      t.calls += c.calls;
      t.rows += c.rows;
      t.statsReset = true;
    } else if (b) {
      t.calls += c.calls - b.calls;
      t.rows += c.rows - b.rows;
    } else {
      t.calls += c.calls;
      t.rows += c.rows;
    }
  }

  const daily = firstRun ? [] : [...totals.values()].map((t) => ({ ...t, avgRows: t.calls > 0 ? t.rows / t.calls : 0 }));
  // A baseline with no matching current statement was evicted, or wiped by a reset.
  const staleQueryids = baselines.filter((b) => !seen.has(b.queryid)).map((b) => b.queryid);
  return { baselines: nextBaselines, staleQueryids, daily, firstRun };
}

// ---------------------------------------------------------------------------
// Trend view (admin DB Monitor page + Copy for Claude)
// ---------------------------------------------------------------------------

export type DailyRow = { date: string; label: string; calls: number; rows: number; avgRows: number; statsReset: boolean };

export type QueryTrend = {
  label: string;
  // Oldest first.
  days: DailyRow[];
  totalCalls: number;
  totalRows: number;
  avgRows: number;
  // The day with the most rows, for "where was the spike".
  peak: DailyRow | null;
};

export function buildTrends(rows: DailyRow[]): QueryTrend[] {
  const by = new Map<string, DailyRow[]>(TRACKED_LABELS.map((l) => [l, []]));
  for (const r of rows) {
    if (!by.has(r.label)) by.set(r.label, []);
    by.get(r.label)!.push(r);
  }
  return [...by.entries()].map(([label, list]) => {
    const days = [...list].sort((a, b) => a.date.localeCompare(b.date));
    const totalCalls = days.reduce((n, d) => n + d.calls, 0);
    const totalRows = days.reduce((n, d) => n + d.rows, 0);
    const peak = days.reduce<DailyRow | null>((p, d) => (!p || d.rows > p.rows ? d : p), null);
    return { label, days, totalCalls, totalRows, avgRows: totalCalls > 0 ? totalRows / totalCalls : 0, peak };
  });
}

// Plain text in the DB Monitor report's style, appended to its "Copy for Claude".
export function formatTrendReport(trends: QueryTrend[]): string {
  const lines: string[] = ["", `Daily snapshots of tracked queries (last ${TREND_DAYS} days; one row per query per UTC day)`];
  if (trends.every((t) => t.days.length === 0)) {
    lines.push("No snapshots recorded yet.");
    return lines.join("\n");
  }
  lines.push("A day marked (reset) had pg_stat_statements reset during it: the figure covers only the part after the reset.");
  trends.forEach((t, i) => {
    lines.push("");
    lines.push(`${i + 1}. ${t.label} - ${formatNumber(t.totalCalls)} calls, ${formatNumber(t.totalRows)} rows, avg ${formatAvg(t.avgRows)} rows/call over ${t.days.length} days`);
    if (t.peak) lines.push(`   peak day ${t.peak.date}: ${formatNumber(t.peak.rows)} rows`);
    for (const d of t.days) {
      lines.push(`   ${d.date}  calls ${formatNumber(d.calls)}  rows ${formatNumber(d.rows)}  avg ${formatAvg(d.avgRows)}${d.statsReset ? " (reset)" : ""}`);
    }
  });
  return lines.join("\n");
}
