// The Q10 parity gate (docs/design/dashboard-capper-detail-egress.md §3.c, §8 micro-test 3):
// the dashboard's SQL running-sum + downsample (page-aggregate-fragments.ts unitsSeriesSelect)
// against the JS it replaces, computeCumulativeUnitsSeries + downsampleUnitsChart, on synthetic
// series of n = 2,000 / 2,001 / 2,002 / 5,000 / 20,000 settled picks in four shapes:
//   monotonic    all WINs           - every bucket's min and max are its first and last point
//   oscillating  alternating W/L    - the cumulative value repeats constantly, so the
//                                     first-index tie-break decides almost every bucket
//   flat         all PUSH           - one value everywhere: pure tie-break
//   walk         random W/L/P over mixed odds and fractional units - float accumulation
// Every case has picks sharing a gameTime and a createdAt order unrelated to insertion or id
// order, so the canonical (gameTime, createdAt, id) order - not the physical row order - is
// what both sides must follow. The 2,000 case must be the identity (no bucketing); 2,001 is
// the first size that buckets. Also covers the zero-odds fallback (a WIN at odds = 0 makes the
// database return the full series for JS to downsample, with JS's Infinity/NaN reproduced).
//
// DB-backed and WRITING (ids prefixed `__UnitsSeriesSql__`, deleted by exact id at the end);
// refuses to run unless DATABASE_URL is local. The parity comparison itself lives in
// units-series-parity.ts, which scripts/t2-harness/units-series-parity.ts also runs against the
// anonymized production snapshot (the "heaviest account" case).
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { UNITS_CHART_MAX_POINTS, downsampleUnitsChart } from "@/server/data/units-chart-downsample";
import { computeUnitsChartData } from "@/server/data/stats";
import { compareUnitsSeriesParity } from "@/server/data/units-series-parity";
import { chartPointsFromSeriesRows, queryUnitsSeries } from "@/server/data/page-aggregate-fragments";

function hostOf(url: string | undefined): string {
  try {
    return new URL(url ?? "").hostname;
  } catch {
    return "";
  }
}
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostOf(process.env.DATABASE_URL))) {
  console.log("SKIP: DATABASE_URL is not a local database - this test writes fixtures and only runs against localhost/127.0.0.1.");
  process.exit(0);
}

