// Dashboard PR: page-level parity of the one-statement summary (computeDashboardSummary)
// vs the frozen legacy JS path (computeDashboardSummaryLegacy), on a restored (anonymized)
// production snapshot. Read-only. Point DATABASE_URL at a disposable local DB holding the
// snapshot (README.md "Getting a real snapshot"), with categories stamped first:
//   DATABASE_URL=... npx tsx scripts/backfill-pick-category.ts --apply
// so this proves SQL == JS given identical stamps (G1's --verify is what proves the stamps).
//
// Every user with picks, at several pinned `now` instants inside the data range (the
// snapshot predates today, so only the stale-PENDING cutoff depends on `now`): the latest
// gameTime, -1d, -7d, -30d, -60d. Zero diffs required (=== with -0 == +0); exit 1 otherwise.
//   node --import tsx scripts/t2-harness/dashboard-parity.ts [--user-id=<cuid>]
import { prisma } from "@/lib/prisma";
import { computeDashboardSummary } from "@/server/data/dashboard-summary";
import { computeDashboardSummaryLegacy, firstDiff, loadLegacyDashboardPicks, narrowLegacySummary } from "@/server/data/dashboard-summary-legacy";
import { assertNotProd } from "./lib/prod-guard.mjs";

assertNotProd(process.env.DATABASE_URL ?? "", "DATABASE_URL (dashboard-parity.ts)");

const DAY = 86400000;

async function main() {
  const only = process.argv.find((a) => a.startsWith("--user-id="))?.slice("--user-id=".length);
  const users = await prisma.$queryRaw<{ userId: string; picks: number; maxGame: Date }[]>`
    SELECT "userId", count(*)::int AS picks, max("gameTime") AS "maxGame" FROM picks GROUP BY "userId" ORDER BY picks DESC`;
  const unstamped = await prisma.pick.count({ where: { categoryVersion: 0 } });
  console.log(`unstamped picks (categoryVersion 0): ${unstamped}${unstamped > 0 ? "  <-- stamp first (backfill-pick-category --apply); tiles will differ" : ""}`);
  let cases = 0;
  let failed = 0;
  for (const [i, u] of users.filter((x) => !only || x.userId === only).entries()) {
    const rows = await loadLegacyDashboardPicks(u.userId);
    for (const off of [0, 1, 7, 30, 60]) {
      const now = new Date(u.maxGame.getTime() - off * DAY);
      const legacy = narrowLegacySummary(computeDashboardSummaryLegacy(rows, now));
      const next = await computeDashboardSummary(u.userId, now);
      const d = firstDiff(next, legacy);
      cases++;
      if (d) failed++;
      if (d || off === 0) {
        console.log(
          `${d ? "FAIL" : "PASS"}  user #${i + 1}${i === 0 ? " (heaviest)" : ""} picks=${u.picks} chartPoints=${legacy.chartData.length} tiles=${legacy.categoryBreakdown.length} now=max-${off}d${d ? "  " + d : ""}`
        );
      }
    }
  }
  console.log(`\n${cases} case(s), ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}
main();
