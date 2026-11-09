// Daily pg_stat_statements snapshot (cron db-stats-snapshot): which statements are
// tracked, the delta between two snapshots (including a stats reset in between),
// the trend view and report, and the wiring (cron auth, migration, page), checked at
// source level. Pure, no DB. Run with:
//   npx tsx src/lib/query-stat-snapshots-acceptance-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TRACKED_LABELS,
  RECENT_SWINGS_LINES_LABEL,
  RECENT_SWINGS_SCORES_LABEL,
  trackedLabelFor,
  planSnapshot,
  buildTrends,
  formatTrendReport,
  type Baseline,
  type CurrentStat,
  type DailyRow,
} from "@/lib/query-stat-snapshots";
import { STATEMENT_FIXTURES } from "@/lib/db-monitor-fixtures";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}
const root = join(__dirname, "..", "..");
const src = (p: string) => readFileSync(join(root, p), "utf8");

// ---- 1. Which statements are tracked ----
{
  const wanted = [
    "Board window",
    "Capper names (import / find-or-create)",
    "Capper roster",
    "Heavy Consensus rate (per user)",
    "Heavy Consensus stored ids",
    "Heavy Consensus history (nightly / backfill)",
  ];
  expect("tracked list = the named queries + the two recent-swings reads", TRACKED_LABELS, [...wanted, RECENT_SWINGS_SCORES_LABEL, RECENT_SWINGS_LINES_LABEL]);
  // Every real captured statement of a tracked monitor label is tracked; nothing else is.
  for (const fx of STATEMENT_FIXTURES) {
    const expected = fx.expectLabel && wanted.includes(fx.expectLabel) ? fx.expectLabel : null;
    expect(`fixture ${fx.name}: tracked as ${expected}`, trackedLabelFor(fx.sql), expected);
  }
  for (const label of wanted) expect(`a captured fixture exists for "${label}"`, STATEMENT_FIXTURES.some((f) => f.expectLabel === label), true);

  // The recent-swings SQL, taken from the source with each ${...} turned into $1.
  const swings = src("src/server/data/recent-swings.ts");
  const sql = (fn: string) => {
    const start = swings.indexOf(fn);
    const open = swings.indexOf("Prisma.sql`", start) + "Prisma.sql`".length;
    return swings.slice(open, swings.indexOf("`);", open)).replace(/\$\{[^}]*\}/g, "$1");
  };
  expect("readScores statement is tracked as recent swings (scores)", trackedLabelFor(sql("async function readScores")), RECENT_SWINGS_SCORES_LABEL);
  expect("readStoredLines statement is tracked as recent swings (stored lines)", trackedLabelFor(sql("export async function readStoredLines")), RECENT_SWINGS_LINES_LABEL);
  expect("an unrelated statement is not tracked", trackedLabelFor('SELECT "users"."id" FROM "users" WHERE "users"."supabaseId" = $1'), null);
}

