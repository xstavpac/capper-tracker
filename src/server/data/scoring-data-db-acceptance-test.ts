// The scoring module's data layer against a real database:
//   1. The price rule in SQL (real-price-sql.ts) agrees with priceOf and breakEvenOf over every rule.
//   2. The platform rollup: totals, prop keys, a thin capper's unpriced picks left out of `priced`, and stale rows removed.
//   3. The record bundle with includePricing: priced picks at both levels. Pushes and DEFAULTED prices never count.
//   4. The backtest SQL scores a pick the same as scoring.ts, from results known before it was posted only, and the
//      whole statement runs inside a read-only transaction.
//
// DB-backed and WRITING: seeded users and two seeded sports in 2099, deleted by id. The rollup is global, so it is
// recomputed again afterward. Refuses to run unless DATABASE_URL is a local database named bettingview_dev or capper_ci.
//   node --env-file=<local env file> --require ./scripts/server-only-stub.cjs --import tsx src/server/data/scoring-data-db-acceptance-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { breakEvenOf, buildPlatformRates, platformBreakEvenFor, priceOf, scorePick, type PlatformRateRow, type ScoredPick, type ScoringContext } from "@/lib/parlay/scoring";
import { wilsonLowerBound } from "@/lib/wilson-lower-bound";
import { getCapperRecordBundle } from "@/server/data/picks";
import { recomputePlatformCategoryRates } from "@/server/data/platform-category-rates";
import { realBreakEvenSql } from "@/server/data/real-price-sql";
import type { PickCategoryKey } from "@/server/data/stats";

const url = new URL(process.env.DATABASE_URL ?? "postgresql://none/none");
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !["bettingview_dev", "capper_ci"].includes(url.pathname.slice(1))) {
  console.log("SKIP: DATABASE_URL is not a local bettingview_dev or capper_ci - this test writes fixtures.");
  process.exit(0);
}

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}
const near = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) < 1e-6;

const PREFIX = `__ScoringData${process.pid}__`;
const USER = PREFIX + "user";
const SPORT_A = "ZZSCOREA" + process.pid;
const SPORT_B = "ZZSCOREB" + process.pid;
const T0 = Date.parse("2099-01-01T00:00:00Z");
const DAY = 24 * 3600_000;

type Seed = { capper: string; sport: string; category: string; betType?: string; odds: number; source: "MARKET" | "STATED" | "DEFAULTED" | null; status: "WIN" | "LOSS" | "PUSH"; day: number; propMarket?: string };

let seq = 0;
const idsBySeed = new Map<Seed, string>();
function toRow(s: Seed, sportIds: Record<string, string>): Prisma.PickCreateManyInput {
  const id = `${PREFIX}p${seq++}`;
  idsBySeed.set(s, id);
  const gameTime = new Date(T0 + s.day * DAY);
  return {
    id, userId: USER, capperId: PREFIX + s.capper, sportId: sportIds[s.sport], homeTeam: "H", awayTeam: "A", betType: (s.betType ?? "MONEYLINE") as never, betDetail: "A ML",
    odds: s.odds, oddsSource: s.source, units: 1, datePosted: new Date(gameTime.getTime() - 3600_000), gameTime, status: s.status, category: s.category, categoryVersion: 3, propMarket: (s.propMarket ?? null) as never,
  };
}

