// /picks "Load older picks" must leave the first page exactly as it was: the
// page function (app/(app)/picks/page.tsx) runs here against seeded rows with a
// query-logging PrismaClient, and every SQL statement it sends is compared with
// the statements main sent for the same requests before the change
// (picks-page-one-statements-fixture.ts, captured at fe5af69). The picks read
// itself is also pinned to the DB Monitor fixture "/picks date range, 18
// columns" (#301), and no statement may carry the older-picks cursor shape.
//
// Query-logging harness: the logging client is installed as globalThis.prisma
// (lib/prisma.ts reuses it) before any app module loads; requireUser is
// stubbed; the banner .png import resolves to a stub.
//
// DB-backed and WRITING: one seeded user (cascades to its cappers and picks),
// deleted by id. Refuses to run unless DATABASE_URL is local.
//   node --require ./scripts/server-only-stub.cjs --import tsx src/server/data/picks-page-one-statements-acceptance-test.ts
// CAPTURE=1 prints the statement list instead of checking it (used once on
// fe5af69 to write the fixture).
import { PrismaClient } from "@prisma/client";
import { normalizeSql } from "@/lib/db-monitor";
import { drainQueryLog } from "@/server/data/query-log-drain";
import { STATEMENT_FIXTURES } from "@/lib/db-monitor-fixtures";
import { PAGE_ONE_STATEMENTS } from "@/server/data/picks-page-one-statements-fixture";

const queries: string[] = [];
const logged = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
logged.$on("query", (e) => queries.push(e.query));
(globalThis as unknown as { prisma: PrismaClient }).prisma = logged;

const TAG = `p1s-${Date.now()}`;
let userId = "";

function stub(relativePath: string, exports: Record<string, unknown>) {
  const path = require.resolve(relativePath);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as unknown as NodeJS.Module;
}
stub("../auth", { requireUser: async () => ({ id: userId }), getCurrentUser: async () => ({ id: userId }) });
// tsx compiles the page's JSX with the classic runtime (tsconfig keeps jsx: preserve for Next).
(globalThis as unknown as { React: unknown }).React = require("react");
// next/font only works inside a Next build; the page's font loaders just need a className.
stub("next/font/google", new Proxy({}, { get: () => () => ({ className: "", variable: "", style: {} }) }));
(require as unknown as { extensions: Record<string, (m: { exports: unknown }) => void> }).extensions[".png"] = (m) => {
  m.exports = { default: { src: "/stub.png", width: 1, height: 1 } };
};

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

function hostOf(url: string | undefined): string {
  try {
    return new URL(url ?? "").hostname;
  } catch {
    return "";
  }
}

// The requests whose statements are pinned: the default-style single day, each
// DB filter, the in-memory sport and bet-type filters, and a range.
const DAY = "2026-09-15";
const REQUESTS: [string, Record<string, string>][] = [
  ["single day", { date: DAY }],
  ["single day, capper + status", { date: DAY, capperId: "CAPPER_A", status: "WIN" }],
  ["single day, sport + bet type", { date: DAY, sportId: "SPORT", betType: "TOTAL" }],
  ["range", { startDate: "2026-09-14", endDate: DAY }],
];

const sorted = (xs: string[]) => [...xs].sort();
// Placeholders numbered alike and IN lists collapsed: an IN list's length follows
// the local DB (the sports list, the cappers on the page), not the code.
const shape = (sql: string) =>
  normalizeSql(sql)
    .replace(/\$\d+/g, "$?")
    .replace(/IN \(\$\?(?:,\$\?)*\)/g, "IN ($?...)");