let failures = 0;
let assertions = 0;
function check(label: string, pass: boolean, detail = "") {
  assertions++;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

const PREFIX = "__UnitsSeriesSql__";
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ODDS = [-110, -110, -110, -150, -200, -300, 100, 120, 150, 200, 250, 400, -105, -125, 175];
const UNITS = [0.1, 0.25, 0.5, 1, 1, 1, 1.5, 2, 3.3, 0.7];

type Shape = "monotonic" | "oscillating" | "flat" | "walk";

function makeRows(userId: string, capperId: string, sportId: string, tag: string, shape: Shape, n: number, seed: number): Prisma.PickCreateManyInput[] {
  const r = rng(seed);
  // Random distinct ids and a createdAt order unrelated to both insertion order and id order.
  const idOrder = Array.from({ length: n }, (_, i) => i).sort(() => r() - 0.5);
  const created = Array.from({ length: n }, (_, i) => i).sort(() => r() - 0.5);
  const rows: Prisma.PickCreateManyInput[] = [];
  let gt = T0;
  for (let i = 0; i < n; i++) {
    // Every 5th pick shares the previous pick's gameTime, so the tie-break is exercised constantly.
    if (i % 5 !== 0) gt += 60_000 * (1 + Math.floor(r() * 30));
    let status: "WIN" | "LOSS" | "PUSH";
    let odds = -110;
    let units = 1;
    if (shape === "monotonic") status = "WIN";
    else if (shape === "oscillating") {
      status = i % 2 === 0 ? "WIN" : "LOSS";
      odds = 100;
    } else if (shape === "flat") status = "PUSH";
    else {
      const x = r();
      status = x < 0.46 ? "WIN" : x < 0.9 ? "LOSS" : "PUSH";
      odds = ODDS[Math.floor(r() * ODDS.length)];
      units = UNITS[Math.floor(r() * UNITS.length)];
    }
    rows.push({
      id: `${PREFIX}${tag}-p${String(idOrder[i]).padStart(6, "0")}`,
      userId,
      capperId,
      sportId,
      homeTeam: "Home",
      awayTeam: "Away",
      betType: "MONEYLINE",
      odds,
      units,
      gameTime: new Date(gt),
      createdAt: new Date(T0 - 1_000_000_000 + created[i] * 1000),
      status,
      gradedAt: new Date(gt + 3 * 3600000),
    });
  }
  return rows;
}

async function insertAll(rows: Prisma.PickCreateManyInput[]) {
  for (let i = 0; i < rows.length; i += 5000) await prisma.pick.createMany({ data: rows.slice(i, i + 5000) });
}

const createdUserIds: string[] = [];
let createdSportId: string | null = null;

async function main() {
  const userId = `${PREFIX}user`;
  await prisma.user.create({ data: { id: userId, supabaseId: `${PREFIX}sb`, email: `${PREFIX}@example.invalid` } });
  createdUserIds.push(userId);
  let sport = await prisma.sport.findUnique({ where: { name: "MLB" } });
  if (!sport) {
    sport = await prisma.sport.create({ data: { name: "MLB" } });
    createdSportId = sport.id;
  }

  check("UNITS_CHART_MAX_POINTS is 2000 (the gate's sizes straddle it)", UNITS_CHART_MAX_POINTS === 2000);

  const shapes: Shape[] = ["monotonic", "oscillating", "flat", "walk"];
  const sizes = [2000, 2001, 2002, 5000, 20000];
  let seed = 100;
  for (const n of sizes) {
    for (const shape of shapes) {
      const tag = `${shape}-${n}`;
      const capperId = `${PREFIX}capper-${tag}`;
      await prisma.capper.create({ data: { id: capperId, userId, name: tag, source: "OTHER" } });
      await insertAll(makeRows(userId, capperId, sport.id, tag, shape, n, seed++));
      const t0 = Date.now();
      const res = await compareUnitsSeriesParity({ userId, capperId });
      const ms = Date.now() - t0;
      check(
        `n=${n} ${shape}: SQL series == JS (idx, time, round2) at every kept point, direct and via jsonb, labelled chart points equal`,
        res.displayDiffs.length === 0,
        res.displayDiffs.slice(0, 3).join(" | ")
      );
      check(`n=${n} ${shape}: settled=${res.n} -> jsPoints=${res.jsPoints}, sqlRows=${res.sqlRows} (${ms} ms)`, res.n === n && res.sqlRows === res.jsPoints);
      if (n <= UNITS_CHART_MAX_POINTS) check(`n=${n} ${shape}: at or below the max the SQL result is the full series (identity)`, res.sqlRows === n && !res.downsampledInSql);
      else check(`n=${n} ${shape}: above the max the database itself downsampled (<= ${UNITS_CHART_MAX_POINTS} rows)`, res.downsampledInSql && res.sqlRows <= UNITS_CHART_MAX_POINTS);
      console.log(`INFO: n=${n} ${shape}: unrounded running sums that differ bit-for-bit (non-gating): ${res.rawRunDiffs}`);
    }
  }

  // Pooled: the dashboard's real scope (all of a user's cappers together), 5 x 4 cappers' worth of picks.
  {
    const res = await compareUnitsSeriesParity({ userId });
    check(`pooled user scope (${res.n} settled picks across 20 cappers): SQL == JS`, res.displayDiffs.length === 0, res.displayDiffs.slice(0, 3).join(" | "));
    check("pooled user scope: downsampled in SQL to at most the max", res.downsampledInSql && res.sqlRows <= UNITS_CHART_MAX_POINTS);
  }

  // Empty and tiny scopes.
  {
    const emptyCapper = `${PREFIX}capper-empty`;
    await prisma.capper.create({ data: { id: emptyCapper, userId, name: "empty", source: "OTHER" } });
    const rows = await queryUnitsSeries({ userId, capperId: emptyCapper });
    check("no settled picks: no rows, empty chart", rows.length === 0 && chartPointsFromSeriesRows(rows).length === 0);
    await prisma.pick.create({
      data: { id: `${PREFIX}only-pending`, userId, capperId: emptyCapper, sportId: sport.id, homeTeam: "H", awayTeam: "A", betType: "MONEYLINE", odds: -110, units: 1, gameTime: new Date(T0), status: "PENDING" },
    });
    check("PENDING is not in the series", (await queryUnitsSeries({ userId, capperId: emptyCapper })).length === 0);
    const one = `${PREFIX}capper-one`;
    await prisma.capper.create({ data: { id: one, userId, name: "one", source: "OTHER" } });
    await prisma.pick.create({
      data: { id: `${PREFIX}one-loss`, userId, capperId: one, sportId: sport.id, homeTeam: "H", awayTeam: "A", betType: "MONEYLINE", odds: -110, units: 0, gameTime: new Date(T0), status: "LOSS" },
    });
    const res = await compareUnitsSeriesParity({ userId, capperId: one });
    check("single zero-units LOSS: SQL == JS (0 - 0 is +0, as JS `running -= 0`)", res.displayDiffs.length === 0 && res.rawRunDiffs === 0, res.displayDiffs.join(" | "));
  }

  // Zero-odds fallback. A WIN at odds = 0 is uncreatable through the app (both creators reject it) but
  // legal in the table; JS poisons the running sum with Infinity/NaN. SQL cannot sum that, so it adds 0,
  // raises a running flag, skips its own downsample, and the mapper reproduces JS's value from the first
  // flagged row on (then JS's downsampleUnitsChart runs on the full series).
  for (const [label, n, kinds] of [
    ["one zero-odds WIN, units > 0 (+Infinity)", 60, [{ at: 20, units: 1 }]],
    ["zero-odds WIN with units = 0 (NaN)", 60, [{ at: 30, units: 0 }]],
    ["zero-odds WIN units > 0 then units < 0 (Infinity - Infinity = NaN)", 60, [{ at: 10, units: 1 }, { at: 40, units: -1 }]],
    ["above the max: 2,500 picks with one zero-odds WIN (SQL must NOT downsample; JS does)", 2500, [{ at: 1200, units: 1 }]],
  ] as const) {
    const tag = `zero-${n}-${kinds.length}-${kinds[0].units}`;
    const capperId = `${PREFIX}capper-${tag}`;
    await prisma.capper.create({ data: { id: capperId, userId, name: tag, source: "OTHER" } });
    const rows = makeRows(userId, capperId, sport.id, tag, "walk", n, seed++);
    // Rows are generated in chronological order (gameTime non-decreasing); poison the chosen positions.
    for (const k of kinds) Object.assign(rows[k.at], { status: "WIN", odds: 0, units: k.units });
    await insertAll(rows);
    const sql = await queryUnitsSeries({ userId, capperId });
    const picks = await prisma.pick.findMany({ where: { userId, capperId } });
    const js = downsampleUnitsChart(computeUnitsChartData(picks));
    const got = chartPointsFromSeriesRows(sql);
    const diff = got.length !== js.length ? `length ${got.length} vs ${js.length}` : got.findIndex((p, i) => p.date !== js[i].date || !Object.is(p.cumulativeUnits, js[i].cumulativeUnits));
    check(`zero-odds ${label}: chart equals JS including Infinity/NaN`, diff === -1, String(diff));
    check(`zero-odds ${label}: database returned the full ${n}-point series (no SQL downsample)`, sql.length === n);
  }

  console.log(`\n${assertions} assertions, ${failures} failed.`);
}

async function cleanup() {
  let deletedUsers = 0;
  for (const id of createdUserIds) {
    const { count } = await prisma.user.deleteMany({ where: { id } });
    deletedUsers += count;
  }
  let deletedSports = 0;
  if (createdSportId) deletedSports = (await prisma.sport.deleteMany({ where: { id: createdSportId } })).count;
  console.log(`cleanup: deleted ${deletedUsers} user(s), ${deletedSports} sport(s); picks left with the prefix: ${await prisma.pick.count({ where: { id: { startsWith: PREFIX } } })}`);
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    process.exit(failures > 0 ? 1 : 0);
  });
