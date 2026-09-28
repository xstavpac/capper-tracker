// Behavior-preservation test for getCapperPanels' caching + relation narrowing.
//
// The GOLDEN blocks below were captured by running the ORIGINAL implementation
// (always `include: { sport: true }`, uncached) against this exact fixture
// before the change. The new implementation must reproduce them byte for byte,
// unfiltered, with a sportName filter, and with a category filter. It also
// asserts the query shape (no relation join unless a category filter needs
// sport.name) and that cache keys never collide across users/filters.
//
// DB-backed and WRITING: creates its own user/cappers/picks (ids prefixed
// `__PanelsCache__`) and deletes them by exact id at the end. Refuses to run
// unless DATABASE_URL points at localhost. Run against a disposable local
// Postgres with migrations applied:
//   DATABASE_URL=postgresql://postgres@localhost:54329/capper_pr_c \
//   DIRECT_URL=postgresql://postgres@localhost:54329/capper_pr_c \
//   npx tsx src/server/data/capper-panels-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { getCapperPanels, capperPanelsCacheKey } from "@/server/data/capper-panels";
import { cacheKeys } from "@/lib/cache-keys";

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

const PREFIX = "__PanelsCache__";
const T0 = Date.now();
const HOUR = 3600000;
const DAY = 24 * HOUR;

let seq = 0;
type Row = Prisma.PickCreateManyInput;

// `results` is oldest -> newest. Each pick's gradedAt strictly increases, so
// the "most recently graded first" ordering the panels use is unambiguous.
function picksFor(
  userId: string,
  capperId: string,
  sportId: string,
  results: ("WIN" | "LOSS" | "PUSH" | "PENDING")[],
  opts: { postedAgoDays: number; odds?: number; betType?: "MONEYLINE" | "SPREAD"; line?: number }
): Row[] {
  return results.map((status, i) => {
    seq++;
    const gradedAt = new Date(T0 - (results.length - i) * HOUR * 2);
    const betType = opts.betType ?? "MONEYLINE";
    return {
      id: `${PREFIX}pick-${seq}`,
      userId,
      capperId,
      sportId,
      homeTeam: "Home",
      awayTeam: "Away",
      betType,
      betDetail: null,
      odds: opts.odds ?? -120,
      line: betType === "SPREAD" ? opts.line ?? -3.5 : null,
      period: "FULL_GAME",
      units: 1 + (i % 3) * 0.5,
      datePosted: new Date(T0 - opts.postedAgoDays * DAY - i * 1000),
      gameTime: new Date(gradedAt.getTime() - 3 * HOUR),
      status,
      gradedAt: status === "PENDING" ? null : gradedAt,
      createdAt: new Date(T0 - seq * 1000),
    };
  });
}

const W = "WIN" as const;
const L = "LOSS" as const;
const P = "PUSH" as const;
const X = "PENDING" as const;

