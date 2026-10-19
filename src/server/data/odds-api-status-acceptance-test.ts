// Odds API tab reads and the usage log's new columns against a real database:
// persistOddsApiUsage stores httpStatus and caller; the page's one statement
// parses and returns that row as the latest, counted under today's sport x
// caller x status; the combined status statement's odds check runs. The one
// usage row written here is deleted by id (it would otherwise be the "latest
// credits" row the NFL-prop credit gate reads).
//
// DB-backed (runs when DATABASE_URL is set). Run with:
//   npx tsx src/server/data/odds-api-status-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import { persistOddsApiUsage } from "@/server/data/odds-api-usage";
import { loadOddsApiView, ODDS_SPORT_KEYS } from "@/server/data/odds-api-status";
import { loadAdminStatus } from "@/server/data/admin-status";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const TEST_SPORT = "__odds_status_test__";

async function main() {
  const pollTimestamp = new Date(Date.now() + 60_000); // newest row, so it reads back as "latest"
  try {
    await persistOddsApiUsage({
      sportKey: TEST_SPORT,
      marketsRequested: ["h2h"],
      eventsRequested: 3,
      credits: { used: 1234, remaining: 18766, lastCost: 3 },
      pollTimestamp,
      httpStatus: 401,
      caller: "odds-seed",
    });
    const stored = await prisma.oddsApiUsageLog.findFirst({ where: { sportKey: TEST_SPORT }, select: { httpStatus: true, caller: true } });
    expect("usage row stores httpStatus and caller", stored, { httpStatus: 401, caller: "odds-seed" });

    const view = await loadOddsApiView(pollTimestamp);
    expect("page statement: the test row is the latest, with a Date timestamp", [view.latest?.sportKey, view.latest?.creditsRemaining, view.latest?.pollTimestamp instanceof Date], [TEST_SPORT, 18766, true]);
    expect("page statement: counted under today's sport x caller x status", view.callsToday.filter((c) => c.sportKey === TEST_SPORT), [{ sportKey: TEST_SPORT, caller: "odds-seed", httpStatus: 401, calls: 1 }]);
    expect("page statement: month count includes it", view.callsMonth >= 1, true);
    expect("page statement: one snapshot-health entry per odds sport", view.snapshots.map((s) => s.sportKey), ODDS_SPORT_KEYS);
    expect("... createdAt parsed to Date where a row exists", view.snapshots.every((s) => s.createdAt === null || s.createdAt instanceof Date), true);

    const alerts = await loadAdminStatus();
    expect("combined status statement: the odds check didn't throw", (alerts["odds-api"] ?? "").startsWith("Status check failed"), false);
  } finally {
    const ids = (await prisma.oddsApiUsageLog.findMany({ where: { sportKey: TEST_SPORT }, select: { id: true } })).map((r) => r.id);
    if (ids.length) await prisma.oddsApiUsageLog.deleteMany({ where: { id: { in: ids } } });
    console.log(`cleanup: deleted ${ids.length} test usage rows by id`);
  }

  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nOdds API status DB checks passed.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
