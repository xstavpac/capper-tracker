// The Heavy Consensus hit rate is the viewer's own (server/data/heavy-consensus.ts), against a real
// database and a query-logging PrismaClient installed as globalThis.prisma before any app module
// loads (lib/prisma.ts reuses it).
//
// Two users hold the SAME real-world games (same teams, same dates - one worldKey each) with
// different results:
//   1. (a) the nightly recompute stores a market per user per game, and getHeavyConsensusRate gives
//      each user their own rate (user A 2 of 3, user B 1 of 3) - the old pooled read gave both one
//      number; a user with no stored markets gets "no data" (null), not someone else's rate;
//   2. (b) five more settled markets for user B move B's rate and leave A's exactly as it was, and
//      so does deleting B altogether;
//   3. the rate read is ONE statement on heavy_consensus_markets filtered by this user's id (never a
//      whole-table read), and the cache is keyed per user under one shared tag that the nightly
//      cron revalidates;
//   4. the nightly picks read, the stored-ids read and the upserts keep the statement shapes the
//      DB Monitor labels fingerprint (db-monitor.ts).
//
// DB-backed and WRITING, scoped to games in 2099 so nothing real is read or changed: seeded users
// (cascading to their cappers, picks and markets), deleted by id. Refuses to run unless DATABASE_URL
// is the local bettingview_dev database.
//   node --env-file=<local env file> --require ./scripts/server-only-stub.cjs --import tsx src/server/data/heavy-consensus-per-user-acceptance-test.ts
// HEAVY_CAPTURE_OUT=<file> also writes the statements sent (for db-monitor-fixtures.ts).
import { readFileSync, writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { normalizeSql } from "@/lib/db-monitor";
import { cacheKeys } from "@/lib/cache-keys";
import { drainQueryLog } from "@/server/data/query-log-drain";

const queries: string[] = [];
const raw: string[] = [];
const logged = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
logged.$on("query", (e) => {
  queries.push(normalizeSql(e.query));
  raw.push(e.query);
});
(globalThis as unknown as { prisma: PrismaClient }).prisma = logged;
const resetLog = async () => {
  await drainQueryLog(logged, queries);
  queries.length = 0;
  raw.length = 0;
};

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

function localDevTarget(url: string | undefined): boolean {
  try {
    const u = new URL(url ?? "");
    return ["localhost", "127.0.0.1"].includes(u.hostname) && u.pathname === "/bettingview_dev";
  } catch {
    return false;
  }
}

const TAG = `heavy-${Date.now()}`;
const NOW = new Date("2099-06-01T12:00:00.000Z");
const FROM = "2099-01-01";
const POSTED = new Date("2099-03-01T12:00:00.000Z");
const gameTime = (day: number) => new Date(Date.UTC(2099, 2, day, 23, 0, 0));
const HEAVY_CAPPERS = 9;
const SOLO = 1;
const repo = (rel: string) => readFileSync(rel, "utf8").replace(/\r\n/g, "\n");

async function main() {
  if (!localDevTarget(process.env.DATABASE_URL)) throw new Error("Refusing to run: DATABASE_URL is not the local bettingview_dev database.");
  const { prisma } = await import("@/lib/prisma");
  const { getHeavyConsensusRate, recomputeHeavyConsensusMarkets, loadHeavyConsensusInstances } = await import("@/server/data/heavy-consensus");

  const userIds: string[] = [];
  let createdSportId: string | null = null;
  const makeUser = async (label: string) => {
    const u = await prisma.user.create({
      data: { supabaseId: `${TAG}-${label}`, email: `${TAG}-${label}@example.test`, subscription: { create: { plan: "PRO", status: "active" } } },
    });
    userIds.push(u.id);
    return u;
  };

  try {
    const existing = await prisma.sport.findUnique({ where: { name: "NBA" }, select: { id: true } });
    const sport = existing ?? { id: (createdSportId = (await prisma.sport.create({ data: { name: "NBA" } })).id) };

    const a = await makeUser("a");
    const b = await makeUser("b");
    const c = await makeUser("c"); // no picks, no markets
    const cappersOf = async (userId: string, label: string) => {
      const ids: string[] = [];
      for (let i = 0; i < HEAVY_CAPPERS + SOLO; i++) ids.push((await prisma.capper.create({ data: { userId, name: `${label}${i}`, source: "OTHER" } })).id);
      return ids;
    };
    const aCappers = await cappersOf(a.id, "a");
    const bCappers = await cappersOf(b.id, "b");

    // One game: nine of ten cappers on the home moneyline (90%), the tenth on the away side.
    // `heavy` is how the heavy side's picks were graded - the outcome the history records.
    const seedGame = async (userId: string, cappers: string[], day: number, heavy: "WIN" | "LOSS") => {
      const game = { homeTeam: `${TAG} Hosts ${day}`, awayTeam: `${TAG} Visitors ${day}` };
      await prisma.pick.createMany({
        data: cappers.map((capperId, i) => {
          const home = i < HEAVY_CAPPERS;
          const won = home ? heavy === "WIN" : heavy === "LOSS";
          return {
            userId,
            capperId,
            sportId: sport.id,
            ...game,
            betType: "MONEYLINE" as const,
            betDetail: home ? `${game.homeTeam} ML` : `${game.awayTeam} ML`,
            pickedSide: home ? ("HOME" as const) : ("AWAY" as const),
            odds: -110,
            units: 1,
            gameTime: gameTime(day),
            datePosted: POSTED,
            status: won ? ("WIN" as const) : ("LOSS" as const),
          };
        }),
      });
    };

    // The same three real-world games for both users, graded differently.
    await seedGame(a.id, aCappers, 10, "WIN");
    await seedGame(a.id, aCappers, 11, "WIN");
    await seedGame(a.id, aCappers, 12, "LOSS");
    await seedGame(b.id, bCappers, 10, "LOSS");
    await seedGame(b.id, bCappers, 11, "LOSS");
    await seedGame(b.id, bCappers, 12, "WIN");

    // ---- 1. (a) the recompute stores each user's markets; each user gets their own rate ----
    await resetLog();
    const result = await recomputeHeavyConsensusMarkets(NOW, FROM);
    await resetLog(); // drain the recompute's events before reading the window below
    check("the recompute stored 3 markets for each of the two users", [result.markets, result.upserted, result.deleted], [6, 6, 0]);
    const stored = await prisma.heavyConsensusMarket.findMany({ where: { userId: { in: [a.id, b.id] } }, select: { userId: true, worldKey: true, outcome: true }, orderBy: { worldKey: "asc" } });
    const keysOf = (id: string) => stored.filter((s) => s.userId === id).map((s) => s.worldKey);
    check("both users hold the SAME three real-world games (one worldKey each)", keysOf(a.id), keysOf(b.id));

    await resetLog();
    const rateA = await getHeavyConsensusRate(a.id);
    const rateASql = queries.slice();
    const rateARaw = raw.slice();
    await resetLog();
    const rateB = await getHeavyConsensusRate(b.id);
    const rateC = await getHeavyConsensusRate(c.id);
    check("(a) user A: 2 of 3 settled heavy markets hit", rateA, { hitRatePct: 67, games: 3 });
    check("(a) user B: 1 of 3 - a different rate on the very same games", rateB, { hitRatePct: 33, games: 3 });
    check("(a) a user with no stored markets has no rate (null), not anyone else's", rateC, { hitRatePct: null, games: 0 });

    // ---- 2. (b) another user's markets never move a user's rate ----
    for (let day = 13; day <= 17; day++) await seedGame(b.id, bCappers, day, "WIN");
    await recomputeHeavyConsensusMarkets(NOW, FROM);
    await resetLog();
    check("(b) B's five new hits move B's rate: 6 of 8", await getHeavyConsensusRate(b.id), { hitRatePct: 75, games: 8 });
    check("(b) ... and leave A's exactly as it was", await getHeavyConsensusRate(a.id), { hitRatePct: 67, games: 3 });
    await prisma.user.delete({ where: { id: b.id } });
    userIds.splice(userIds.indexOf(b.id), 1);
    check("(b) deleting B altogether still leaves A's rate as it was", await getHeavyConsensusRate(a.id), { hitRatePct: 67, games: 3 });
    check("(b) ... and B's rate is gone with B's markets", await getHeavyConsensusRate(b.id), { hitRatePct: null, games: 0 });

    // ---- 3. The read, the cache keys, the revalidate ----
    const hcm = rateASql.filter((q) => q.includes("heavy_consensus_markets"));
    check("the rate read is ONE statement on heavy_consensus_markets", hcm.length, 1);
    const T = (col: string) => `"heavy_consensus_markets"."${col}"`;
    check(
      "... filtered by this user's id, the 8-capper minimum and settled outcomes, four small columns (Prisma adds the id)",
      hcm[0],
      `SELECT ${T("id")}, ${T("userId")}, ${T("cappers")}, ${T("outcome")} FROM "heavy_consensus_markets" WHERE (${T("userId")} = $1 AND ${T("cappers")} >= $2 AND ${T("outcome")} IS NOT NULL) OFFSET $3`
    );
    check("the cache key is per user", [cacheKeys.heavyConsensusRate(a.id) === cacheKeys.heavyConsensusRate(b.id), cacheKeys.heavyConsensusRate(a.id).includes(a.id)], [false, true]);
    check("every entry carries the one shared tag (a key never doubles as it)", [cacheKeys.heavyConsensusRateTag(), cacheKeys.heavyConsensusRate(a.id) === cacheKeys.heavyConsensusRateTag()], ["heavy-consensus-rate", false]);
    const dataSrc = repo("src/server/data/heavy-consensus.ts");
    check("the read passes the shared tag to the cache", /cacheKeys\.heavyConsensusRate\(userId\),[\s\S]*?\[cacheKeys\.heavyConsensusRateTag\(\)\]/.test(dataSrc), true);
    check("the nightly cron revalidates the shared tag", repo("src/app/api/cron/refresh-scores/route.ts").includes("revalidateTag(cacheKeys.heavyConsensusRateTag())"), true);
    check("both Live pages ask for the viewer's own rate", [repo("src/app/(app)/live/page.tsx").includes("getHeavyConsensusRate(user.id)"), repo("src/app/(app)/live/[gameId]/page.tsx").includes("getHeavyConsensusRate(user.id)")], [true, true]);

    // ---- 4. The statements the DB Monitor labels fingerprint ----
    const captured: { name: string; sql: string }[] = [];
    const take = (name: string, pick: (q: string) => boolean) => {
      const i = queries.findIndex(pick);
      check(`captured: ${name}`, i >= 0, true);
      if (i >= 0) captured.push({ name, sql: raw[i] });
    };
    // The rate read (A's), then a nightly recompute (idempotent: the same rows upserted again) and an all-history read, each in its own window.
    captured.push({ name: "Heavy Consensus rate (per user)", sql: rateARaw.find((q) => q.includes("heavy_consensus_markets")) ?? "" });
    await resetLog();
    await recomputeHeavyConsensusMarkets(NOW, FROM);
    await drainQueryLog(logged, queries);
    check("A still holds its three markets after the re-run", await prisma.heavyConsensusMarket.count({ where: { userId: a.id } }), 3);
    take("nightly picks read (bounded window)", (q) => q.startsWith('SELECT "picks"') || q.startsWith('SELECT "public"."picks"') ? q.includes("isTest") && q.includes("gameTime\" >=") : false);
    take("stored ids read (window)", (q) => q.includes("FROM \"heavy_consensus_markets\"") || q.includes("FROM heavy_consensus_markets") ? /"gameDate" >= /.test(q) : false);
    take("upsert", (q) => q.startsWith("INSERT INTO") && q.includes("heavy_consensus_markets"));
    await resetLog();
    const all = await loadHeavyConsensusInstances(NOW, null);
    await drainQueryLog(logged, queries);
    check("the all-history read (backfill) includes A's three markets", all.instances.filter((i) => i.userId === a.id).length, 3);
    take("all-history picks read (backfill)", (q) => q.includes("isTest") && !q.includes("gameTime\" >="));
    if (process.env.HEAVY_CAPTURE_OUT) writeFileSync(process.env.HEAVY_CAPTURE_OUT, JSON.stringify(captured, null, 2));
  } finally {
    if (userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    if (createdSportId) await prisma.sport.delete({ where: { id: createdSportId } }).catch(() => undefined);
    await prisma.$disconnect();
  }

  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nAll per-user heavy-consensus checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
