// Crons tab (ops console): the cron list matches vercel.json, schedules and
// "overdue", turning each route's real response into a cron_runs outcome,
// the red-dot rule, the Copy for Claude report, and the route wiring
// (runCronLogged only after the auth check), checked at source level.
//
// Pure, no DB. Run with:
//   npx tsx src/lib/cron-runs-acceptance-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CRON_JOBS,
  previousFireTime,
  describeSchedule,
  outcomeFromResponse,
  cronHealth,
  cronsAlert,
  cronsReport,
  isTimedOut,
  type CronRunRow,
  type CronName,
} from "@/lib/cron-runs";
import { formatAdminReport } from "@/lib/admin-report";
import { CRON_GRACE_MINUTES, CRON_TIMEOUT_GRACE_SECONDS } from "@/lib/admin-thresholds";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}
const root = join(__dirname, "..", "..");
const src = (p: string) => readFileSync(join(root, p), "utf8");
const job = (n: CronName) => CRON_JOBS.find((j) => j.name === n)!;
const T = (iso: string) => new Date(iso);

// ---- 1. The list is vercel.json's ----
{
  const vercel = JSON.parse(src("vercel.json")) as { crons: { path: string; schedule: string }[] };
  const fromVercel = vercel.crons.map((c) => `${c.path} ${c.schedule}`).sort();
  expect("CRON_JOBS = vercel.json crons (path + schedule)", CRON_JOBS.map((j) => `${j.path} ${j.schedule}`).sort(), fromVercel);
  expect("each job's name is its route folder", CRON_JOBS.every((j) => j.path === `/api/cron/${j.name}`), true);
  expect("every job has a grace", CRON_JOBS.every((j) => typeof CRON_GRACE_MINUTES[j.name] === "number"), true);
  for (const j of CRON_JOBS) {
    const route = src(`src/app/api/cron/${j.name}/route.ts`);
    const declared = /export const maxDuration = (\d+);/.exec(route);
    expect(`${j.name}: maxDurationSec matches the route (${declared ? declared[1] : "unset -> 300"})`, j.maxDurationSec, declared ? Number(declared[1]) : 300);
    const authAt = route.indexOf('new Response("Unauthorized", { status: 401 })');
    const wrapAt = route.indexOf(`return runCronLogged("${j.name}", run);`);
    expect(`${j.name}: logged via runCronLogged, only after the 401 check`, [authAt >= 0, wrapAt > authAt], [true, true]);
    const runBody = route.slice(route.indexOf("async function run(): Promise<Response> {"));
    expect(`${j.name}: the logged run doesn't read the request`, /\breq\b/.test(runBody), false);
  }
}

// ---- 2. Schedules ----
{
  expect("*/15 at 10:07 -> 10:00", previousFireTime("*/15 * * * *", T("2026-10-19T10:07:30Z")).toISOString(), "2026-10-19T10:00:00.000Z");
  expect("*/15 exactly at 10:15 -> 10:15", previousFireTime("*/15 * * * *", T("2026-10-19T10:15:00Z")).toISOString(), "2026-10-19T10:15:00.000Z");
  expect("0 */4 at 03:59 -> 00:00", previousFireTime("0 */4 * * *", T("2026-10-19T03:59:00Z")).toISOString(), "2026-10-19T00:00:00.000Z");
  expect("55 6 at 06:54 -> yesterday 06:55", previousFireTime("55 6 * * *", T("2026-10-19T06:54:00Z")).toISOString(), "2026-10-18T06:55:00.000Z");
  expect("55 6 at 06:55 -> today", previousFireTime("55 6 * * *", T("2026-10-19T06:55:00Z")).toISOString(), "2026-10-19T06:55:00.000Z");
  expect("describeSchedule", CRON_JOBS.map((j) => describeSchedule(j.schedule)), ["every 15 min", "daily 06:55 UTC", "daily 05:05 UTC", "every 4h at :00", "daily 16:30 UTC", "daily 10:45 UTC"]);
  let threw = false;
  try {
    previousFireTime("0 0 1 * *", new Date());
  } catch {
    threw = true;
  }
  expect("a schedule outside the supported subset throws (so a new vercel.json entry can't silently mis-parse)", threw, true);
}