// ---- GOLDEN (captured from the original implementation) ---------------------
const GOLDEN_UNFILTERED: unknown = {"hotStreaks":[{"capperId":"__PanelsCache__c-rising","name":"Rising Rita","colorTag":null,"streakCount":8,"weightedScore":-3.93,"stats":{"wins":8,"losses":8,"pushes":0,"winPct":50,"unitsWon":10,"unitsLost":11.5,"netUnits":-1.5,"roi":-6.38,"currentStreak":{"type":"WIN","count":8},"longestWinStreak":8,"longestLossStreak":8}},{"capperId":"__PanelsCache__c-hot","name":"Hot Hand","colorTag":"#ff0000","streakCount":2,"weightedScore":10.16,"stats":{"wins":8,"losses":4,"pushes":0,"winPct":66.66666666666666,"unitsWon":9.17,"unitsLost":6,"netUnits":3.17,"roi":18.63,"currentStreak":{"type":"WIN","count":2},"longestWinStreak":3,"longestLossStreak":1}}],"coolingOff":[{"capperId":"__PanelsCache__c-fall","name":"Falling Fred","colorTag":null,"streakCount":10,"weightedScore":15.14,"stats":{"wins":20,"losses":10,"pushes":0,"winPct":66.66666666666666,"unitsWon":24.58,"unitsLost":15.5,"netUnits":9.08,"roi":20.19,"currentStreak":{"type":"LOSS","count":10},"longestWinStreak":20,"longestLossStreak":10}},{"capperId":"__PanelsCache__c-cold","name":"Cold Cat","colorTag":null,"streakCount":4,"weightedScore":-11.98,"stats":{"wins":3,"losses":5,"pushes":0,"winPct":37.5,"unitsWon":4.9,"unitsLost":8,"netUnits":-3.1,"roi":-26.96,"currentStreak":{"type":"LOSS","count":4},"longestWinStreak":2,"longestLossStreak":4}}],"rising":[{"capperId":"__PanelsCache__c-rising","name":"Rising Rita","colorTag":null,"previousWinPct":60,"recentWinPct":100,"risePts":40}],"fallingOff":[{"capperId":"__PanelsCache__c-fall","name":"Falling Fred","colorTag":null,"lifetimeWinPct":66.67,"recentWinPct":0,"dropPts":66.67},{"capperId":"__PanelsCache__c-nfl","name":"Nfl Nate","colorTag":null,"lifetimeWinPct":80,"recentWinPct":70,"dropPts":10}],"bestLast20":[{"capperId":"__PanelsCache__c-hot","name":"Hot Hand","colorTag":"#ff0000","wins":8,"losses":4,"pushes":0,"recentWinPct":66.67,"weightedScore":60.18},{"capperId":"__PanelsCache__c-nfl","name":"Nfl Nate","colorTag":null,"wins":8,"losses":2,"pushes":2,"recentWinPct":66.67,"weightedScore":60.18},{"capperId":"__PanelsCache__c-rising","name":"Rising Rita","colorTag":null,"wins":8,"losses":8,"pushes":0,"recentWinPct":50,"weightedScore":50.92},{"capperId":"__PanelsCache__c-fall","name":"Falling Fred","colorTag":null,"wins":10,"losses":10,"pushes":0,"recentWinPct":50,"weightedScore":50.8}],"worstLast20":[{"capperId":"__PanelsCache__c-fall","name":"Falling Fred","colorTag":null,"wins":10,"losses":10,"pushes":0,"recentWinPct":50,"weightedScore":50.8},{"capperId":"__PanelsCache__c-rising","name":"Rising Rita","colorTag":null,"wins":8,"losses":8,"pushes":0,"recentWinPct":50,"weightedScore":50.92},{"capperId":"__PanelsCache__c-hot","name":"Hot Hand","colorTag":"#ff0000","wins":8,"losses":4,"pushes":0,"recentWinPct":66.67,"weightedScore":60.18},{"capperId":"__PanelsCache__c-nfl","name":"Nfl Nate","colorTag":null,"wins":8,"losses":2,"pushes":2,"recentWinPct":66.67,"weightedScore":60.18}]};
const GOLDEN_SPORT_MLB: unknown = {"hotStreaks":[{"capperId":"__PanelsCache__c-rising","name":"Rising Rita","colorTag":null,"streakCount":8,"weightedScore":-3.93,"stats":{"wins":8,"losses":8,"pushes":0,"winPct":50,"unitsWon":10,"unitsLost":11.5,"netUnits":-1.5,"roi":-6.38,"currentStreak":{"type":"WIN","count":8},"longestWinStreak":8,"longestLossStreak":8}},{"capperId":"__PanelsCache__c-hot","name":"Hot Hand","colorTag":"#ff0000","streakCount":4,"weightedScore":10.06,"stats":{"wins":7,"losses":3,"pushes":0,"winPct":70,"unitsWon":7.92,"unitsLost":5,"netUnits":2.92,"roi":20.11,"currentStreak":{"type":"WIN","count":4},"longestWinStreak":4,"longestLossStreak":1}}],"coolingOff":[{"capperId":"__PanelsCache__c-fall","name":"Falling Fred","colorTag":null,"streakCount":10,"weightedScore":15.14,"stats":{"wins":20,"losses":10,"pushes":0,"winPct":66.66666666666666,"unitsWon":24.58,"unitsLost":15.5,"netUnits":9.08,"roi":20.19,"currentStreak":{"type":"LOSS","count":10},"longestWinStreak":20,"longestLossStreak":10}},{"capperId":"__PanelsCache__c-cold","name":"Cold Cat","colorTag":null,"streakCount":4,"weightedScore":-11.98,"stats":{"wins":3,"losses":5,"pushes":0,"winPct":37.5,"unitsWon":4.9,"unitsLost":8,"netUnits":-3.1,"roi":-26.96,"currentStreak":{"type":"LOSS","count":4},"longestWinStreak":2,"longestLossStreak":4}}],"rising":[{"capperId":"__PanelsCache__c-rising","name":"Rising Rita","colorTag":null,"previousWinPct":60,"recentWinPct":100,"risePts":40}],"fallingOff":[{"capperId":"__PanelsCache__c-fall","name":"Falling Fred","colorTag":null,"lifetimeWinPct":66.67,"recentWinPct":0,"dropPts":66.67}],"bestLast20":[{"capperId":"__PanelsCache__c-hot","name":"Hot Hand","colorTag":"#ff0000","wins":7,"losses":3,"pushes":0,"recentWinPct":70,"weightedScore":61.2},{"capperId":"__PanelsCache__c-rising","name":"Rising Rita","colorTag":null,"wins":8,"losses":8,"pushes":0,"recentWinPct":50,"weightedScore":50.92},{"capperId":"__PanelsCache__c-fall","name":"Falling Fred","colorTag":null,"wins":10,"losses":10,"pushes":0,"recentWinPct":50,"weightedScore":50.8}],"worstLast20":[{"capperId":"__PanelsCache__c-fall","name":"Falling Fred","colorTag":null,"wins":10,"losses":10,"pushes":0,"recentWinPct":50,"weightedScore":50.8},{"capperId":"__PanelsCache__c-rising","name":"Rising Rita","colorTag":null,"wins":8,"losses":8,"pushes":0,"recentWinPct":50,"weightedScore":50.92},{"capperId":"__PanelsCache__c-hot","name":"Hot Hand","colorTag":"#ff0000","wins":7,"losses":3,"pushes":0,"recentWinPct":70,"weightedScore":61.2}]};
const GOLDEN_CATEGORY_FAV_ML: unknown = {"hotStreaks":[{"capperId":"__PanelsCache__c-rising","name":"Rising Rita","colorTag":null,"streakCount":8,"weightedScore":-3.93,"stats":{"wins":8,"losses":8,"pushes":0,"winPct":50,"unitsWon":10,"unitsLost":11.5,"netUnits":-1.5,"roi":-6.38,"currentStreak":{"type":"WIN","count":8},"longestWinStreak":8,"longestLossStreak":8}},{"capperId":"__PanelsCache__c-hot","name":"Hot Hand","colorTag":"#ff0000","streakCount":2,"weightedScore":10.16,"stats":{"wins":8,"losses":4,"pushes":0,"winPct":66.66666666666666,"unitsWon":9.17,"unitsLost":6,"netUnits":3.17,"roi":18.63,"currentStreak":{"type":"WIN","count":2},"longestWinStreak":3,"longestLossStreak":1}}],"coolingOff":[],"rising":[{"capperId":"__PanelsCache__c-rising","name":"Rising Rita","colorTag":null,"previousWinPct":60,"recentWinPct":100,"risePts":40}],"fallingOff":[{"capperId":"__PanelsCache__c-nfl","name":"Nfl Nate","colorTag":null,"lifetimeWinPct":80,"recentWinPct":70,"dropPts":10}],"bestLast20":[{"capperId":"__PanelsCache__c-hot","name":"Hot Hand","colorTag":"#ff0000","wins":8,"losses":4,"pushes":0,"recentWinPct":66.67,"weightedScore":60.18},{"capperId":"__PanelsCache__c-nfl","name":"Nfl Nate","colorTag":null,"wins":8,"losses":2,"pushes":2,"recentWinPct":66.67,"weightedScore":60.18},{"capperId":"__PanelsCache__c-rising","name":"Rising Rita","colorTag":null,"wins":8,"losses":8,"pushes":0,"recentWinPct":50,"weightedScore":50.92}],"worstLast20":[{"capperId":"__PanelsCache__c-rising","name":"Rising Rita","colorTag":null,"wins":8,"losses":8,"pushes":0,"recentWinPct":50,"weightedScore":50.92},{"capperId":"__PanelsCache__c-hot","name":"Hot Hand","colorTag":"#ff0000","wins":8,"losses":4,"pushes":0,"recentWinPct":66.67,"weightedScore":60.18},{"capperId":"__PanelsCache__c-nfl","name":"Nfl Nate","colorTag":null,"wins":8,"losses":2,"pushes":2,"recentWinPct":66.67,"weightedScore":60.18}]};

