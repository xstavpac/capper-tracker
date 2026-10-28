// Parity test for collapsing record-bundle calls: Auto-Generate
// (parlay-generator.ts) used to call getCapperLeagueRecords and
// getCapperCategoryRecords separately, and the slip's Hedge/Contrarian
// (parlay-pool-generator.ts) did the same after building its primary. Both now
// make ONE getCapperRecordBundle call with both request lists and take
// { leagueRecords, categoryRecords } from it. The actions do nothing else with
// the result, so the whole change rests on one property, asserted here:
//
//   getCapperRecordBundle(u, { leagueEntries: E, categoryPairs: P })
//     === { leagueRecords: getCapperLeagueRecords(u, E), categoryRecords: getCapperCategoryRecords(u, P) }
//
// byte-for-byte (same keys, same values, nulls included), for the generator's
// request shape (pairs drawn from the same picks as the entries), the Hedge's
// (entries = pool + alternates, pairs = alternates only), edge cases (null
// categories, duplicates, a category outside ALL_CATEGORY_KEYS, a capper that is
// only in the pairs, either list empty) and 60 seeded random requests. It also
// asserts the merged form is one database round trip where the old was two.
//
// DB-backed and WRITING: every id is prefixed `__BundleMerge__` and deleted by
// exact id at the end. Refuses to run unless DATABASE_URL points at localhost.
//   npx tsx src/server/data/record-bundle-merge-parity-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { pickCategory, PICK_CATEGORY_VERSION, type PickCategoryKey } from "@/server/data/stats";
import { getCapperRecordBundle, getCapperLeagueRecords, getCapperCategoryRecords, type CapperRecordBundleRequest } from "@/server/data/picks";

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
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}
function canon(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(canon);
  if (x && typeof x === "object") {
    return Object.fromEntries(
      Object.entries(x as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, canon(v)])
    );
  }
  return x;
}
const json = (x: unknown) => JSON.stringify(canon(x));

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PREFIX = "__BundleMerge__";
const created = { users: [] as string[], cappers: [] as string[], picks: [] as string[], sports: [] as string[] };
const DAY = 86400000;
const T0 = Date.now() - 400 * DAY;

async function sportId(name: string) {
  const existing = await prisma.sport.findUnique({ where: { name } });
  if (existing) return existing.id;
  const s = await prisma.sport.create({ data: { name } });
  created.sports.push(s.id);
  return s.id;
}

type Spec = { betType: Prisma.PickCreateManyInput["betType"]; period?: Prisma.PickCreateManyInput["period"]; betDetail: string; odds: number; line?: number | null; propMarket?: Prisma.PickCreateManyInput["propMarket"] };
const SPECS: Spec[] = [
  { betType: "MONEYLINE", betDetail: "Home ML", odds: -150 },
  { betType: "MONEYLINE", betDetail: "Away ML", odds: 130 },
  { betType: "SPREAD", betDetail: "Away +3.5", odds: -110, line: 3.5 },
  { betType: "SPREAD", betDetail: "Home -3.5", odds: -110, line: -3.5 },
  { betType: "TOTAL", betDetail: "Over 44.5", odds: -105, line: 44.5 },
  { betType: "TOTAL", betDetail: "Under 44.5", odds: -105, line: 44.5 },
  { betType: "MONEYLINE", period: "FIRST_HALF", betDetail: "Home 1H ML", odds: 115 },
  { betType: "PLAYER_PROP", betDetail: "J. Doe over 60.5 rushing yards", odds: -115, propMarket: "RUSH_YDS" },
];
const STATUSES = ["WIN", "LOSS", "PUSH", "WIN", "LOSS", "PENDING", "CANCELLED", "WIN"] as const;

