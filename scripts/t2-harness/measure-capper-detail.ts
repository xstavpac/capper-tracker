// Capper-detail PR: statements and payload per /cappers/[capperId] data load (default params:
// window ALL, categoryWindow ALL), legacy vs one-statement. Each path runs in its own child process
// against a Prisma client that logs every statement (src/lib/prisma.ts reuses globalThis.prisma outside
// production, so a logging client installed before any app module loads is the one the app's own code
// uses) - the statement count is what the path really issues. The count covers the page's data calls
// (getCapperById + the pick loading/aggregation + the roster list); requireUser adds one statement to
// both paths (the Prisma `user` find), which is not in the table.
//   DATABASE_URL=<snapshot db> node --import tsx scripts/t2-harness/measure-capper-detail.ts [--capper-id=<id>] [--synthetic=4291]
// Payload is measured two ways: what the app receives (JSON bytes of the Prisma results; for legacy the
// relation rows are counted once per distinct id, as Prisma sends them) and database-side row bytes
// (pg_column_size of the capper's pick rows + the roster's capper rows vs octet_length of the bundle jsonb
// + the narrowed roster). Neither includes TLS/protocol framing; both are the same yardstick for both paths.
// `--synthetic=N` inserts a disposable capper with N random picks (ids prefixed __MeasureCapperDetail__,
// deleted by exact id at the end) so the scaling case can be measured on a snapshot with small cappers.
import { spawnSync } from "node:child_process";
import { Prisma, PrismaClient } from "@prisma/client";
import { assertNotProd } from "./lib/prod-guard.mjs";

assertNotProd(process.env.DATABASE_URL ?? "", "DATABASE_URL (measure-capper-detail.ts)");
const mode = process.env.MEASURE_MODE;
const PREFIX = "__MeasureCapperDetail__";

const statements: string[] = [];
const prisma = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
prisma.$on("query", (e) => statements.push(e.query));
(globalThis as unknown as { prisma?: PrismaClient }).prisma = prisma;

const json = (x: unknown) => Buffer.byteLength(JSON.stringify(x));

async function child() {
  const userId = process.env.MEASURE_USER!;
  const capperId = process.env.MEASURE_CAPPER!;
  const params = { window: "ALL", categoryWindow: "ALL" } as const;
  const { getCapperById, getCappersWithPickCounts } = await import("@/server/data/cappers");
  const runs: number[] = [];
  let stmtCount = 0;
  let appBytes = 0;
  let dbRowBytes = 0;
  let picks = 0;
  for (let i = 0; i < 6; i++) {
    const now = new Date();
    if (i > 0) statements.length = 0;
    const t0 = performance.now();
    if (mode === "old") {
      const { loadLegacyCapperPicks, computeCapperDetailLegacy } = await import("@/server/data/capper-detail-legacy");
      await getCapperById(userId, capperId);
      const rows = await loadLegacyCapperPicks(userId, capperId);
      // The roster as it was fetched before Q5: full capper rows + _count, mapped down afterwards.
      const roster = await prisma.capper.findMany({ where: { userId }, include: { _count: { select: { picks: true } } }, orderBy: { name: "asc" } });
      computeCapperDetailLegacy(rows, params, now);
      runs.push(performance.now() - t0);
      if (i === 0) {
        stmtCount = statements.length;
        picks = rows.length;
        const bare = rows.map(({ sport: _s, capper: _c, league: _l, ...p }) => p);
        const rel = (k: "sport" | "capper" | "league") => {
          const m = new Map<string, unknown>();
          for (const r of rows) {
            const v = r[k] as { id?: string; name: string } | null;
            if (v) m.set(v.id ?? v.name, v);
          }
          return [...m.values()];
        };
        appBytes = [bare, rel("sport"), rel("capper"), rel("league"), roster].reduce((a: number, x) => a + json(x), 0);
        const [{ b }] = await prisma.$queryRaw<{ b: number }[]>(Prisma.sql`SELECT coalesce(sum(pg_column_size(p.*)),0)::float8 AS b FROM picks p WHERE p."userId" = ${userId} AND p."capperId" = ${capperId}`);
        const [{ c }] = await prisma.$queryRaw<{ c: number }[]>(Prisma.sql`SELECT coalesce(sum(pg_column_size(c.*)),0)::float8 AS c FROM cappers c WHERE c."userId" = ${userId}`);
        dbRowBytes = b + c;
      }
    } else {
      const { getCapperDetailData, buildCapperDetailBundleQuery } = await import("@/server/data/capper-detail");
      await getCapperById(userId, capperId);
      await getCapperDetailData(userId, capperId, params, now);
      await getCappersWithPickCounts(userId);
      runs.push(performance.now() - t0);
      if (i === 0) {
        stmtCount = statements.length;
        const q = await prisma.$queryRaw<{ out: unknown; n: number }[]>(Prisma.sql`SELECT out, octet_length(out::text) AS n FROM (${buildCapperDetailBundleQuery(userId, capperId, params, now)}) q`);
        const roster = await prisma.capper.findMany({ where: { userId }, select: { id: true, name: true, _count: { select: { picks: true } } }, orderBy: { name: "asc" } });
        picks = (q[0].out as { meta: { count: number }[] }).meta[0]?.count ?? 0;
        appBytes = json(q[0].out) + json(roster);
        dbRowBytes = Number(q[0].n) + json(roster);
      }
    }
  }
  runs.shift(); // first run pays connection + query-plan warm-up in both modes
  runs.sort((a, b) => a - b);
  console.log(`RESULT ${JSON.stringify({ stmtCount, picks, appBytes, dbRowBytes, ms: Math.round(runs[Math.floor(runs.length / 2)]) })}`);
  await prisma.$disconnect();
}

