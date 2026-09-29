// Egress PR "shared building blocks", Q10 gate: bit-exact parity of the dashboard's SQL
// running-sum + downsample vs computeCumulativeUnitsSeries + downsampleUnitsChart, on a
// restored (anonymized) production snapshot. Read-only. Point DATABASE_URL at a
// disposable local DB that holds the snapshot (see README.md, "Getting a real snapshot";
// restore the .snapshots/*.dump with pg_restore - never commit it).
//
// Runs the heaviest user, every other user with settled picks, and each capper of the
// heaviest user. Exit code 1 on any displayed-value diff.
//   DATABASE_URL=postgresql://postgres@localhost:5432/<snapshot db> \
//     node --import tsx scripts/t2-harness/units-series-parity.ts [--user-id=<cuid>]
import { prisma } from "@/lib/prisma";
import { compareUnitsSeriesParity } from "@/server/data/units-series-parity";
import { assertNotProd } from "./lib/prod-guard.mjs";

assertNotProd(process.env.DATABASE_URL ?? "", "DATABASE_URL (units-series-parity.ts)");

async function main() {
  const only = process.argv.find((a) => a.startsWith("--user-id="))?.slice("--user-id=".length);
  const users = await prisma.$queryRaw<{ userId: string; picks: number; settled: number }[]>`
    SELECT "userId", count(*)::int AS picks, (count(*) FILTER (WHERE status IN ('WIN','LOSS','PUSH')))::int AS settled
    FROM picks GROUP BY "userId" ORDER BY settled DESC`;
  const targets = users.filter((u) => u.settled > 0 && (!only || u.userId === only));
  let failed = 0;
  let cases = 0;
  const run = async (label: string, scope: { userId: string; capperId?: string }) => {
    const r = await compareUnitsSeriesParity(scope);
    cases++;
    const ok = r.displayDiffs.length === 0;
    if (!ok) failed++;
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${label}  settled=${r.n} jsPoints=${r.jsPoints} sqlRows=${r.sqlRows} downsampledInSql=${r.downsampledInSql} rawRunDiffs(non-gating)=${r.rawRunDiffs}`
    );
    for (const d of r.displayDiffs) console.log(`      ${d}`);
  };
  for (const [i, u] of targets.entries()) await run(`user #${i + 1}${i === 0 ? " (heaviest)" : ""}`, { userId: u.userId });
  const heaviest = targets[0];
  if (heaviest) {
    const cappers = await prisma.$queryRaw<{ capperId: string }[]>`
      SELECT "capperId" FROM picks WHERE "userId" = ${heaviest.userId} GROUP BY "capperId" ORDER BY count(*) DESC`;
    for (const [i, c] of cappers.entries()) await run(`heaviest user, capper #${i + 1}`, { userId: heaviest.userId, capperId: c.capperId });
  }
  console.log(`\n${cases} case(s), ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}
main();
