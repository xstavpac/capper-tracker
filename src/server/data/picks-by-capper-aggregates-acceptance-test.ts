// Parity + behavior tests for the picks-by-capper SQL migration
// (picks-by-capper-aggregates.ts + picks.ts's getCapperRecordBundle): the new
// SQL path must return exactly what the original raw-pick JS path
// (picks-by-capper-legacy.ts, a frozen copy of what picks.ts used to run)
// returned, for the same rows. See docs/design/picks-by-capper-egress.md §8.
//
// DB-backed and WRITING: it creates its own picks (every id/user/capper
// prefixed `__ParityPicksByCapper__`) and deletes them by exact id at the
// end. Refuses to run unless DATABASE_URL points at a local database -
// `npm test` would otherwise pick up a .env pointing at a real database. Run
// against a disposable local Postgres with migrations applied:
//   DATABASE_URL=postgresql://postgres@localhost:5432/<disposable-db> \
//   npx tsx src/server/data/picks-by-capper-aggregates-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import {
  pickCategory,
  currentStreak,
  winPctOf,
  ALL_CATEGORY_KEYS,
  CATEGORY_RECENT_FORM_MIN_SAMPLE,
  CATEGORY_RECENT_FORM_WINDOW,
  LEAGUE_RECORD_LAST_N,
  PICK_CATEGORY_VERSION,
  type PickCategoryKey,
} from "@/server/data/stats";
import { getCapperRecordBundle, categoryRecordKey, type CapperLeagueRecords } from "@/server/data/picks";
import { getCapperCategoryRecordsLegacy, getCapperLeagueRecordsLegacy } from "@/server/data/picks-by-capper-legacy";

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

function firstDiff(a: unknown, b: unknown, path = "$"): string | null {
  if (typeof a === "number" && typeof b === "number") return Object.is(a, b) ? null : `${path}: ${a} !== ${b}`;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b ? null : `${path}: ${String(a)} !== ${String(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs non-array`;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} !== ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  if (ka.join(",") !== kb.join(",")) return `${path}: keys [${ka}] !== [${kb}]`;
  for (const k of ka) {
    const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}
function same(label: string, actual: unknown, expected: unknown) {
  const d = firstDiff(actual, expected);
  check(label, d === null, d ?? "");
}

// item.recent is dropped from the SQL path (design doc Q3 - nothing reads
// it) but the legacy reference (frozen, unmodified from the pre-migration
// path) still computes it. Every legacy-vs-sql comparison over
// getCapperCategoryRecords' output strips it first, so that ONE
// intentional, permanent divergence doesn't fail the parity check for every
// other field - it's asserted directly, once, further down instead.
function stripRecent(records: Record<string, ({ recent?: unknown } & Record<string, unknown>) | null>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(records)) {
    if (item === null) {
      out[key] = null;
      continue;
    }
    const { recent: _recent, ...rest } = item;
    out[key] = rest;
  }
  return out;
}

// ---- fixture plumbing -------------------------------------------------------

const PREFIX = "__ParityPicksByCapper__";
const T0 = Date.now();
const createdUserIds: string[] = [];
const createdSportIds: string[] = [];
const sportIdByName = new Map<string, string>();

async function ensureSport(name: string) {
  const existing = await prisma.sport.findUnique({ where: { name } });
  if (existing) {
    sportIdByName.set(name, existing.id);
    return;
  }
  const s = await prisma.sport.create({ data: { name } });
  createdSportIds.push(s.id);
  sportIdByName.set(name, s.id);
}

async function makeUser(tag: string) {
  const id = `${PREFIX}user-${tag}`;
  await prisma.user.create({ data: { id, supabaseId: `${PREFIX}sb-${tag}`, email: `${PREFIX}${tag}@example.invalid` } });
  createdUserIds.push(id);
  return id;
}

// Picks.capperId is a real FK to Capper - every capperId used below (even
// capZeroPicks, which gets no Pick rows) needs a row here. Cascades from the
// user on cleanup, so nothing extra to delete.
async function makeCapper(userId: string, id: string) {
  await prisma.capper.create({ data: { id, userId, name: id, source: "OTHER" } });
  return id;
}