// ---- 3. Response -> outcome, from each route's real body shape ----
{
  const gp = outcomeFromResponse("grade-picks", 200, {
    ok: true,
    invalidatedUsers: 2,
    results: [
      { sport: "baseball_mlb", persisted: 4, legGrading: { graded: 1, notMatched: 0, remaining: 0 }, legRegrading: { checked: 2, upgraded: 0 }, grading: { graded: 6, notMatched: 2, remaining: 0 }, regrading: { checked: 5, upgraded: 1 } },
      { sport: "icehockey_nhl", persisted: 0, legGrading: { graded: 0, notMatched: 0, remaining: 0 }, legRegrading: { checked: 0, upgraded: 0 }, grading: { graded: 0, notMatched: 1, remaining: 3 }, regrading: { checked: 0, upgraded: 0 } },
      { sport: "x", skipped: true },
    ],
  });
  expect("grade-picks: OK, rows = finals + graded + upgrades + legs", [gp.status, gp.rowsTouched], ["OK", 4 + 6 + 1 + 1]);
  expect("grade-picks: summary", gp.summary, { finalsPersisted: 4, graded: 6, notMatched: 3, remaining: 3, fuzzyUpgraded: 1, legsGraded: 1, legsUpgraded: 0 });

  const rs = outcomeFromResponse("refresh-scores", 200, {
    ok: true,
    results: [{ sport: "baseball_mlb", persisted: 3, tendencies: { teamsUpdated: 30 }, tendencySnapshots: 30 }],
    statSnapshots: { sport: "baseball_mlb", teamSnapshots: 30, pitcherSnapshots: 12, gameStarters: { probablesWritten: 8, reconciled: 2, pending: 1 } },
    nflTeamSnapshots: { rowsWritten: 28, errors: 1 },
    nflRecordSnapshots: 32,
    nflSituationalSnapshots: 192,
    decayDeltaPredictions: { graded: { newlyPersisted: 5 }, pregame: { newlyPersisted: 7 } },
    heavyConsensus: { fromDate: "2026-10-17", picksRead: 400, markets: 4, upserted: 4, deleted: 1 },
  });
  expect("refresh-scores: rows = every write count (errors not counted)", [rs.status, rs.rowsTouched], ["OK", 3 + 30 + 30 + 30 + 12 + 28 + 32 + 192 + 12 + 4 + 1]);
  expect("refresh-scores: NFL snapshot errors kept in the summary", rs.summary?.nflTeamSnapshotErrors, 1);
  expect("refresh-scores: heavy consensus writes in the summary", [rs.summary?.heavyConsensusUpserted, rs.summary?.heavyConsensusDeleted, rs.summary?.heavyConsensusFailed], [4, 1, 0]);
  const rsFailed = outcomeFromResponse("refresh-scores", 200, { ok: true, results: [], heavyConsensus: { error: "boom" } });
  expect("refresh-scores: a failed heavy consensus recompute is flagged, not counted as a write", [rsFailed.rowsTouched, rsFailed.summary?.heavyConsensusFailed], [0, 1]);

  const ro = outcomeFromResponse("refresh-odds", 500, {
    ok: false,
    status: "error",
    creditsRemaining: 0,
    results: [
      { sport: "americanfootball_nfl", status: "fetch_failed", games: 0 },
      { sport: "baseball_mlb", status: "seeded", games: 12 },
      { sport: "basketball_wnba", status: "off_season", games: 0 },
    ],
    nhlGoalScorer: { status: "seeded", eventsFetched: 3, eventsSkippedCreditGate: 0, eventsFailed: 0 },
    nflProps: { status: "seeded", eventsFetched: 2, eventsSkippedCreditGate: 0, eventsFailed: 0 },
  });
  expect("refresh-odds 500: ERROR, failed sports and credits in the summary", [ro.status, ro.summary?.failed, ro.summary?.creditsRemaining, ro.rowsTouched], ["ERROR", "americanfootball_nfl", 0, 1 + 2 + 3]);
  expect("refresh-odds warning (200, ok:false): WARNING", outcomeFromResponse("refresh-odds", 200, { ok: false, status: "warning", results: [] }).status, "WARNING");

  const bf = outcomeFromResponse("backfill-odds", 200, { ok: false, status: "warning", results: [{ sport: "baseball_mlb", added: 2, status: "added" }, { sport: "icehockey_nhl", added: 0, status: "no_base_row" }] });
  expect("backfill-odds: WARNING, games added, missing seed named", [bf.status, bf.rowsTouched, bf.summary?.missingSeed], ["WARNING", 2, "icehockey_nhl"]);

  const nhl = outcomeFromResponse("nhl-goal-scorer-odds", 200, { ok: true, status: "no_games_to_fetch", eventsFetched: 0, eventsSkippedCreditGate: 0, eventsFailed: 0 });
  expect("nhl-goal-scorer-odds: a skip is OK, its own status kept as `result`", [nhl.status, nhl.summary?.result], ["OK", "no_games_to_fetch"]);
  expect("nhl-goal-scorer-odds threw (500, status error): ERROR", outcomeFromResponse("nhl-goal-scorer-odds", 500, { ok: false, status: "error", error: "db down" }).status, "ERROR");

  const rr = outcomeFromResponse("refresh-rosters", 200, { ms: 900, leagues: [{ league: "NFL", status: "committed", rowsWritten: 6 }, { league: "MLB", status: "aborted", rowsWritten: 0, reason: "too many removals" }, { league: "NHL", status: "skipped-offseason" }] });
  expect("refresh-rosters: an aborted league is a WARNING", [rr.status, rr.rowsTouched, rr.summary?.failedOrAborted], ["WARNING", 6, "MLB"]);
  expect("refresh-rosters: all committed is OK", outcomeFromResponse("refresh-rosters", 200, { leagues: [{ league: "NFL", status: "committed", rowsWritten: 0 }] }).status, "OK");

  expect("a non-JSON body: status from HTTP alone", outcomeFromResponse("grade-picks", 502, null).status, "ERROR");
  expect("... and a 200 with an unreadable body is OK", outcomeFromResponse("refresh-rosters", 200, "oops").status, "OK");
}

