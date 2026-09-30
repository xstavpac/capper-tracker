// Parity test for the capper comparison's narrowed pick read. buildProfile used to
// load each capper's picks with `include: { capper, sport, league }` (every column
// plus three relations); it now `select`s only the columns the filters and stats
// read (COMPARISON_PICK_SELECT). The output must be identical, for every filter
// dimension, because the filtering and stats code is unchanged - this proves no
// needed column was dropped.
//
// Reference = the ORIGINAL read (getPicksForCapper: full rows + relations) fed
// through the same applyComparisonFilters / computeStats / units-series functions.
//
// Two modes:
//   default       DB-backed and WRITING: creates its own user/cappers/picks (ids
//                 prefixed `__CmpParity__`), deletes them at the end.
//   --real-db     READ-ONLY: takes the user with the most picks already in the
//                 database (a restored anonymized snapshot) and compares their
//                 cappers pairwise under every filter. Nothing is written.
// Both refuse to run unless DATABASE_URL points at localhost. Run against a
// disposable local Postgres with migrations applied:
//   DATABASE_URL=postgresql://postgres@localhost:5432/capper_cmp DIRECT_URL=... \
//   npx tsx src/server/data/capper-comparison-acceptance-test.ts [--real-db]
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { getPicksForCapper } from "@/server/data/picks";
import {
  getCapperComparison,
  applyComparisonFilters,
  EMPTY_COMPARISON_FILTERS,
  type ComparisonFilters,
  type CapperComparisonProfile,
} from "@/server/data/capper-comparison";
import { computeStats, computeUnitsChartByPickNumber, computeMaxDrawdown } from "@/server/data/stats";

function hostOf(url: string | undefined): string {
  try {
    return new URL(url ?? "").hostname;
  } catch {
    return "";
  }
}
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostOf(process.env.DATABASE_URL))) {
  console.log("SKIP: DATABASE_URL is not a local database - this test only runs against localhost/127.0.0.1.");
  process.exit(0);
}

const REAL_DB = process.argv.includes("--real-db");

let failures = 0;
let assertions = 0;
function check(label: string, pass: boolean, detail = "") {
  assertions++;
  if (!pass || process.env.VERBOSE) console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

// The original buildProfile body, verbatim in behavior.
async function referenceProfile(userId: string, capperId: string, capperName: string, filters: ComparisonFilters): Promise<CapperComparisonProfile> {
  const allPicks = await getPicksForCapper(userId, capperId);
  const filtered = applyComparisonFilters(allPicks, filters);
  return {
    capperId,
    capperName,
    stats: computeStats(filtered),
    chartData: computeUnitsChartByPickNumber(filtered),
    maxDrawdown: computeMaxDrawdown(filtered),
    betCount: filtered.filter((p) => p.status === "WIN" || p.status === "LOSS").length,
  };
}

// JSON with non-finite numbers made visible (JSON.stringify would turn them into null).
const ser = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "number" && !Number.isFinite(x) ? `#${x}` : x));

function filterSet(sportIds: string[], dateRange: { start: string; end: string }): { name: string; f: ComparisonFilters }[] {
  const f = (over: Partial<ComparisonFilters>): ComparisonFilters => ({ ...EMPTY_COMPARISON_FILTERS, ...over });
  const sets: { name: string; f: ComparisonFilters }[] = [
    { name: "none", f: f({}) },
    { name: "favorite", f: f({ favDog: "FAVORITE" }) },
    { name: "underdog", f: f({ favDog: "UNDERDOG" }) },
    { name: "odds range", f: f({ oddsMin: -150, oddsMax: 120 }) },
    { name: "units range", f: f({ unitsMin: 1, unitsMax: 2 }) },
    { name: "date range", f: f({ dateRange }) },
    { name: "month", f: f({ month: 9 }) },
    { name: "combined", f: f({ favDog: "FAVORITE", oddsMax: 0, unitsMin: 0.5 }) },
  ];
  for (const sportId of sportIds) sets.push({ name: `sport ${sportId.slice(-6)}`, f: f({ sportId }) });
  for (const betType of ["SPREAD", "MONEYLINE", "TOTAL", "TD", "NRFI", "F5_MONEYLINE"] as const) sets.push({ name: `betType ${betType}`, f: f({ betType }) });
  for (const dayOfWeek of [0, 2, 4, 6]) sets.push({ name: `day ${dayOfWeek}`, f: f({ dayOfWeek }) });
  for (const type of ["WIN", "LOSS"] as const) for (const length of [1, 2, 3, 4] as const) sets.push({ name: `streak ${type}${length}`, f: f({ streak: { type, length } }) });
  return sets;
}