type PickSpec = {
  capperId: string;
  sport?: string;
  betType?: Prisma.PickUncheckedCreateInput["betType"];
  period?: Prisma.PickUncheckedCreateInput["period"];
  betDetail?: string | null;
  odds?: number;
  line?: number | null;
  units?: number;
  status?: Prisma.PickUncheckedCreateInput["status"];
  gameTime: Date;
  createdAt: Date;
  // Stamp override - default is pickCategory(row) at the current version, as
  // createPicksWithEntitlementCheck would stamp it. Pass explicit `null` with
  // categoryVersion 0 to simulate an unstamped row.
  categoryOverride?: string | null;
  categoryVersionOverride?: number;
};

let pickSeq = 0;
function pickRow(userId: string, s: PickSpec): Prisma.PickCreateManyInput {
  pickSeq++;
  const sport = s.sport ?? "MLB";
  const betType = s.betType ?? "MONEYLINE";
  const period = s.period ?? "FULL_GAME";
  const odds = s.odds ?? -110;
  const line = s.line ?? null;
  const status = s.status ?? "WIN";
  const betDetail = s.betDetail ?? null;
  const computed = pickCategory({ betType, period, betDetail, odds, line, sportName: sport, pickedSide: null, mlFavoredSide: null, propMarket: null });
  const category = s.categoryOverride !== undefined ? s.categoryOverride : computed;
  const categoryVersion = s.categoryVersionOverride !== undefined ? s.categoryVersionOverride : PICK_CATEGORY_VERSION;
  const decided = status !== "PENDING" && status !== "CANCELLED";
  return {
    id: `${PREFIX}pick-${pickSeq}`,
    userId,
    capperId: s.capperId,
    sportId: sportIdByName.get(sport)!,
    homeTeam: "Home",
    awayTeam: "Away",
    betType,
    betDetail,
    odds,
    line,
    period,
    units: s.units ?? 1,
    datePosted: s.gameTime,
    gameTime: s.gameTime,
    status,
    gradedAt: decided ? new Date(s.gameTime.getTime() + 3 * 3600000) : null,
    createdAt: s.createdAt,
    category,
    categoryVersion,
  };
}
async function addPicks(userId: string, specs: PickSpec[]) {
  await prisma.pick.createMany({ data: specs.map((s) => pickRow(userId, s)) });
}

// t(minutesAgo) - a gameTime `minutes` before T0; ct(minutesAgo, offsetMs) - a
// createdAt tie-break value distinct per pick even when gameTime is shared.
const t = (minutes: number) => new Date(T0 - minutes * 60000);
let ctSeq = 0;
const ct = (minutes: number) => {
  ctSeq++;
  return new Date(T0 - minutes * 60000 - ctSeq);
};

// Both callers pass through getCapperRecordBundle - exercising just the two
// wrapper entry points (as production call sites do) is enough to cover the
// bundle's shared logic; a dedicated combined-call scenario further down
// exercises leagueEntries + categoryPairs together in one bundle call.
async function newPath(
  userId: string,
  entries: { capperId: string; leagueSport: string; category: PickCategoryKey | null }[],
  pairs: { capperId: string; category: PickCategoryKey }[]
) {
  return getCapperRecordBundle(userId, { leagueEntries: entries, categoryPairs: pairs });
}