async function main() {
  const sports = [
    { id: await sportId("NFL"), name: "NFL" },
    { id: await sportId("MLB"), name: "MLB" },
  ];
  const userId = PREFIX + "user";
  await prisma.user.create({ data: { id: userId, supabaseId: userId + "-sb", email: userId + "@example.invalid" } });
  created.users.push(userId);
  const cappers: string[] = [];
  for (let i = 0; i < 7; i++) {
    const id = `${PREFIX}capper-${i}`;
    await prisma.capper.create({ data: { id, userId, name: `${PREFIX}C${i}`, source: "OTHER" } });
    cappers.push(id);
    created.cappers.push(id);
  }

  // Varied history: capper i gets 15 + 9i picks across both sports and every
  // spec, with streak-making runs and some gameTime ties (createdAt/id break them).
  const rand = seeded(7);
  const rows: Prisma.PickCreateManyInput[] = [];
  let seq = 0;
  for (const [ci, capperId] of cappers.entries()) {
    if (ci === 6) continue; // capper 6 has no picks at all
    const n = 15 + 9 * ci;
    for (let k = 0; k < n; k++) {
      seq++;
      const spec = SPECS[Math.floor(rand() * SPECS.length)];
      const sport = sports[k % 3 === 0 ? 1 : 0];
      const status = k >= n - 4 && ci % 2 === 0 ? "WIN" : STATUSES[Math.floor(rand() * STATUSES.length)];
      const gameTime = new Date(T0 + Math.floor(k / 2) * DAY); // pairs share a gameTime
      const base = { betType: spec.betType, period: spec.period ?? "FULL_GAME", betDetail: spec.betDetail, odds: spec.odds, line: spec.line ?? null, propMarket: spec.propMarket ?? null, pickedSide: null, mlFavoredSide: null };
      const id = `${PREFIX}p-${ci}-${k}`;
      created.picks.push(id);
      rows.push({
        id,
        userId,
        capperId,
        sportId: sport.id,
        homeTeam: "Home",
        awayTeam: "Away",
        ...base,
        units: 1,
        gameTime,
        datePosted: gameTime,
        status,
        gradedAt: status === "PENDING" || status === "CANCELLED" ? null : new Date(gameTime.getTime() + 4 * 3600000),
        createdAt: new Date(T0 + seq * 1000),
        category: pickCategory({ ...base, sportName: sport.name }),
        categoryVersion: PICK_CATEGORY_VERSION,
      });
    }
  }
  await prisma.pick.createMany({ data: rows });
  const cats = Array.from(new Set(rows.map((r) => r.category).filter((c): c is string => !!c))) as PickCategoryKey[];
  console.log(`fixture: ${rows.length} picks, ${cappers.length} cappers, ${cats.length} categories\n`);

  // Count database round trips per form.
  let rawCalls = 0;
  const originalRaw = prisma.$queryRaw.bind(prisma);
  (prisma as unknown as { $queryRaw: unknown }).$queryRaw = ((...args: Parameters<typeof prisma.$queryRaw>) => {
    rawCalls++;
    return originalRaw(...args);
  }) as unknown as typeof prisma.$queryRaw;

  async function compare(label: string, req: CapperRecordBundleRequest, expectCalls = true) {
    rawCalls = 0;
    const merged = await getCapperRecordBundle(userId, req);
    const mergedCalls = rawCalls;
    rawCalls = 0;
    const [leagueRecords, categoryRecords] = [await getCapperLeagueRecords(userId, req.leagueEntries), await getCapperCategoryRecords(userId, req.categoryPairs)];
    const separateCalls = rawCalls;
    // No prop entries in these requests, so no per-market prop records.
    const ok = json(merged) === json({ leagueRecords, categoryRecords, propMarketRecords: {} });
    check(label, ok, ok ? "" : `merged=${json(merged).slice(0, 300)} separate=${json({ leagueRecords, categoryRecords }).slice(0, 300)}`);
    if (expectCalls && req.leagueEntries.length > 0 && req.categoryPairs.length > 0) {
      check(label + " - one round trip instead of two", mergedCalls === 1 && separateCalls === 2, `merged ${mergedCalls}, separate ${separateCalls}`);
    }
    return merged;
  }

  // A "slate" of picks as the actions see them: capper, league, category.
  type SlatePick = { capperId: string; leagueName: string; category: PickCategoryKey | null };
  const slate = (picks: SlatePick[]): CapperRecordBundleRequest => ({
    leagueEntries: picks.map((p) => ({ capperId: p.capperId, leagueSport: p.leagueName, category: p.category })),
    categoryPairs: picks.filter((p): p is SlatePick & { category: PickCategoryKey } => p.category !== null).map((p) => ({ capperId: p.capperId, category: p.category })),
  });
  const pick = (ci: number, league: string, category: PickCategoryKey | null): SlatePick => ({ capperId: cappers[ci], leagueName: league, category });

  // ---- 1. Auto-Generate's shape: entries and pairs from the same picks --------
  const genPicks = [pick(0, "NFL", "FAV_ML"), pick(1, "NFL", "DOG_ML"), pick(2, "NFL", "OVER"), pick(3, "MLB", "F5_ML"), pick(4, "NFL", null), pick(5, "NFL", "RUSH_YDS_PROP"), pick(0, "NFL", "FAV_ML"), pick(1, "MLB", "UNDER")];
  const gen = await compare("1. Auto-Generate shape (duplicates, a null category, two leagues)", slate(genPicks));
  check("1'. coverage: real records, streaks and a last-20 came back", Object.values(gen.leagueRecords.records).some((r) => r !== null) && Object.values(gen.categoryRecords).some((r) => r !== null) && Object.values(gen.leagueRecords.streaks).some((s) => s.type !== "NONE") && Object.values(gen.leagueRecords.last20).some((l) => l !== null));

  // ---- 2. Slip Hedge's shape: entries = pool + alternates, pairs = alternates -
  const pool = [pick(0, "NFL", "FAV_ML"), pick(6, "NFL", "DOG_ML")];
  const alternates = [pick(2, "NFL", "SPREAD_PLUS"), pick(3, "NFL", "UNDER"), pick(5, "NFL", null)];
  const hedgeReq = slate([...pool, ...alternates]);
  await compare("2. slip Hedge shape (pool + alternates, pairs from alternates only, a capper with no picks)", {
    leagueEntries: hedgeReq.leagueEntries,
    categoryPairs: slate(alternates).categoryPairs,
  });

  // ---- 3. Edge cases --------------------------------------------------------------
  await compare("3a. a capper only in the pairs never shows in streaks/last20", { leagueEntries: [pick(0, "NFL", "FAV_ML")].map((p) => ({ capperId: p.capperId, leagueSport: p.leagueName, category: p.category })), categoryPairs: [{ capperId: cappers[4], category: "OVER" }] });
  await compare("3b. a category outside ALL_CATEGORY_KEYS still gets its null key", { leagueEntries: [{ capperId: cappers[1], leagueSport: "NFL", category: "NOT_A_CATEGORY" as PickCategoryKey }], categoryPairs: [{ capperId: cappers[1], category: "NOT_A_CATEGORY" as PickCategoryKey }] });
  await compare("3c. empty pairs", { leagueEntries: slate(genPicks).leagueEntries, categoryPairs: [] });
  await compare("3d. empty entries", { leagueEntries: [], categoryPairs: slate(genPicks).categoryPairs });
  await compare("3e. both empty", { leagueEntries: [], categoryPairs: [] });

  // ---- 4. Seeded random requests in both shapes ------------------------------------
  const r = seeded(20261019);
  const leagues = ["NFL", "MLB"];
  let randomFails = 0;
  for (let i = 0; i < 60; i++) {
    const n = 1 + Math.floor(r() * 14);
    const picks = Array.from({ length: n }, () => pick(Math.floor(r() * cappers.length), leagues[Math.floor(r() * 2)], r() < 0.15 ? null : cats[Math.floor(r() * cats.length)]));
    const req = slate(picks);
    if (i % 2 === 1) {
      const cut = Math.floor(r() * picks.length);
      req.categoryPairs = slate(picks.slice(cut)).categoryPairs;
    }
    const merged = await getCapperRecordBundle(userId, req);
    const separate = { leagueRecords: await getCapperLeagueRecords(userId, req.leagueEntries), categoryRecords: await getCapperCategoryRecords(userId, req.categoryPairs), propMarketRecords: {} };
    if (json(merged) !== json(separate)) {
      randomFails++;
      if (randomFails <= 3) console.log(`   random #${i} differs: ${json(req).slice(0, 200)}`);
    }
  }
  check("4. 60 seeded random requests (both shapes): merged === separate every time", randomFails === 0, `${randomFails} differ`);

  (prisma as unknown as { $queryRaw: unknown }).$queryRaw = originalRaw;
}

async function cleanup() {
  const picks = (await prisma.pick.deleteMany({ where: { id: { in: created.picks } } })).count;
  const cappers = (await prisma.capper.deleteMany({ where: { id: { in: created.cappers } } })).count;
  const users = (await prisma.user.deleteMany({ where: { id: { in: created.users } } })).count;
  const sports = (await prisma.sport.deleteMany({ where: { id: { in: created.sports } } })).count;
  console.log(`\ncleanup: deleted ${picks} picks, ${cappers} cappers, ${users} users, ${sports} sports`);
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(async () => {
    await cleanup().catch((e) => {
      console.error("cleanup failed", e);
      failures++;
    });
    await prisma.$disconnect();
    console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  });