async function main() {
  // ---- 1. The price rule, SQL against code ---------------------------------------------------
  const matrix: [number, string | null, string][] = [];
  for (const odds of [-500, -110, -100, 0, 50, 100, 150])
    for (const source of ["MARKET", "STATED", "DEFAULTED", null])
      for (const betType of ["MONEYLINE", "SPREAD", "TOTAL", "TEAM_TOTAL", "NRFI", "PLAYER_PROP"]) matrix.push([odds, source, betType]);
  const values = Prisma.join(matrix.map(([odds, source, betType], i) => Prisma.sql`(${i}::int, ${odds}::int, ${source}::text, ${betType}::text)`));
  const sqlBe = await prisma.$queryRaw<{ i: number; be: number | null }[]>(
    Prisma.sql`SELECT p.i, (${Prisma.raw(realBreakEvenSql("p"))})::float8 AS be FROM (VALUES ${values}) AS p(i, odds, "oddsSource", "betType") ORDER BY p.i`
  );
  const differ = sqlBe.filter((r) => {
    const [odds, source, betType] = matrix[r.i];
    const js = priceOf({ odds, oddsSource: source as never, betType }).status === "UNKNOWN" ? null : breakEvenOf(odds);
    return js === null ? r.be !== null : !near(r.be, js);
  });
  check(`the SQL price rule matches priceOf over ${matrix.length} cases`, differ.length, 0);

  // ---- Seed --------------------------------------------------------------------------------
  const be110 = 110 / 210;
  await prisma.user.create({ data: { id: USER, supabaseId: USER, email: USER + "@example.test" } });
  for (const c of ["a", "b"]) await prisma.capper.create({ data: { id: PREFIX + c, userId: USER, name: PREFIX + c, source: "OTHER" as never } });
  const sportA = await prisma.sport.create({ data: { name: SPORT_A }, select: { id: true } });
  const sportB = await prisma.sport.create({ data: { name: SPORT_B }, select: { id: true } });
  const sportIds = { [SPORT_A]: sportA.id, [SPORT_B]: sportB.id };

  const seeds: Seed[] = [];
  // Capper a: 40 priced FAV_ML in sport A, 26-14; 10 in sport B, 7-3, at their own prices; a push and a DEFAULTED pick that never count as priced.
  for (let i = 0; i < 40; i++) seeds.push({ capper: "a", sport: SPORT_A, category: "FAV_ML", odds: i % 2 ? -130 : -160, source: "MARKET", status: i < 26 ? "WIN" : "LOSS", day: i + 1 });
  for (let i = 0; i < 10; i++) seeds.push({ capper: "a", sport: SPORT_B, category: "FAV_ML", odds: -120, source: "STATED", status: i < 7 ? "WIN" : "LOSS", day: i + 1 });
  seeds.push({ capper: "a", sport: SPORT_A, category: "FAV_ML", odds: -130, source: "MARKET", status: "PUSH", day: 41 });
  seeds.push({ capper: "a", sport: SPORT_A, category: "FAV_ML", odds: -110, source: "DEFAULTED", status: "WIN", day: 42 });
  // Capper b: thin. 2 priced wins and 2 unpriced losses.
  seeds.push({ capper: "b", sport: SPORT_A, category: "FAV_ML", odds: -150, source: "MARKET", status: "WIN", day: 43 });
  seeds.push({ capper: "b", sport: SPORT_A, category: "FAV_ML", odds: -150, source: "MARKET", status: "WIN", day: 44 });
  seeds.push({ capper: "b", sport: SPORT_A, category: "FAV_ML", odds: -110, source: "DEFAULTED", status: "LOSS", day: 45 });
  seeds.push({ capper: "b", sport: SPORT_A, category: "FAV_ML", odds: -110, source: null, status: "LOSS", day: 46 });
  const priors = [...seeds];
  // Scored at day 60; nothing later may reach them.
  const targetEdge: Seed = { capper: "a", sport: SPORT_A, category: "FAV_ML", odds: -2000, source: "MARKET", status: "WIN", day: 60 };
  const targetThin: Seed = { capper: "b", sport: SPORT_A, category: "FAV_ML", odds: -500, source: "MARKET", status: "LOSS", day: 60 };
  const targetNoPrice: Seed = { capper: "a", sport: SPORT_A, category: "FAV_ML", odds: -110, source: "DEFAULTED", status: "WIN", day: 60 };
  const later: Seed[] = Array.from({ length: 5 }, (_, i) => ({ capper: "a", sport: SPORT_A, category: "FAV_ML", odds: -110, source: "MARKET", status: "LOSS", day: 70 + i }));
  seeds.push(targetEdge, targetThin, targetNoPrice, ...later);
  await prisma.pick.createMany({ data: seeds.map((s) => toRow(s, sportIds)) });
  const allIds = seeds.map((s) => idsBySeed.get(s)!);

  try {
    // ---- 2. The rollup ---------------------------------------------------------------------
    const counts = await recomputePlatformCategoryRates();
    check("the rollup returns its two counts", [typeof counts.written, typeof counts.removed], ["number", "number"]);
    const rowA = await prisma.platformCategoryRate.findUnique({ where: { league_betType_key: { league: SPORT_A, betType: "MONEYLINE", key: "FAV_ML" } }, select: { wins: true, losses: true, priced: true, impliedSum: true } });
    const decidedA = seeds.filter((s) => s.sport === SPORT_A && s.status !== "PUSH");
    const pricedA = decidedA.filter((s) => priceOf({ odds: s.odds, oddsSource: s.source, betType: "MONEYLINE" }).status !== "UNKNOWN");
    check("rollup: wins and losses, pushes out", [rowA?.wins, rowA?.losses], [decidedA.filter((s) => s.status === "WIN").length, decidedA.filter((s) => s.status === "LOSS").length]);
    check("rollup: priced leaves unpriced picks out", rowA?.priced, pricedA.length);
    check("rollup: the implied sum", Math.abs((rowA?.impliedSum ?? 0) - pricedA.reduce((n, s) => n + breakEvenOf(s.odds)!, 0)) < 1e-3, true);
    // Twice is the same: an upsert, no duplicates.
    await recomputePlatformCategoryRates();
    check("rollup: a second run keeps one row per key", await prisma.platformCategoryRate.count({ where: { league: SPORT_A } }), 1);

    // ---- 3. The bundle with pricing ------------------------------------------------------------
    const bundle = await getCapperRecordBundle(USER, { leagueEntries: [{ capperId: PREFIX + "b", leagueSport: SPORT_A, category: "FAV_ML" }], categoryPairs: [], includePricing: true });
    const card = bundle.leagueRecords.records[`${PREFIX}b|${SPORT_A}|FAV_ML`]!;
    check("bundle: priced wins and losses leave unpriced picks out", [card.league.wins, card.league.losses, card.priced?.league.wins, card.priced?.league.losses], [2, 3, 2, 1]);
    check("bundle: overall matches with one league", [card.priced?.overall.wins, card.priced?.overall.losses], [2, 1]);
    const plain = await getCapperRecordBundle(USER, { leagueEntries: [{ capperId: PREFIX + "b", leagueSport: SPORT_A, category: "FAV_ML" }], categoryPairs: [] });
    check("bundle: off has no priced field", "priced" in plain.leagueRecords.records[`${PREFIX}b|${SPORT_A}|FAV_ML`]!, false);

    // ---- 4. The backtest, against the module -------------------------------------------------------
    const file = readFileSync(join(process.cwd(), "scripts/t2-harness/scoring-backtest.sql"), "utf8");
    const prefix = file.slice(0, file.indexOf("-- @@FINAL"));
    const scoredRows = await prisma.$queryRawUnsafe<{ id: string; edge_logit: number; win_rate_378: number; old_wilson: number; old_win_pct: number }[]>(
      `${prefix} SELECT id, edge_logit, win_rate_378, old_wilson, old_win_pct FROM scored WHERE uid = '${USER}'`
    );
    const byId = new Map(scoredRows.map((r) => [r.id, r]));

    // What the module says from the same point in time: every prior, nothing from day 60 on.
    const decidedPriors = priors.filter((s) => s.status !== "PUSH");
    const rows: PlatformRateRow[] = [];
    for (const sport of [SPORT_A, SPORT_B]) {
      const here = decidedPriors.filter((s) => s.sport === sport);
      const p = here.filter((s) => priceOf({ odds: s.odds, oddsSource: s.source, betType: "MONEYLINE" }).status !== "UNKNOWN");
      rows.push({ league: sport, betType: "MONEYLINE", key: "FAV_ML", wins: here.filter((s) => s.status === "WIN").length, losses: here.filter((s) => s.status === "LOSS").length, impliedSum: p.reduce((n, s) => n + breakEvenOf(s.odds)!, 0), priced: p.length });
    }
    const platformRates = buildPlatformRates(rows);
    const column = (list: Seed[]) => ({ wins: list.filter((s) => s.status === "WIN").length, losses: list.filter((s) => s.status === "LOSS").length, pushes: 0, winPct: 0, count: 0 });
    const pricedColumn = (list: Seed[]) => {
      const p = list.filter((s) => priceOf({ odds: s.odds, oddsSource: s.source, betType: "MONEYLINE" }).status !== "UNKNOWN");
      return { wins: p.filter((s) => s.status === "WIN").length, losses: p.filter((s) => s.status === "LOSS").length, impliedSum: p.reduce((n, s) => n + breakEvenOf(s.odds)!, 0) };
    };
    const scoreOf = (t: Seed): ScoredPick => {
      const mine = decidedPriors.filter((s) => s.capper === t.capper);
      const lg = mine.filter((s) => s.sport === t.sport);
      const ctx: ScoringContext = {
        leagueRecords: {
          records: { [`${PREFIX}${t.capper}|${t.sport}|FAV_ML`]: { category: "FAV_ML" as PickCategoryKey, label: "", league: column(lg), overall: column(mine), priced: { league: pricedColumn(lg), overall: pricedColumn(mine) } } },
          streaks: {},
          last20: {},
        },
        platformRates,
      };
      return scorePick({ pickId: "t", capperId: PREFIX + t.capper, leagueName: t.sport, category: "FAV_ML", betType: "MONEYLINE", propMarket: null, odds: t.odds, oddsSource: t.source } as never, ctx) as ScoredPick;
    };
    for (const [label, t, model] of [["edge model at -2000", targetEdge, "edge model"], ["thin capper at -500", targetThin, "win-rate model"], ["no real price", targetNoPrice, "win-rate model"]] as const) {
      const js = scoreOf(t);
      const sql = byId.get(idsBySeed.get(t)!);
      check(`module: ${label} is on the ${model}`, js.model, model);
      check(`backtest edge_logit = module rankScore: ${label}`, near(sql?.edge_logit ?? null, js.rankScore), true);
      const winRate = js.margin ?? js.shrunkWinProb - platformBreakEvenFor(platformRates, { league: t.sport, betType: "MONEYLINE", key: "FAV_ML" });
      check(`backtest win_rate_378 = the #378 formula: ${label}`, near(sql?.win_rate_378 ?? null, winRate), true);
      const lg = decidedPriors.filter((s) => s.capper === t.capper && s.sport === t.sport);
      const all = decidedPriors.filter((s) => s.capper === t.capper);
      const wilson = Math.max(wilsonLowerBound(column(lg).wins, column(lg).losses, 1.5), wilsonLowerBound(column(all).wins, column(all).losses, 1.5));
      check(`backtest old_wilson = best-of-two at z 1.5: ${label}`, near(sql?.old_wilson ?? null, wilson), true);
    }
    check("the later losses never reach the day-60 picks", scoreOf(targetEdge).pricedPicks, decidedPriors.filter((s) => s.capper === "a" && s.source !== "DEFAULTED").length);

    // The whole statement, read-only, aggregates only.
    const whole = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      return tx.$queryRawUnsafe<Record<string, unknown>[]>(file.replace(/;\s*$/, ""));
    });
    check("backtest: runs in a read-only transaction and returns rows", whole.length > 0, true);
    check("backtest: its columns are aggregates only", Object.keys(whole[0]).sort(), ["avg_edge_pct", "avg_score_pct", "gating", "grp", "hit_pct", "picks", "priced", "scope", "section", "variant"]);
  } finally {
    // By id, everything seeded; then the rollup again so nothing of this test remains in it.
    await prisma.pick.deleteMany({ where: { id: { in: allIds } } });
    await prisma.capper.deleteMany({ where: { id: { in: [PREFIX + "a", PREFIX + "b"] } } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.sport.deleteMany({ where: { id: { in: [sportA.id, sportB.id] } } });
    await recomputePlatformCategoryRates();
  }
  check("cleanup: the rollup holds nothing of this test", await prisma.platformCategoryRate.count({ where: { league: { in: [SPORT_A, SPORT_B] } } }), 0);

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