// ---- 4. Health and the red dot ----
{
  const row = (name: CronName, startedAt: string, status: CronRunRow["status"], extra: Partial<CronRunRow> = {}): CronRunRow => ({
    name,
    startedAt: T(startedAt),
    endedAt: status === "RUNNING" ? null : T(startedAt),
    durationMs: status === "RUNNING" ? null : 1200,
    status,
    httpStatus: status === "RUNNING" ? null : status === "ERROR" ? 500 : 200,
    rowsTouched: 3,
    summary: null,
    error: null,
    ...extra,
  });
  const gp = job("grade-picks");
  const now = T("2026-10-19T10:50:00Z");
  expect("grade-picks ran at 10:45: healthy", cronHealth(gp, row("grade-picks", "2026-10-19T10:45:00Z", "OK"), now).problem, null);
  expect("grade-picks last ran 10:30 (due 10:30 is within grace): healthy", cronHealth(gp, row("grade-picks", "2026-10-19T10:30:00Z", "OK"), now).problem, null);
  expect(
    "grade-picks last ran 10:15 (10:30 is 20 min past): overdue",
    cronHealth(gp, row("grade-picks", "2026-10-19T10:15:00Z", "OK"), now).problem,
    "grade-picks: overdue - no run since 35m ago (due 10:30 UTC)"
  );
  expect("a 1-minute-early start counts as on time", cronHealth(gp, row("grade-picks", "2026-10-19T10:29:10Z", "OK"), now).problem, null);
  expect(
    "last run failed",
    cronHealth(gp, row("grade-picks", "2026-10-19T10:45:00Z", "ERROR", { error: "Timed out fetching scores" }), now).problem,
    "grade-picks: last run failed (HTTP 500): Timed out fetching scores"
  );
  expect("a WARNING alone is not a dot", cronHealth(gp, row("grade-picks", "2026-10-19T10:45:00Z", "WARNING"), now).problem, null);
  const fresh = row("grade-picks", "2026-10-19T10:49:30Z", "RUNNING");
  expect("RUNNING 30s: still going", [isTimedOut(gp, fresh, now), cronHealth(gp, fresh, now).problem], [false, null]);
  const stuck = row("grade-picks", "2026-10-19T10:47:30Z", "RUNNING");
  expect(`RUNNING past maxDuration + ${CRON_TIMEOUT_GRACE_SECONDS}s: timed out`, cronHealth(gp, stuck, now).problem, "grade-picks: run started 3m ago never finished (timed out or crashed)");
  expect("nothing logged yet: no dot", cronHealth(gp, null, now).problem, null);

  const rs = job("refresh-scores");
  expect("daily: yesterday's run at 07:30 the next day (grace 60m) is fine", cronHealth(rs, row("refresh-scores", "2026-10-18T06:55:02Z", "OK"), T("2026-10-19T07:30:00Z")).problem, null);
  expect("daily: ... at 08:00 it's overdue", cronHealth(rs, row("refresh-scores", "2026-10-18T06:55:02Z", "OK"), T("2026-10-19T08:00:00Z")).problem?.startsWith("refresh-scores: overdue"), true);

  const h1 = cronHealth(gp, row("grade-picks", "2026-10-19T10:15:00Z", "OK"), now);
  const h2 = cronHealth(rs, row("refresh-scores", "2026-10-19T06:55:00Z", "ERROR"), now);
  const ok = cronHealth(job("backfill-odds"), row("backfill-odds", "2026-10-19T08:00:00Z", "OK"), now);
  expect("dot: none when all healthy", cronsAlert([ok]), null);
  expect("dot: one problem, said whole", cronsAlert([ok, h1]), h1.problem);
  expect("dot: several, counted", cronsAlert([h1, ok, h2]), `2 crons need attention; ${h1.problem}`);

  const report = formatAdminReport(
    cronsReport(
      [h1, ok, cronHealth(job("refresh-rosters"), null, now)],
      [row("grade-picks", "2026-10-19T10:15:00Z", "OK"), row("grade-picks", "2026-10-19T10:00:00Z", "WARNING")],
      now
    )
  ).split("\n");
  expect("report: header", report.slice(0, 2), ["Crons report - cron_runs (one row per authorized run)", "As of 2026-10-19 10:50 UTC. 1 of 3 crons flagged (failed, timed out or overdue)."]);
  expect("report: flagged cron", report.includes("1. [FLAG] grade-picks - every 15 min - final scores + grade pending picks and legs"), true);
  expect("report: last run and recent statuses", [report.includes("   last run: 2026-10-19 10:15 UTC OK HTTP 200, 1.2s, 3 rows (35m ago)"), report.includes("   recent: OK WARNING")], [true, true]);
  expect("report: a cron with no runs", report.includes("   no runs logged yet"), true);
}

// ---- 5. Status + page wiring ----
{
  const status = src("src/server/data/admin-status.ts");
  expect("red dot: crons check reads the latest run per cron inside the one combined statement", [/tab: "crons"/.test(status), /FROM \(\$\{LATEST_CRON_RUNS_SQL\}\) c\) AS crons/.test(status)], [true, true]);
  const page = src("src/app/(app)/admin/crons/page.tsx");
  expect("crons page: gated, uncached, has Copy for Claude", [/await requireAdminOpsPage\(\)/.test(page), /cachedByTag|unstable_cache/.test(page), /<CopyReportButton report=\{report\} \/>/.test(page)], [true, false, true]);
  const tabs = src("src/lib/admin-tabs.ts");
  expect("tab row: Crons after DB Monitor", tabs.indexOf('key: "crons"') > tabs.indexOf('key: "db-monitor"'), true);
}

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nCron checks passed.");