// ---- 2. The delta ----
{
  const BOARD = "Board window";
  const ROSTER = "Capper roster";
  // Texts are only consulted for queryids with no baseline; this classifier stands in for the SQL text.
  const classify = (q: string) => (q === "board" ? BOARD : q === "roster" ? ROSTER : null);
  const cur = (queryid: string, calls: number, rows: number, query: string | null = null): CurrentStat => ({ queryid, calls, rows, query });
  const base = (queryid: string, label: string | null, calls: number, rows: number): Baseline => ({ queryid, label, calls, rows });
  const dailyOf = (p: ReturnType<typeof planSnapshot>, label: string) => p.daily.find((d) => d.label === label);

  const first = planSnapshot([cur("1", 100, 5000, "board"), cur("2", 7, 7, "other")], [], classify);
  expect("first run: baselines only, no daily rows", [first.firstRun, first.daily, first.baselines.map((b) => [b.queryid, b.label, b.calls, b.rows])], [true, [], [["1", BOARD, 100, 5000], ["2", null, 7, 7]]]);

  const second = planSnapshot([cur("1", 160, 8000), cur("2", 9, 9), cur("3", 10, 100, "roster")], [base("1", BOARD, 100, 5000), base("2", null, 7, 7)], classify);
  expect("second run: delta = current - baseline per label", [dailyOf(second, BOARD)?.calls, dailyOf(second, BOARD)?.rows, dailyOf(second, BOARD)?.avgRows, dailyOf(second, BOARD)?.statsReset], [60, 3000, 50, false]);
  expect("a queryid new since last run counts in full", [dailyOf(second, ROSTER)?.calls, dailyOf(second, ROSTER)?.rows], [10, 100]);
  expect("untracked statements add nothing", second.daily.reduce((n, d) => n + d.calls, 0), 70);
  expect("every tracked label gets a row (zeros included)", second.daily.map((d) => d.label), TRACKED_LABELS);
  expect("a tracked label with no calls has avg 0, not NaN", dailyOf(second, "Heavy Consensus stored ids")?.avgRows, 0);

  const reset = planSnapshot([cur("1", 4, 40)], [base("1", BOARD, 160, 8000), base("9", ROSTER, 5, 5)], classify);
  expect("counter below baseline: no negative delta; post-reset counters count, day marked statsReset", [dailyOf(reset, BOARD)?.calls, dailyOf(reset, BOARD)?.rows, dailyOf(reset, BOARD)?.statsReset], [4, 40, true]);
  expect("a baseline whose statement vanished is stale", reset.staleQueryids, ["9"]);
  expect("the new baseline is the current counter (next run subtracts from it)", reset.baselines, [{ queryid: "1", label: BOARD, calls: 4, rows: 40 }]);
  const afterReset = planSnapshot([cur("1", 10, 100)], reset.baselines.map((b) => base(b.queryid, b.label, b.calls, b.rows)), classify);
  expect("the run after a reset is a normal delta", [dailyOf(afterReset, BOARD)?.calls, dailyOf(afterReset, BOARD)?.rows, dailyOf(afterReset, BOARD)?.statsReset], [6, 60, false]);

  const rowsOnly = planSnapshot([cur("1", 200, 10)], [base("1", BOARD, 100, 5000)], classify);
  expect("rows counter going down alone is also a reset", dailyOf(rowsOnly, BOARD)?.statsReset, true);

  const merged = planSnapshot([cur("1", 110, 1100), cur("4", 5, 50)], [base("1", BOARD, 100, 1000), base("4", BOARD, 0, 0)], classify);
  expect("several queryids of one label (IN-list lengths) sum into one row", [dailyOf(merged, BOARD)?.calls, dailyOf(merged, BOARD)?.rows], [15, 150]);
}

// ---- 3. Trend view and report ----
{
  const row = (date: string, label: string, calls: number, rows: number, statsReset = false): DailyRow => ({ date, label, calls, rows, avgRows: calls ? rows / calls : 0, statsReset });
  const trends = buildTrends([row("2026-11-11", "Board window", 10, 900), row("2026-11-10", "Board window", 10, 100), row("2026-11-11", "Capper roster", 2, 40, true)]);
  const board = trends.find((t) => t.label === "Board window")!;
  expect("days are oldest first", board.days.map((d) => d.date), ["2026-11-10", "2026-11-11"]);
  expect("totals, avg and peak", [board.totalCalls, board.totalRows, board.avgRows, board.peak?.date], [20, 1000, 50, "2026-11-11"]);
  expect("every tracked label appears, even with no days", trends.map((t) => t.label), TRACKED_LABELS);
  const report = formatTrendReport(trends);
  expect("report names the peak day and marks a reset day", [report.includes("peak day 2026-11-11: 900 rows"), report.includes("(reset)")], [true, true]);
  expect("empty report says so", formatTrendReport(buildTrends([])).includes("No snapshots recorded yet."), true);
}

// ---- 4. Wiring ----
{
  const route = src("src/app/api/cron/db-stats-snapshot/route.ts");
  expect("cron checks CRON_SECRET before logging/running", route.indexOf("isAuthorizedCronRequest(") > -1 && route.indexOf("isAuthorizedCronRequest(") < route.indexOf("runCronLogged("), true);
  const data = src("src/server/data/query-stat-snapshots.ts");
  expect("the snapshot read is one statement against pg_stat_statements, text only for queryids without a baseline", [data.includes("extensions.pg_stat_statements"), data.includes("CASE WHEN b.queryid IS NULL THEN s.query END")], [true, true]);
  expect("deletes touch only the snapshot tables", (data.match(/DELETE FROM (\w+)/g) ?? []).sort(), ["DELETE FROM query_stat_baselines", "DELETE FROM query_stat_daily"]);
  const mig = src("prisma/migrations/20261110120000_add_query_stat_snapshots/migration.sql");
  expect("migration is additive and enables RLS on both tables", [!/\bDROP\b/i.test(mig), (mig.match(/ENABLE ROW LEVEL SECURITY/g) ?? []).length], [true, 2]);
  const page = src("src/app/(app)/admin/db-monitor/page.tsx");
  expect("page shows the trend and adds it to Copy for Claude", [page.includes("<QueryTrendPanel"), page.includes("formatTrendReport(trends)")], [true, true]);
  expect("tracked queries' source files do not import the snapshot module (purely additive)", ["src/server/data/picks.ts", "src/server/data/recent-swings.ts"].some((f) => src(f).includes("query-stat-snapshots")), false);
}

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nQuery-stat snapshot checks passed.");