async function main() {
  if (!["localhost", "127.0.0.1"].includes(hostOf(process.env.DATABASE_URL))) {
    throw new Error("Refusing to run: DATABASE_URL is not local.");
  }
  const { prisma } = await import("@/lib/prisma");
  const { easternDayStart } = await import("@/lib/dates");
  const user = await prisma.user.create({ data: { supabaseId: `${TAG}-u`, email: `${TAG}@example.test` } });
  userId = user.id;
  let createdSportId: string | null = null;
  try {
    // CI's seed has no sports: create MLB when missing, and delete only what was created.
    const existing = await prisma.sport.findUnique({ where: { name: "MLB" }, select: { id: true } });
    const sport = existing ?? { id: (createdSportId = (await prisma.sport.create({ data: { name: "MLB" } })).id) };
    const capA = await prisma.capper.create({ data: { userId, name: "Alpha", source: "OTHER" } });
    const capB = await prisma.capper.create({ data: { userId, name: "Beta", source: "OTHER" } });
    const at = (dayKey: string, h: number) => new Date(easternDayStart(dayKey).getTime() + h * 3_600_000);
    const base = { userId, sportId: sport.id, odds: -110, units: 1 };
    // Graded rows on distinct games: no live-feed lookups, no consensus pills.
    await prisma.pick.createMany({
      data: [
        { ...base, capperId: capA.id, homeTeam: "New York Yankees", awayTeam: "Boston Red Sox", betType: "TOTAL", betDetail: "Over 8.5", line: 8.5, gameTime: at(DAY, 19), status: "WIN", gradedAt: at(DAY, 23) },
        { ...base, capperId: capB.id, homeTeam: "Chicago Cubs", awayTeam: "St. Louis Cardinals", betType: "MONEYLINE", betDetail: "Chicago Cubs ML", pickedSide: "HOME", gameTime: at(DAY, 20), status: "LOSS", gradedAt: at(DAY, 23) },
        { ...base, capperId: capA.id, homeTeam: "Houston Astros", awayTeam: "Texas Rangers", betType: "SPREAD", betDetail: "Houston Astros -1.5", line: -1.5, pickedSide: "HOME", gameTime: at("2026-09-14", 19), status: "PUSH", gradedAt: at("2026-09-14", 23) },
      ],
    });

    const { default: PicksPage } = await import("@/app/(app)/picks/page");
    const captured: string[][] = [];
    for (const [label, raw] of REQUESTS) {
      const searchParams = Object.fromEntries(
        Object.entries(raw).map(([k, v]) => [k, v === "CAPPER_A" ? capA.id : v === "SPORT" ? sport.id : v])
      );
      await drainQueryLog(logged, queries);
      queries.length = 0;
      await PicksPage({ searchParams });
      await drainQueryLog(logged, queries);
      const statements = sorted(queries.map(shape));
      captured.push(statements);

      if (process.env.CAPTURE) continue;
      const want = PAGE_ONE_STATEMENTS[label];
      check(`${label}: ${want?.length ?? 0} statements, same as before`, JSON.stringify(statements) === JSON.stringify(want),
        JSON.stringify({ missing: (want ?? []).filter((s) => !statements.includes(s)), extra: statements.filter((s) => !(want ?? []).includes(s)) }, null, 1));
    }

    if (process.env.CAPTURE) {
      console.log(JSON.stringify(Object.fromEntries(REQUESTS.map(([label], i) => [label, captured[i]])), null, 2));
      return;
    }

    // The picks read is #301's 18-column statement, byte for byte.
    const fixture = STATEMENT_FIXTURES.find((f) => f.name === "/picks date range, 18 columns (getFilteredPicksForUser, #301)");
    const picksReads = captured.flat().filter((s) => /^SELECT "picks"\."id", "picks"\."capperId"/.test(s) && /"picks"\."gameTime" >= /.test(s));
    // One picks read per request. Without a capper or status filter it is the
    // fixture itself; the capper + status request adds those two conditions.
    check("one picks read per request", picksReads.length === REQUESTS.length, String(picksReads.length));
    check("unfiltered requests read picks with the pinned #301 statement", picksReads.filter((s) => s === shape(fixture?.sql ?? "")).length === REQUESTS.length - 1,
      JSON.stringify(picksReads));
    check("no first-page statement uses the older-picks cursor ordering", captured.flat().every((s) => !/ORDER BY "picks"\."gameTime" DESC, "picks"\."id" DESC/.test(s)));
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
    if (createdSportId) await prisma.sport.deleteMany({ where: { id: createdSportId } });
  }
}

main()
  .catch((err) => {
    console.error("FAIL: unexpected error", err);
    failures++;
  })
  .finally(async () => {
    await logged.$disconnect();
    process.exit(failures ? 1 : 0);
  });
