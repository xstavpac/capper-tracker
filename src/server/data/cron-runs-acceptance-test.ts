// runCronLogged and the cron_runs reads against a real database: a run is
// inserted RUNNING and updated when it ends (status, HTTP status, rows,
// summary), a throw is logged as ERROR and still thrown, and the two read
// statements parse and return the newest rows. Rows are written under a test
// name that no real cron uses and deleted by id afterwards.
//
// DB-backed (runs when DATABASE_URL is set). Run with:
//   npx tsx src/server/data/cron-runs-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import { runCronLogged, loadLatestCronRuns, loadRecentCronRuns } from "@/server/data/cron-runs";
import type { CronName } from "@/lib/cron-runs";
import { loadAdminStatus } from "@/server/data/admin-status";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const TEST_NAME = "__cron-runs-test__" as CronName;

async function main() {
  const since = new Date(Date.now() - 1000);
  try {
    let statusWhileRunning: string | null = null;
    const res = await runCronLogged(TEST_NAME, async () => {
      const row = await prisma.cronRun.findFirst({ where: { name: TEST_NAME, startedAt: { gte: since } }, orderBy: { startedAt: "desc" } });
      statusWhileRunning = row?.status ?? null;
      return Response.json({ ok: false, status: "warning", results: [] }, { status: 200 });
    });
    expect("the route's response comes back untouched", [res.status, (await res.json()).status], [200, "warning"]);
    expect("a RUNNING row exists while the run is going", statusWhileRunning, "RUNNING");

    let rethrown = false;
    try {
      await runCronLogged(TEST_NAME, async () => {
        throw new Error("boom: upstream exploded");
      });
    } catch (err) {
      rethrown = err instanceof Error && err.message === "boom: upstream exploded";
    }
    expect("a throw is rethrown", rethrown, true);

    const rows = await prisma.cronRun.findMany({ where: { name: TEST_NAME, startedAt: { gte: since } }, orderBy: { startedAt: "asc" } });
    expect("two runs logged", rows.length, 2);
    expect(
      "first: ended, ok:false body -> WARNING, HTTP 200, duration set",
      [rows[0]?.status, rows[0]?.httpStatus, rows[0]?.endedAt !== null, (rows[0]?.durationMs ?? -1) >= 0],
      ["WARNING", 200, true, true]
    );
    expect("second: ERROR with the message, no HTTP status", [rows[1]?.status, rows[1]?.error, rows[1]?.httpStatus], ["ERROR", "boom: upstream exploded", null]);

    const latest = (await loadLatestCronRuns()).filter((r) => r.name === TEST_NAME);
    expect("latest-per-cron read: one row for the test name, the newest (ERROR)", latest.map((r) => r.status), ["ERROR"]);
    expect("... with Date timestamps", latest[0]?.startedAt instanceof Date, true);
    const recent = (await loadRecentCronRuns(10, 1)).filter((r) => r.name === TEST_NAME);
    expect("recent read: both, newest first", recent.map((r) => r.status), ["ERROR", "WARNING"]);

    // The layout's combined status statement runs (uncached here) and the
    // crons check doesn't fail on it.
    const alerts = await loadAdminStatus();
    expect("combined status statement: the crons check didn't throw", (alerts.crons ?? "").startsWith("Status check failed"), false);
  } finally {
    const ids = (await prisma.cronRun.findMany({ where: { name: TEST_NAME }, select: { id: true } })).map((r) => r.id);
    if (ids.length) await prisma.cronRun.deleteMany({ where: { id: { in: ids } } });
    console.log(`cleanup: deleted ${ids.length} test cron_runs rows by id`);
  }

  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nCron run logging checks passed.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
