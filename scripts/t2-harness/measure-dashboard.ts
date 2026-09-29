// Dashboard PR: statements and payload per COLD dashboard summary, legacy vs one-statement.
// Each path runs in its own child process against a Prisma client that logs every statement
// (src/lib/prisma.ts reuses globalThis.prisma outside production, so a logging client installed
// before any app module loads is the one the app's own code uses) - so the statement count is what
// the path really issues, not an estimate.
//   DATABASE_URL=<snapshot db> node --import tsx scripts/t2-harness/measure-dashboard.ts [--user-id=<cuid>]
// Payload is measured two ways: what the app receives (JSON bytes of the Prisma result; for legacy
// the relation rows are counted once per distinct id, as Prisma sends them) and database-side row
// bytes (pg_column_size of the user's pick rows vs octet_length of the bundle jsonb). Neither includes
// TLS/protocol framing; both are the same yardstick for both paths.
import { spawnSync } from "node:child_process";
import { Prisma, PrismaClient } from "@prisma/client";
import { assertNotProd } from "./lib/prod-guard.mjs";

assertNotProd(process.env.DATABASE_URL ?? "", "DATABASE_URL (measure-dashboard.ts)");
const mode = process.env.MEASURE_MODE;

const statements: string[] = [];
const prisma = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
prisma.$on("query", (e) => statements.push(e.query));
(globalThis as unknown as { prisma?: PrismaClient }).prisma = prisma;

async function child() {
  const userId = process.env.MEASURE_USER!;
  const now = new Date();
  if (mode === "old") {
    const { loadLegacyDashboardPicks, computeDashboardSummaryLegacy } = await import("@/server/data/dashboard-summary-legacy");
    const t0 = performance.now();
    const rows = await loadLegacyDashboardPicks(userId);
    computeDashboardSummaryLegacy(rows, now);
    const ms = performance.now() - t0;
    const stmtCount = statements.length;
    const bare = rows.map(({ sport: _s, capper: _c, league: _l, ...p }) => p);
    const rel = (k: "sport" | "capper" | "league") => {
      const m = new Map<string, unknown>();
      for (const r of rows) {
        const v = r[k] as { id?: string; name: string } | null;
        if (v) m.set(v.id ?? v.name, v);
      }
      return [...m.values()];
    };
    const bytes = [bare, rel("sport"), rel("capper"), rel("league")].reduce((a, x) => a + Buffer.byteLength(JSON.stringify(x)), 0);
    const [{ b }] = await prisma.$queryRaw<{ b: number }[]>(Prisma.sql`SELECT coalesce(sum(pg_column_size(p.*)),0)::float8 AS b FROM picks p WHERE p."userId" = ${userId}`);
    console.log(`RESULT ${JSON.stringify({ stmtCount, picks: rows.length, appBytes: bytes, dbRowBytes: b, ms: Math.round(ms) })}`);
  } else {
    const { buildDashboardBundleQuery, computeDashboardSummary } = await import("@/server/data/dashboard-summary");
    const t0 = performance.now();
    await computeDashboardSummary(userId, now);
    const ms = performance.now() - t0;
    const stmtCount = statements.length;
    const rows = await prisma.$queryRaw<{ out: unknown; n: number }[]>(Prisma.sql`SELECT out, octet_length(out::text) AS n FROM (${buildDashboardBundleQuery(userId, now)}) q`);
    console.log(`RESULT ${JSON.stringify({ stmtCount, appBytes: Buffer.byteLength(JSON.stringify(rows[0].out)), dbRowBytes: Number(rows[0].n), ms: Math.round(ms) })}`);
  }
  await prisma.$disconnect();
}

async function parent() {
  const only = process.argv.find((a) => a.startsWith("--user-id="))?.slice("--user-id=".length);
  const users = await prisma.$queryRaw<{ userId: string; picks: number; settled: number }[]>`
    SELECT "userId", count(*)::int AS picks, (count(*) FILTER (WHERE status IN ('WIN','LOSS','PUSH')))::int AS settled FROM picks GROUP BY 1 ORDER BY picks DESC`;
  const targets = users.filter((u) => !only || u.userId === only).slice(0, only ? 1 : 3);
  await prisma.$disconnect();
  console.log(`| user (picks / settled) | path | statements | app payload | db row bytes | wall ms |\n|---|---|---|---|---|---|`);
  for (const u of targets) {
    for (const m of ["old", "new"]) {
      const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/t2-harness/measure-dashboard.ts"], {
        env: { ...process.env, MEASURE_MODE: m, MEASURE_USER: u.userId },
        encoding: "utf8",
        maxBuffer: 1 << 30,
      });
      const line = `${r.stdout}\n${r.stderr}`.split("\n").find((l) => l.startsWith("RESULT "));
      if (!line) throw new Error(`no result from ${m}: ${r.stderr}`);
      const res = JSON.parse(line.slice(7));
      console.log(`| ${u.picks} / ${u.settled} | ${m === "old" ? "legacy (findMany + 3 includes)" : "one statement"} | ${res.stmtCount} | ${(res.appBytes / 1024).toFixed(1)} KB | ${(res.dbRowBytes / 1024).toFixed(1)} KB | ${res.ms} |`);
    }
  }
}
(mode ? child() : parent()).catch((e) => {
  console.error(e);
  process.exit(1);
});