// Canonical tie-break the SQL path uses (ORDER_DESC in capper-list-aggregates.ts):
// gameTime, then createdAt, then id, ascending for "oldest first".
type Ordered = { gameTime: Date; createdAt: Date; id: string };
function cmpAscending(a: Ordered, b: Ordered): number {
  const dg = a.gameTime.getTime() - b.gameTime.getTime();
  if (dg !== 0) return dg;
  const dc = a.createdAt.getTime() - b.createdAt.getTime();
  if (dc !== 0) return dc;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// The design doc's "legacy-with-explicit-total-order" reference (§8, hard
// gate): the SAME rows the legacy path reads, with the SQL path's tie-break
// (gameTime, createdAt, id) forced explicitly instead of relying on whatever
// order Postgres happens to return (fetchPicksByCapperLegacy has no orderBy).
// Built from the same shared primitives the legacy path itself uses
// (currentStreak, winPctOf) - not a new implementation, just explicit
// ordering, exactly as the design doc describes it.
async function explicitOrderStreakAndLast20(userId: string, capperId: string) {
  const picks = await prisma.pick.findMany({ where: { userId, capperId } });
  const decided = picks.filter((p) => p.status === "WIN" || p.status === "LOSS" || p.status === "PUSH");

  const streak = currentStreak([...decided].sort(cmpAscending));

  const newestFirst = [...decided].sort((a, b) => cmpAscending(b, a));
  const window = newestFirst.slice(0, LEAGUE_RECORD_LAST_N);
  const wins = window.filter((p) => p.status === "WIN").length;
  const losses = window.filter((p) => p.status === "LOSS").length;
  const pushes = window.filter((p) => p.status === "PUSH").length;
  const last20 =
    decided.length >= LEAGUE_RECORD_LAST_N ? { wins, losses, pushes, winPct: winPctOf(wins, losses), count: wins + losses + pushes } : null;

  return { streak, last20 };
}

// ---- main -------------------------------------------------------------------

async function main() {
  await ensureSport("MLB");
  await ensureSport("NFL");
  const U = await makeUser("main");
  const mlb = "MLB";
  const nfl = "NFL";

  // ---------------- Capper A: multi-sport, multi-category, a NULL-category pick ----------------
  const capA = await makeCapper(U, `${PREFIX}capA`);
  await addPicks(U, [
    // MLB moneyline favorite, 3 wins then a push then 2 losses then a win -
    // exercises PUSH inside the streak (skipped, doesn't break it) and gives
    // the overall/league split something to differ on.
    { capperId: capA, sport: mlb, betType: "MONEYLINE", odds: -150, status: "WIN", gameTime: t(600), createdAt: ct(600) },
    { capperId: capA, sport: mlb, betType: "MONEYLINE", odds: -150, status: "WIN", gameTime: t(590), createdAt: ct(590) },
    { capperId: capA, sport: mlb, betType: "MONEYLINE", odds: -150, status: "LOSS", gameTime: t(580), createdAt: ct(580) },
    { capperId: capA, sport: mlb, betType: "MONEYLINE", odds: -150, status: "PUSH", gameTime: t(570), createdAt: ct(570) },
    { capperId: capA, sport: mlb, betType: "MONEYLINE", odds: -150, status: "WIN", gameTime: t(560), createdAt: ct(560) },
    { capperId: capA, sport: mlb, betType: "MONEYLINE", odds: -150, status: "WIN", gameTime: t(550), createdAt: ct(550) },
    // NFL moneyline, same category key family but a different league - feeds
    // the "overall vs league" split and sport-name case sensitivity.
    { capperId: capA, sport: nfl, betType: "MONEYLINE", odds: 120, status: "WIN", gameTime: t(540), createdAt: ct(540) },
    { capperId: capA, sport: nfl, betType: "MONEYLINE", odds: 120, status: "LOSS", gameTime: t(530), createdAt: ct(530) },
    // A TOTAL with no over/under direction text - pickCategory returns null.
    // Still a decided (WIN) pick, so it must still count toward streak/last20
    // (design doc §3.3) despite having no category.
    { capperId: capA, sport: mlb, betType: "TOTAL", betDetail: null, odds: -110, status: "WIN", gameTime: t(500), createdAt: ct(500) },
    // A PENDING and a CANCELLED pick - neither should move any output.
    { capperId: capA, sport: mlb, betType: "MONEYLINE", odds: -150, status: "PENDING", gameTime: t(10), createdAt: ct(10) },
    { capperId: capA, sport: mlb, betType: "MONEYLINE", odds: -150, status: "CANCELLED", gameTime: t(5), createdAt: ct(5) },
  ]);

  // ---------------- Capper T: same-gameTime tie at the streak's edge ----------------
  // Two picks share one gameTime; the older-createdAt one is a WIN, the
  // newer-createdAt one is a LOSS. ORDER_DESC (gameTime, createdAt, id DESC)
  // ranks the newer-createdAt row "most recent", so the streak should be
  // "LOSS x1", not whatever physical insertion order would have given the
  // old path.
  const capT = await makeCapper(U, `${PREFIX}capT`);
  const tieGameTime = t(300);
  await addPicks(U, [
    { capperId: capT, sport: mlb, betType: "MONEYLINE", odds: -110, status: "WIN", gameTime: t(310), createdAt: ct(310) },
    { capperId: capT, sport: mlb, betType: "MONEYLINE", odds: -110, status: "WIN", gameTime: tieGameTime, createdAt: ct(301) }, // older createdAt of the tie
    { capperId: capT, sport: mlb, betType: "MONEYLINE", odds: -110, status: "LOSS", gameTime: tieGameTime, createdAt: ct(300) }, // newer createdAt of the tie
  ]);

  // ---------------- Last-20 boundary cappers ----------------
  function decidedRun(n: number, capperId: string, startMinutesAgo: number) {
    const specs: PickSpec[] = [];
    for (let i = 0; i < n; i++) {
      specs.push({
        capperId,
        sport: mlb,
        betType: "MONEYLINE",
        odds: -110,
        status: i % 3 === 0 ? "LOSS" : "WIN",
        gameTime: t(startMinutesAgo - i),
        createdAt: ct(startMinutesAgo - i),
      });
    }
    return specs;
  }
  const capL19 = await makeCapper(U, `${PREFIX}capL19`);
  const capL20 = await makeCapper(U, `${PREFIX}capL20`);
  const capL21 = await makeCapper(U, `${PREFIX}capL21`);
  const capL21Tie = await makeCapper(U, `${PREFIX}capL21Tie`);
  await addPicks(U, decidedRun(19, capL19, 1000));
  await addPicks(U, decidedRun(20, capL20, 1000));
  await addPicks(U, decidedRun(21, capL21, 1000));
  // 21 decided picks where the 20th and 21st (by gameTime) share a gameTime -
  // the cut must follow createdAt/id, not physical order.
  await addPicks(U, [
    ...decidedRun(19, capL21Tie, 1000),
    { capperId: capL21Tie, sport: mlb, betType: "MONEYLINE", odds: -110, status: "WIN", gameTime: t(981), createdAt: ct(985) }, // older createdAt
    { capperId: capL21Tie, sport: mlb, betType: "MONEYLINE", odds: -110, status: "LOSS", gameTime: t(981), createdAt: ct(975) }, // newer createdAt - should rank first among the tie
  ]);

  // ---------------- Category-record edge cases ----------------
  // Pending-only capper: a category record request against them must come
  // back null (no decided picks at all).
  const capPendingOnly = await makeCapper(U, `${PREFIX}capPendingOnly`);
  await addPicks(U, [{ capperId: capPendingOnly, sport: mlb, betType: "MONEYLINE", odds: -110, status: "PENDING", gameTime: t(1), createdAt: ct(1) }]);

  // A zero-picks capper: a real Capper row (the FK requires it) but NO Pick
  // rows at all - getCapperCategoryRecords / getCapperLeagueRecords never
  // join against the Capper table, so this is exactly "capper with zero picks".
  const capZeroPicks = await makeCapper(U, `${PREFIX}capZeroPicks`);

  // recent-field parity (item.recent, still populated pre-removal - Q3):
  // one category with >= CATEGORY_RECENT_FORM_MIN_SAMPLE decided picks (recent
  // populated) and one with fewer (recent stays null).
  const capRecent = await makeCapper(U, `${PREFIX}capRecent`);
  const recentSpecs: PickSpec[] = [];
  for (let i = 0; i < CATEGORY_RECENT_FORM_MIN_SAMPLE; i++) {
    recentSpecs.push({
      capperId: capRecent,
      sport: mlb,
      betType: "MONEYLINE",
      odds: -110,
      status: i < 15 ? "LOSS" : "WIN", // last CATEGORY_RECENT_FORM_WINDOW (20) are WIN, so recent != all-time
      gameTime: t(2000 - i),
      createdAt: ct(2000 - i),
    });
  }
  for (let i = 0; i < 40; i++) {
    recentSpecs.push({
      capperId: capRecent,
      sport: mlb,
      betType: "SPREAD",
      line: -3.5,
      odds: -110,
      status: "WIN",
      gameTime: t(3000 - i),
      createdAt: ct(3000 - i),
    });
  }
  await addPicks(U, recentSpecs);

  await prisma.$transaction([]); // flush

  // ============================================================
  // Parity: legacy vs new, per scenario
  // ============================================================

  const allCategoryEntries = (capperId: string, leagueSport: string) =>
    ALL_CATEGORY_KEYS.map((category) => ({ capperId, leagueSport, category }));
  const allCategoryPairs = (capperId: string) => ALL_CATEGORY_KEYS.map((category) => ({ capperId, category }));

  // capT and capL21Tie are deliberately built with a same-gameTime tie
  // straddling the streak edge / last20 cutoff (design doc §8, comparison
  // rule #1: "diffs are permitted only where... those tied picks differ in a
  // way that changes the answer"). Their `records` (order-independent) must
  // still match legacy exactly; their streaks/last20 are validated separately
  // below (against the explicit-total-order hard gate and explicit expected
  // values), NOT against the unordered legacy path, which depends on
  // whatever physical order Postgres happens to return for the tied rows.
  const tieCappers = new Set([capT, capL21Tie]);
  function sameLeagueRecords(label: string, sql: CapperLeagueRecords, legacy: CapperLeagueRecords, capperIds: string[]) {
    same(`${label} (records)`, sql.records, legacy.records);
    const untied = capperIds.filter((c) => !tieCappers.has(c));
    same(
      `${label} (streaks/last20, non-tie cappers only)`,
      untied.map((c) => ({ streak: sql.streaks[c], last20: sql.last20[c] })),
      untied.map((c) => ({ streak: legacy.streaks[c], last20: legacy.last20[c] }))
    );
  }

  // Scenario 1: each capper alone, over every (sport it has picks in) x (every
  // category), plus one category:null entry, via getCapperLeagueRecords.
  const scenario1Cappers = [capA, capT, capL19, capL20, capL21, capL21Tie, capPendingOnly, capZeroPicks, capRecent];
  for (const capperId of scenario1Cappers) {
    for (const leagueSport of [mlb, nfl, "mlb" /* lowercase - case sensitivity */]) {
      const entries = [...allCategoryEntries(capperId, leagueSport), { capperId, leagueSport, category: null as PickCategoryKey | null }];
      const legacy = await getCapperLeagueRecordsLegacy(U, entries);
      const sql = (await newPath(U, entries, [])).leagueRecords;
      sameLeagueRecords(`getCapperLeagueRecords parity: ${capperId} / ${leagueSport}`, sql, legacy, [capperId]);
    }
  }

  // Scenario 2: all cappers in one call - catches cross-capper contamination.
  {
    const entries = scenario1Cappers.flatMap((capperId) => allCategoryEntries(capperId, mlb));
    const legacy = await getCapperLeagueRecordsLegacy(U, entries);
    const sql = (await newPath(U, entries, [])).leagueRecords;
    sameLeagueRecords("getCapperLeagueRecords parity: all cappers, one call", sql, legacy, scenario1Cappers);
  }

  // Scenario 3: getCapperCategoryRecords for every (capper, category),
  // including pairs with no picks and pairs with only PENDING.
  {
    const pairs = scenario1Cappers.flatMap((capperId) => allCategoryPairs(capperId));
    const legacy = await getCapperCategoryRecordsLegacy(U, pairs);
    const sql = (await newPath(U, [], pairs)).categoryRecords;
    same("getCapperCategoryRecords parity: every (capper, category), excluding item.recent (dropped - Q3)", stripRecent(sql), stripRecent(legacy));

    // item.recent itself: legacy (frozen, unmodified) still computes it;
    // SQL does not at all (key absent, not just null) - design doc Q3, nothing
    // reads it. Documented divergence, not a parity bug - stripRecent() above
    // is why the blanket comparison still passes despite this field differing.
    const recentKey = categoryRecordKey(capRecent, "FAV_ML");
    check(
      "legacy still populates recent on a >=100-decided item (unmodified pre-migration behavior)",
      legacy[recentKey]?.recent !== null && legacy[recentKey]?.recent !== undefined,
      JSON.stringify(legacy[recentKey])
    );
    check(
      "SQL no longer computes recent at all - key absent, not just null",
      sql[recentKey] !== null && !("recent" in (sql[recentKey] ?? {})),
      JSON.stringify(sql[recentKey])
    );
  }

  // Scenario 4 (a stand-in for "replayed slates"): each pick's own stored
  // category, as a board would send it.
  {
    const picks = await prisma.pick.findMany({ where: { userId: U, capperId: { in: scenario1Cappers }, category: { not: null } } });
    const entries = picks.map((p) => ({ capperId: p.capperId, leagueSport: mlb, category: p.category as PickCategoryKey }));
    const legacy = await getCapperLeagueRecordsLegacy(U, entries);
    const sql = (await newPath(U, entries, [])).leagueRecords;
    same("getCapperLeagueRecords parity: replayed-slate entries (each pick's own category)", sql, legacy);
  }

  // Scenario 5: empty inputs.
  {
    same("getCapperLeagueRecords([]) === {} shape", (await newPath(U, [], [])).leagueRecords, { records: {}, streaks: {}, last20: {} });
    same("getCapperCategoryRecords([]) === {}", (await newPath(U, [], [])).categoryRecords, {});
  }

  // Combined bundle call (leagueEntries + categoryPairs together, one round
  // trip) - the parlay-pool-generator call-2/call-3 collapse's shape (design
  // doc §6). Verifies the combined call's two halves each still match their
  // own single-purpose parity above.
  {
    const entries = allCategoryEntries(capA, mlb);
    const pairs = allCategoryPairs(capT);
    const combined = await newPath(U, entries, pairs);
    const legacyLeague = await getCapperLeagueRecordsLegacy(U, entries);
    const legacyCategory = await getCapperCategoryRecordsLegacy(U, pairs);
    same("combined bundle call: leagueRecords half matches single-purpose call", combined.leagueRecords, legacyLeague);
    same(
      "combined bundle call: categoryRecords half matches single-purpose call, excluding item.recent",
      stripRecent(combined.categoryRecords),
      stripRecent(legacyCategory)
    );
  }

  // A requested category outside ALL_CATEGORY_KEYS -> null on both paths.
  {
    const bogus = "NOT_A_REAL_CATEGORY" as PickCategoryKey;
    const legacy = await getCapperCategoryRecordsLegacy(U, [{ capperId: capA, category: bogus }]);
    const sql = (await newPath(U, [], [{ capperId: capA, category: bogus }])).categoryRecords;
    same("category outside ALL_CATEGORY_KEYS -> null, both paths agree", sql, legacy);
    check("category outside ALL_CATEGORY_KEYS is actually null", sql[categoryRecordKey(capA, bogus)] === null);
  }

  // Unstamped row (categoryVersion = 0, category left NULL, as a pick that
  // predates the category column or slipped past createPicksWithEntitlementCheck
  // would look like): this is the ONE deliberate, documented divergence
  // between the two paths (design doc G4) - the legacy JS path re-derives the
  // category live from the pick's real betType/odds/etc fields (ignoring the
  // stored column entirely), so it still finds this MONEYLINE-favorite pick
  // under FAV_ML; the SQL path reads the STORED column only, sees NULL, and
  // correctly omits it. Production has zero such rows (E4) and Q2's static
  // guard keeps it that way going forward - this test documents why that
  // guard matters, it does not assert parity here.
  {
    const capUnstamped = await makeCapper(U, `${PREFIX}capUnstamped`);
    await addPicks(U, [
      { capperId: capUnstamped, sport: mlb, betType: "MONEYLINE", odds: -110, status: "WIN", gameTime: t(4000), createdAt: ct(4000), categoryOverride: null, categoryVersionOverride: 0 },
    ]);
    const pairs = [{ capperId: capUnstamped, category: "FAV_ML" as PickCategoryKey }];
    const legacy = await getCapperCategoryRecordsLegacy(U, pairs);
    const sql = (await newPath(U, [], pairs)).categoryRecords;
    const key = categoryRecordKey(capUnstamped, "FAV_ML");
    check("legacy still finds the unstamped row by re-deriving its category live (the divergence this migration accepts)", legacy[key]?.count === 1, JSON.stringify(legacy[key]));
    check("SQL correctly omits it - reads the stored NULL category, not the live-derived one", sql[key] === null, JSON.stringify(sql[key]));
  }

  // ============================================================
  // Order-dependent fields: the hard gate (design doc §8, comparison rule #2)
  // ============================================================
  // legacy-with-explicit-total-order: the SAME rows, tie-broken explicitly by
  // (gameTime, createdAt, id) - a one-line reference, no production change -
  // vs the SQL path. ZERO diffs required (the hard gate; comparison rule #2).
  {
    const orderedEntries = scenario1Cappers.map((capperId) => ({ capperId, leagueSport: mlb, category: null as PickCategoryKey | null }));
    const sql = (await newPath(U, orderedEntries, [])).leagueRecords;
    for (const capperId of scenario1Cappers) {
      const ref = await explicitOrderStreakAndLast20(U, capperId);
      same(`streak, explicit-total-order vs SQL: ${capperId}`, sql.streaks[capperId], ref.streak);
      same(`last20, explicit-total-order vs SQL: ${capperId}`, sql.last20[capperId], ref.last20);
    }
  }

  // Explicit streak-tie and last20-tie assertions (not just "parity holds" -
  // the actual expected values, per ORDER_DESC).
  {
    const sql = (await newPath(U, [{ capperId: capT, leagueSport: mlb, category: null }], [])).leagueRecords;
    same("streak tie resolves to the newer-createdAt row (LOSS x1)", sql.streaks[capT], { type: "LOSS", count: 1 });
  }
  {
    const sql = (await newPath(U, [{ capperId: capL21Tie, leagueSport: mlb, category: null }], [])).leagueRecords;
    // The 20th (by the canonical order) is the newer-createdAt tied pick (LOSS);
    // count = 19 non-tied WIN/LOSS-alternating picks (indices 0..18, LOSS at
    // i%3===0) plus this one LOSS, decided total 21 (>= LEAGUE_RECORD_LAST_N).
    check(`last20 tie: capperL21Tie has a present (non-null) last20`, sql.last20[capL21Tie] !== null);
    same(`last20 tie: count is exactly LEAGUE_RECORD_LAST_N`, sql.last20[capL21Tie]?.count, LEAGUE_RECORD_LAST_N);
  }

  // Boundary counts, explicit values.
  {
    const sql19 = (await newPath(U, [{ capperId: capL19, leagueSport: mlb, category: null }], [])).leagueRecords;
    const sql20 = (await newPath(U, [{ capperId: capL20, leagueSport: mlb, category: null }], [])).leagueRecords;
    const sql21 = (await newPath(U, [{ capperId: capL21, leagueSport: mlb, category: null }], [])).leagueRecords;
    same("last20: 19 decided -> null", sql19.last20[capL19], null);
    same("last20: 20 decided -> present, count 20", sql20.last20[capL20]?.count, LEAGUE_RECORD_LAST_N);
    same("last20: 21 decided -> present, count 20 (cut)", sql21.last20[capL21]?.count, LEAGUE_RECORD_LAST_N);
  }

  // NULL-category row still counts toward streak/last20.
  {
    const sql = (await newPath(U, [{ capperId: capA, leagueSport: mlb, category: null }], [])).leagueRecords;
    const legacy = await getCapperLeagueRecordsLegacy(U, [{ capperId: capA, leagueSport: mlb, category: null }]);
    same("NULL-category pick still counts toward streak/last20 (parity)", sql.streaks[capA], legacy.streaks[capA]);
    check("capA's streak reflects the NULL-category WIN as its most recent decided pick", sql.streaks[capA].type === "WIN" && sql.streaks[capA].count >= 1);
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
  for (const id of createdSportIds) {
    const { count } = await prisma.sport.deleteMany({ where: { id } });
    deletedSports += count;
  }
  const after = { users: await prisma.user.count(), picks: await prisma.pick.count(), sports: await prisma.sport.count() };
  console.log(`cleanup: deleted ${deletedUsers} user(s), ${deletedSports} sport(s). DB after: users=${after.users} picks=${after.picks} sports=${after.sports}`);
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