async function compareAll(userId: string, capperIds: string[], sportIds: string[], dateRange: { start: string; end: string }, label: string) {
  const names = new Map((await prisma.capper.findMany({ where: { userId, id: { in: capperIds } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  const pairs: [string, string][] = [];
  for (let i = 0; i < capperIds.length; i++) for (let j = i + 1; j < capperIds.length; j++) pairs.push([capperIds[i], capperIds[j]]);
  let compared = 0;
  let nonEmpty = 0;
  for (const { name, f } of filterSet(sportIds, dateRange)) {
    for (const [a, b] of pairs) {
      const actual = await getCapperComparison(userId, a, b, f);
      const expected = { a: await referenceProfile(userId, a, names.get(a)!, f), b: await referenceProfile(userId, b, names.get(b)!, f) };
      const same = ser(actual) === ser(expected);
      check(`${label}: filter "${name}" (${a.slice(-4)} vs ${b.slice(-4)})`, same, same ? "" : `\n  actual=${ser(actual).slice(0, 400)}\n  expected=${ser(expected).slice(0, 400)}`);
      compared++;
      if (actual.a.betCount + actual.b.betCount > 0) nonEmpty++;
    }
  }
  console.log(`${label}: ${compared} comparisons, ${nonEmpty} with at least one bet`);
  return nonEmpty;
}

async function checkQueryShape(userId: string, a: string, b: string) {
  type FindManyArgs = Parameters<typeof prisma.pick.findMany>[0];
  const seen: FindManyArgs[] = [];
  const original = prisma.pick.findMany.bind(prisma.pick);
  (prisma.pick as unknown as { findMany: unknown }).findMany = (args: FindManyArgs) => {
    seen.push(args);
    return original(args as never);
  };
  try {
    await getCapperComparison(userId, a, b, EMPTY_COMPARISON_FILTERS);
  } finally {
    (prisma.pick as unknown as { findMany: unknown }).findMany = original;
  }
  const reads = seen.filter((x) => x?.where && "capperId" in (x.where as object));
  check("one pick read per capper", reads.length === 2, `got ${reads.length}`);
  for (const r of reads) {
    check("pick read joins no relation", r?.include === undefined);
    const keys = Object.keys((r?.select ?? {}) as object).sort();
    const expected = [
      "id", "sportId", "betType", "period", "betDetail", "propMarket", "line", "odds", "pickedSide", "mlFavoredSide", "gameTime", "units", "status", "createdAt", "gradedAt",
    ].sort();
    check("pick read selects exactly the comparison columns", JSON.stringify(keys) === JSON.stringify(expected), keys.join(","));
  }
}

const PREFIX = "__CmpParity__";

async function runFixture() {
  const userId = `${PREFIX}user`;
  await prisma.user.create({ data: { id: userId, supabaseId: `${PREFIX}sb`, email: `${PREFIX}u@example.invalid` } });
  const createdSportIds: string[] = [];
  const sportIds: string[] = [];
  for (const name of ["MLB", "NFL"]) {
    const existing = await prisma.sport.findUnique({ where: { name } });
    if (existing) sportIds.push(existing.id);
    else {
      const s = await prisma.sport.create({ data: { name } });
      createdSportIds.push(s.id);
      sportIds.push(s.id);
    }
  }
  try {
    const capperIds = [`${PREFIX}c1`, `${PREFIX}c2`, `${PREFIX}c3`];
    for (const [i, id] of capperIds.entries()) await prisma.capper.create({ data: { id, userId, name: `Cmp ${i + 1}`, source: "OTHER" } });

    let n = 0;
    const T = Date.parse("2026-09-10T18:00:00Z");
    const rows: Prisma.PickCreateManyInput[] = [];
    const betTypes = ["SPREAD", "MONEYLINE", "TOTAL", "NRFI", "MONEYLINE", "SPREAD", "PLAYER_PROP"] as const;
    for (const [ci, capperId] of capperIds.entries()) {
      for (let i = 0; i < 40; i++) {
        n++;
        const betType = betTypes[(i + ci) % betTypes.length];
        const status = (["WIN", "LOSS", "WIN", "PUSH", "LOSS", "WIN", "PENDING", "WIN", "LOSS", "LOSS"] as const)[(i * 3 + ci) % 10];
        // several picks deliberately share a gameTime (real slates do) so the
        // (gameTime, createdAt, id) tie-break decides streaks and the series.
        const gameTime = new Date(T + Math.floor(i / 2) * 26 * 3600000 * (ci + 1));
        rows.push({
          id: `${PREFIX}pick-${String(n).padStart(4, "0")}`,
          userId,
          capperId,
          sportId: sportIds[(i + ci) % 2],
          homeTeam: "H",
          awayTeam: "A",
          betType,
          betDetail: betType === "TOTAL" ? (i % 2 ? "Over 8.5" : "Under 8.5") : betType === "NRFI" ? (i % 2 ? "NRFI" : "YRFI") : betType === "PLAYER_PROP" ? "Puka Nacua Anytime TD" : null,
          propMarket: betType === "PLAYER_PROP" && i % 4 === 0 ? "TD" : null,
          period: i % 11 === 0 ? "FIRST_HALF" : "FULL_GAME",
          odds: [-110, 150, -200, 120, -105, 240][(i + ci) % 6],
          line: betType === "SPREAD" ? (i % 3 === 0 ? 2.5 : -3.5) : null,
          pickedSide: betType === "MONEYLINE" ? (i % 2 ? "HOME" : "AWAY") : null,
          mlFavoredSide: betType === "MONEYLINE" && i % 3 ? "HOME" : null,
          units: [1, 0.5, 2, 1.5, 3][(i + ci) % 5],
          datePosted: new Date(gameTime.getTime() - 3600000),
          gameTime,
          status,
          gradedAt: status === "PENDING" ? null : new Date(gameTime.getTime() + 4 * 3600000),
          createdAt: new Date(T - n * 1000),
        });
      }
    }
    await prisma.pick.createMany({ data: rows });

    const nonEmpty = await compareAll(userId, capperIds, sportIds, { start: "2026-09-12", end: "2026-09-30" }, "fixture");
    check("fixture exercises filters that return bets", nonEmpty > 50, `nonEmpty=${nonEmpty}`);
    await checkQueryShape(userId, capperIds[0], capperIds[1]);
  } finally {
    await prisma.pick.deleteMany({ where: { userId } });
    await prisma.capper.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    if (createdSportIds.length) await prisma.sport.deleteMany({ where: { id: { in: createdSportIds } } });
  }
}

async function runRealDb() {
  const top = await prisma.pick.groupBy({ by: ["userId"], _count: { userId: true }, orderBy: { _count: { userId: "desc" } }, take: 1 });
  if (!top.length) throw new Error("--real-db: no picks in this database");
  const userId = top[0].userId;
  // The busiest cappers: where a dropped column or an ordering slip would show.
  const byCapper = await prisma.pick.groupBy({ by: ["capperId"], where: { userId }, _count: { capperId: true }, orderBy: { _count: { capperId: "desc" } }, take: 4 });
  const capperIds = byCapper.map((c) => c.capperId);
  const sportIds = (await prisma.pick.findMany({ where: { userId, capperId: { in: capperIds } }, select: { sportId: true }, distinct: ["sportId"] })).map((s) => s.sportId);
  const latest = await prisma.pick.aggregate({ where: { userId }, _max: { gameTime: true } });
  const end = latest._max.gameTime ?? new Date();
  const start = new Date(end.getTime() - 60 * 86400000);
  const day = (d: Date) => d.toISOString().slice(0, 10);
  console.log(`real-db: ${capperIds.length} busiest cappers of the top account (${byCapper.map((c) => c._count.capperId).join(", ")} picks)`);
  const nonEmpty = await compareAll(userId, capperIds, sportIds, { start: day(start), end: day(end) }, "real-db");
  check("real data exercises filters that return bets", nonEmpty > 100, `nonEmpty=${nonEmpty}`);
  await checkQueryShape(userId, capperIds[0], capperIds[1]);
}

(REAL_DB ? runRealDb() : runFixture())
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(async () => {
    await prisma.$disconnect();
    console.log(`\n${assertions} assertions, ${failures} failed.`);
    if (failures > 0) process.exit(1);
    console.log("All checks passed.");
  });