async function makeSynthetic(n: number) {
  const { pickCategory, PICK_CATEGORY_VERSION } = await import("@/server/data/stats");
  const userId = `${PREFIX}user`;
  await prisma.user.create({ data: { id: userId, supabaseId: `${PREFIX}sb`, email: `${PREFIX}@example.invalid` } });
  const capperId = `${PREFIX}capper`;
  await prisma.capper.create({ data: { id: capperId, userId, name: `${PREFIX}heavy`, source: "OTHER" } });
  const sports = await prisma.sport.findMany({ where: { name: { in: ["MLB", "NFL", "NHL"] } } });
  let seed = 4291;
  const r = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const now = Date.now();
  const rows: Prisma.PickCreateManyInput[] = [];
  for (let i = 0; i < n; i++) {
    const sport = sports[Math.floor(r() * sports.length)];
    const betType = (["MONEYLINE", "SPREAD", "TOTAL"] as const)[Math.floor(r() * 3)];
    const odds = [-110, -130, 120, 150, -180][Math.floor(r() * 5)];
    const line = betType === "MONEYLINE" ? null : 3.5;
    const betDetail = betType === "TOTAL" ? "Over 3.5" : betType === "SPREAD" ? "Team -3.5" : null;
    const x = r();
    const gameTime = new Date(now - Math.floor(r() * 400 * 86400000));
    const status = x < 0.45 ? "WIN" : x < 0.9 ? "LOSS" : "PUSH";
    rows.push({
      id: `${PREFIX}p${String(i).padStart(6, "0")}`,
      userId,
      capperId,
      sportId: sport.id,
      homeTeam: "Home Team",
      awayTeam: "Away Team",
      betType,
      betDetail,
      odds,
      line,
      period: "FULL_GAME",
      units: 1,
      datePosted: gameTime,
      gameTime,
      status,
      gradedAt: new Date(gameTime.getTime() + 3 * 3600000),
      category: pickCategory({ betType, period: "FULL_GAME", betDetail, odds, line, sportName: sport.name, pickedSide: null, mlFavoredSide: null, propMarket: null }),
      categoryVersion: PICK_CATEGORY_VERSION,
    });
  }
  await prisma.pick.createMany({ data: rows });
  return { userId, capperId };
}

async function parent() {
  const argv = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const cappers = await prisma.$queryRaw<{ userId: string; capperId: string; picks: number; settled: number }[]>`
    SELECT p."userId", p."capperId", count(*)::int AS picks, (count(*) FILTER (WHERE p.status IN ('WIN','LOSS','PUSH')))::int AS settled
    FROM picks p GROUP BY 1, 2 ORDER BY picks DESC, 2`;
  const mean = cappers.reduce((a, c) => a + c.picks, 0) / cappers.length;
  const meanCapper = [...cappers].sort((a, b) => Math.abs(a.picks - mean) - Math.abs(b.picks - mean))[0];
  const targets: { label: string; userId: string; capperId: string; picks: number; settled: number }[] = [];
  if (argv("capper-id")) {
    const c = cappers.find((x) => x.capperId === argv("capper-id"))!;
    targets.push({ label: "chosen", ...c });
  } else {
    targets.push({ label: "heaviest snapshot capper", ...cappers[0] }, { label: `mean capper (mean ${mean.toFixed(0)} picks)`, ...meanCapper });
  }
  let syntheticCleanup = false;
  const syn = Number(argv("synthetic") ?? 0);
  if (syn > 0) {
    syntheticCleanup = true;
    const s = await makeSynthetic(syn);
    targets.push({ label: `synthetic ${syn}-pick capper`, ...s, picks: syn, settled: syn });
  }
  await prisma.$disconnect();
  try {
    console.log(`| capper (picks / settled) | path | data-layer statements | app payload | db row bytes | wall ms (median of 5) |\n|---|---|---|---|---|---|`);
    for (const t of targets) {
      for (const m of ["old", "new"]) {
        const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/t2-harness/measure-capper-detail.ts"], {
          env: { ...process.env, MEASURE_MODE: m, MEASURE_USER: t.userId, MEASURE_CAPPER: t.capperId },
          encoding: "utf8",
          maxBuffer: 1 << 30,
        });
        const line = `${r.stdout}\n${r.stderr}`.split("\n").find((l) => l.startsWith("RESULT "));
        if (!line) throw new Error(`no result from ${m}: ${r.stderr}`);
        const res = JSON.parse(line.slice(7));
        console.log(`| ${t.label}: ${t.picks} / ${t.settled} | ${m === "old" ? "legacy (findMany + 3 includes, full roster rows)" : "one statement + narrowed roster"} | ${res.stmtCount} | ${(res.appBytes / 1024).toFixed(1)} KB | ${(res.dbRowBytes / 1024).toFixed(1)} KB | ${res.ms} |`);
      }
    }
  } finally {
    if (syntheticCleanup) {
      const p2 = new PrismaClient();
      const del = await p2.user.deleteMany({ where: { id: `${PREFIX}user` } });
      console.log(`cleanup: deleted ${del.count} synthetic user (cascade); picks left with the prefix: ${await p2.pick.count({ where: { id: { startsWith: PREFIX } } })}`);
      await p2.$disconnect();
    }
  }
}
(mode ? child() : parent()).catch((e) => {
  console.error(e);
  process.exit(1);
});