async function main() {
  const userId = `${PREFIX}user`;
  await prisma.user.create({ data: { id: userId, supabaseId: `${PREFIX}sb`, email: `${PREFIX}u@example.invalid` } });

  const createdSportIds: string[] = [];
  const sportIds: Record<string, string> = {};
  for (const name of ["MLB", "NFL"]) {
    const existing = await prisma.sport.findUnique({ where: { name } });
    if (existing) sportIds[name] = existing.id;
    else {
      const s = await prisma.sport.create({ data: { name } });
      createdSportIds.push(s.id);
      sportIds[name] = s.id;
    }
  }

  const cappers = [
    { key: "hot", name: "Hot Hand" },
    { key: "cold", name: "Cold Cat" },
    { key: "rising", name: "Rising Rita" },
    { key: "fall", name: "Falling Fred" },
    { key: "idle", name: "Idle Ivan" },
    { key: "nfl", name: "Nfl Nate" },
  ];
  const capperId = (k: string) => `${PREFIX}c-${k}`;
  for (const c of cappers) {
    await prisma.capper.create({ data: { id: capperId(c.key), userId, name: c.name, source: "OTHER", colorTag: c.key === "hot" ? "#ff0000" : null } });
  }

  const rows: Row[] = [
    // Hot: long win streak at the end, mixed before.
    ...picksFor(userId, capperId("hot"), sportIds.MLB, [L, W, L, W, W, L, W, W, W, W], { postedAgoDays: 1 }),
    // Cold: loss streak at the end.
    ...picksFor(userId, capperId("cold"), sportIds.MLB, [W, W, L, W, L, L, L, L], { postedAgoDays: 2, odds: 140 }),
    // Rising: newest 8 all wins, prior 8 all losses (5- and 8-windows both clear +10).
    ...picksFor(userId, capperId("rising"), sportIds.MLB, [L, L, L, L, L, L, L, L, W, W, W, W, W, W, W, W], { postedAgoDays: 1 }),
    // Falling: 20 older wins then 10 straight losses (lifetime high, recent 10 poor).
    ...picksFor(userId, capperId("fall"), sportIds.MLB, [...Array(20).fill(W), ...Array(10).fill(L)], { postedAgoDays: 3, betType: "SPREAD" }),
    // Idle: plenty of picks, none posted inside the 14-day activity window.
    ...picksFor(userId, capperId("idle"), sportIds.MLB, [W, W, W, L, W, W], { postedAgoDays: 30 }),
    // NFL-only capper with pushes and a pending pick, also mixed in MLB elsewhere above.
    ...picksFor(userId, capperId("nfl"), sportIds.NFL, [W, P, W, W, L, W, X, W, W, P, W, L, W], { postedAgoDays: 1 }),
    // Hot also has a couple of NFL picks so a sportName filter changes its numbers.
    ...picksFor(userId, capperId("hot"), sportIds.NFL, [L, W], { postedAgoDays: 1 }),
  ];
  await prisma.pick.createMany({ data: rows });

  // Record how each call queries the pick table.
  type FindManyArgs = Parameters<typeof prisma.pick.findMany>[0];
  const seen: FindManyArgs[] = [];
  const originalFindMany = prisma.pick.findMany.bind(prisma.pick);
  (prisma.pick as unknown as { findMany: unknown }).findMany = (args: FindManyArgs) => {
    seen.push(args);
    return originalFindMany(args as never);
  };

  try {
    const unfiltered = await getCapperPanels(userId);
    const sportMlb = await getCapperPanels(userId, { sportName: "MLB" });
    const categoryFavMl = await getCapperPanels(userId, { category: "FAV_ML" });

    if (GOLDEN_UNFILTERED === null || GOLDEN_SPORT_MLB === null || GOLDEN_CATEGORY_FAV_ML === null) {
      console.log("CAPTURE (no golden embedded yet):");
      console.log(JSON.stringify({ unfiltered, sportMlb, categoryFavMl }));
      process.exitCode = 2;
      return;
    }

    check("unfiltered output identical to original implementation", JSON.stringify(unfiltered) === JSON.stringify(GOLDEN_UNFILTERED));
    check("sportName=MLB output identical to original implementation", JSON.stringify(sportMlb) === JSON.stringify(GOLDEN_SPORT_MLB));
    check("category=FAV_ML output identical to original implementation", JSON.stringify(categoryFavMl) === JSON.stringify(GOLDEN_CATEGORY_FAV_ML));

    const panelHasEntries = (p: typeof unfiltered) =>
      p.hotStreaks.length > 0 && p.coolingOff.length > 0 && p.rising.length > 0 && p.fallingOff.length > 0 && p.bestLast20.length > 0;
    check("fixture exercises hot, cooling, rising, falling-off and best/worst panels", panelHasEntries(unfiltered));
    check(
      "inactive capper is excluded and NFL filter changes the numbers",
      !unfiltered.bestLast20.some((e) => e.name === "Idle Ivan") &&
        JSON.stringify(unfiltered) !== JSON.stringify(sportMlb)
    );

    // Query shape. Calls that hit the pick table directly for panels have a
    // capperId `in` filter; getCappersForUser's membership scan does not.
    const panelQueries = seen.filter((a) => a?.where && "capperId" in (a.where as object));
    check("three panel queries were issued", panelQueries.length === 3, `got ${panelQueries.length}`);
    check("unfiltered panel query joins no relation", panelQueries[0]?.include === undefined && panelQueries[0]?.select === undefined);
    check("sportName-only panel query joins no relation (filter lives in where)", panelQueries[1]?.include === undefined && panelQueries[1]?.select === undefined);
    check(
      "category panel query joins only sport.name",
      JSON.stringify(panelQueries[2]?.include) === JSON.stringify({ sport: { select: { name: true } } })
    );

    // Cache keys: distinct per user and per filter, and never the dashboard tag.
    const keys = [
      capperPanelsCacheKey("u1"),
      capperPanelsCacheKey("u2"),
      capperPanelsCacheKey("u1", { sportName: "MLB" }),
      capperPanelsCacheKey("u1", { sportName: "NFL" }),
      capperPanelsCacheKey("u1", { category: "FAV_ML" }),
      capperPanelsCacheKey("u1", { sportName: "MLB", category: "FAV_ML" }),
    ];
    check("cache keys are unique per user and filter", new Set(keys).size === keys.length);
    check("cache keys never equal the dashboard tag", !keys.includes(cacheKeys.dashboard("u1")) && !keys.includes(cacheKeys.dashboard("u2")));
    check("undefined filter and empty filter share a key", capperPanelsCacheKey("u1") === capperPanelsCacheKey("u1", {}));
  } finally {
    (prisma.pick as unknown as { findMany: unknown }).findMany = originalFindMany;
    await prisma.pick.deleteMany({ where: { userId } });
    await prisma.capper.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    if (createdSportIds.length) await prisma.sport.deleteMany({ where: { id: { in: createdSportIds } } });
  }
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(async () => {
    await prisma.$disconnect();
    if (failures > 0) process.exit(1);
    if (process.exitCode === 2) process.exit(2);
    console.log("\nAll checks passed.");
  });
