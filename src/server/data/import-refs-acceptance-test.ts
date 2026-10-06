// Catalog import atomicity: cappers and sports are created inside the same
// transaction as the picks (import-refs.ts + insertPicksWithEntitlementCheck).
//
// Real-database test (no spies on the database), run with DATABASE_URL set:
//   npx tsx src/server/data/import-refs-acceptance-test.ts
// Exits non-zero on any failed assertion.
//
// 1. Success: new cappers and a new sport are created, an existing capper is
//    matched by normalized name and an existing sport case-insensitively, every
//    pick lands on the right capper/sport, in input order.
// 2. A failure after the cappers and sport were created (inside the
//    transaction) leaves none of them behind.
// 3. An import the Free-plan limit refuses creates no capper and no sport, and
//    never even runs the row builder.
// 4. Two users importing the same brand-new sport at the same moment both
//    succeed and share one sport row (the old sport.create lost with P2002).
// 5. The same user importing the same brand-new capper twice at once ends up
//    with one capper.
// 6. A row builder that returns the wrong number of rows fails closed.
// 7. Outside a transaction (the parlay import's use) the same helpers work on
//    the shared client.
// 8. Source: the pick import writes nothing before its transaction, has no
//    serial per-line wait, and the import route declares maxDuration.
// 9. The real action: 25 unmatched lines take one shared 1 s wait, not 25.
import { readFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import { FREE_PICK_LIMIT } from "@/lib/entitlements";
import { insertPicksWithEntitlementCheck } from "@/server/data/subscriptions";
import {
  resolveImportRefs,
  resolveOrCreateCapperId,
  resolveOrCreateSportId,
  type PendingPickInsert,
} from "@/server/data/import-refs";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

const TAG = `iref-${Date.now()}`;
const GAME = new Date("2026-06-01T17:00:00.000Z");
const sportName = (s: string) => `${TAG}-${s}`;

async function makeUser(label: string) {
  return prisma.user.create({
    data: {
      supabaseId: `${TAG}-${label}`,
      email: `${TAG}-${label}@example.test`,
      subscription: { create: { plan: "FREE", status: "active" } },
    },
  });
}

function pending(capperName: string, sport: string, i: number): PendingPickInsert {
  return {
    capperName,
    sportName: sport,
    homeTeam: "Home " + i,
    awayTeam: "Away " + i,
    betType: "MONEYLINE",
    betDetail: `${TAG}#${i}`,
    odds: -120,
    units: 1,
    gameTime: GAME,
    pickedSide: "HOME",
    mlFavoredSide: "HOME",
  };
}

const importRows = (userId: string, rows: PendingPickInsert[]) =>
  insertPicksWithEntitlementCheck(userId, rows.length, (tx) => resolveImportRefs(tx, userId, rows));

const cappersOf = (userId: string) => prisma.capper.findMany({ where: { userId }, orderBy: { name: "asc" } });
const taggedSports = () => prisma.sport.findMany({ where: { name: { startsWith: TAG } }, orderBy: { name: "asc" } });

async function main() {
  const userIds: string[] = [];
  try {
    // ---- 1. Success ----
    {
      const user = await makeUser("ok");
      userIds.push(user.id);
      const existingCapper = await prisma.capper.create({ data: { userId: user.id, name: "Sharp Sam", source: "OTHER" } });
      const existingSport = await prisma.sport.create({ data: { name: sportName("MLB") } });

      const rows = [
        pending("sharp-sam", sportName("mlb"), 0), // existing capper (normalized), existing sport (case)
        pending("New Guy", sportName("NFL"), 1), // new capper, new sport
        pending("New Guy", sportName("NFL"), 2),
        pending("Second New", sportName("MLB"), 3),
        pending("Sharp Sam", sportName("nfl"), 4),
      ];
      const result = await importRows(user.id, rows);
      check("1 import allowed", result.allowed === true);
      const created = result.allowed ? result.created : [];
      check("1 five picks created", created.length === 5, String(created.length));

      const cappers = await cappersOf(user.id);
      check("1 exactly three cappers (one existing, two new)", cappers.length === 3, cappers.map((c) => c.name).join("|"));
      check("1 existing capper reused, not duplicated", cappers.filter((c) => c.id === existingCapper.id).length === 1);
      const newGuy = cappers.find((c) => c.name === "New Guy");
      check("1 new capper carries the catalog-import source", newGuy?.source === "OTHER" && newGuy?.customSource === "Catalog import");

      const sports = await taggedSports();
      check("1 exactly two tagged sports (one existing, one new)", sports.length === 2, sports.map((s) => s.name).join("|"));
      const nfl = sports.find((s) => s.name === sportName("NFL"));
      check("1 new sport created under the first-seen spelling", Boolean(nfl));

      const picks = await prisma.pick.findMany({ where: { id: { in: created.map((c) => c.id) } } });
      const byId = new Map(picks.map((p) => [p.id, p]));
      const ordered = created.map((c) => byId.get(c.id)!);
      check("1 created ids are in input order", ordered.map((p) => p.betDetail).join(",") === rows.map((r) => r.betDetail).join(","));
      check("1 pick 0 -> existing capper + existing sport", ordered[0].capperId === existingCapper.id && ordered[0].sportId === existingSport.id);
      check("1 picks 1,2 -> the one new capper + new sport", ordered[1].capperId === newGuy?.id && ordered[2].capperId === newGuy?.id && ordered[1].sportId === nfl?.id);
      check("1 pick 4 -> existing capper, new sport matched case-insensitively", ordered[4].capperId === existingCapper.id && ordered[4].sportId === nfl?.id);
      check("1 picks are stamped with a category", ordered.every((p) => p.category !== null));
    }

    // ---- 2. Failure after the refs were created rolls everything back ----
    {
      const user = await makeUser("rollback");
      userIds.push(user.id);
      const rows = [pending("Ghost Capper", sportName("ROLLBACK"), 0), pending("Ghost Two", sportName("ROLLBACK"), 1)];
      let sawCappersInsideTx = 0;
      let threw = "";
      try {
        await insertPicksWithEntitlementCheck(user.id, rows.length, async (tx) => {
          const built = await resolveImportRefs(tx, user.id, rows);
          sawCappersInsideTx = await tx.capper.count({ where: { userId: user.id } });
          throw new Error("boom after refs " + built.length);
        });
      } catch (err) {
        threw = err instanceof Error ? err.message : String(err);
      }
      check("2 the failure propagates", threw === "boom after refs 2", threw);
      check("2 the cappers did exist inside the transaction", sawCappersInsideTx === 2, String(sawCappersInsideTx));
      check("2 no capper left behind", (await cappersOf(user.id)).length === 0);
      check("2 no sport left behind", (await prisma.sport.count({ where: { name: sportName("ROLLBACK") } })) === 0);
      check("2 no pick left behind", (await prisma.pick.count({ where: { userId: user.id } })) === 0);
    }

    // ---- 3. Pick-limit refusal creates nothing ----
    {
      const user = await makeUser("limit");
      userIds.push(user.id);
      const rows = Array.from({ length: FREE_PICK_LIMIT + 1 }, (_, i) => pending("Limit Capper " + (i % 3), sportName("LIMIT"), i));
      let builderRan = false;
      const result = await insertPicksWithEntitlementCheck(user.id, rows.length, async (tx) => {
        builderRan = true;
        return resolveImportRefs(tx, user.id, rows);
      });
      check("3 import refused", result.allowed === false);
      check("3 message counts the whole batch", !result.allowed && result.message.includes(String(FREE_PICK_LIMIT + 1)), result.allowed ? "" : result.message);
      check("3 the row builder never ran", builderRan === false);
      check("3 no capper created", (await cappersOf(user.id)).length === 0);
      check("3 no sport created", (await prisma.sport.count({ where: { name: sportName("LIMIT") } })) === 0);
      check("3 no pick created", (await prisma.pick.count({ where: { userId: user.id } })) === 0);
    }

    // ---- 4. Two users, same brand-new sport, at once ----
    {
      const users = await Promise.all(["raceA", "raceB", "raceC", "raceD"].map(makeUser));
      userIds.push(...users.map((u) => u.id));
      const results = await Promise.allSettled(
        users.map((u, i) => importRows(u.id, [pending("Racer " + i, sportName("RACE"), 0), pending("Racer " + i, sportName("RACE"), 1)]))
      );
      const rejected = results.filter((r) => r.status === "rejected");
      check("4 every concurrent import succeeded", rejected.length === 0, rejected.map((r) => String((r as PromiseRejectedResult).reason)).join(" | "));
      const race = await prisma.sport.findMany({ where: { name: sportName("RACE") } });
      check("4 exactly one sport row", race.length === 1, String(race.length));
      const picks = await prisma.pick.findMany({ where: { userId: { in: users.map((u) => u.id) } }, select: { sportId: true } });
      check("4 all eight picks point at it", picks.length === 8 && picks.every((p) => p.sportId === race[0]?.id), String(picks.length));
    }

    // ---- 5. Same user, same brand-new capper, twice at once ----
    {
      const user = await makeUser("samecapper");
      userIds.push(user.id);
      const results = await Promise.allSettled([
        importRows(user.id, [pending("Twice Capper", sportName("MLB"), 0)]),
        importRows(user.id, [pending("twice capper", sportName("MLB"), 1)]),
      ]);
      check("5 both imports succeeded", results.every((r) => r.status === "fulfilled"), results.map((r) => r.status).join(","));
      const cappers = await cappersOf(user.id);
      check("5 one capper", cappers.length === 1, cappers.map((c) => c.name).join("|"));
      check("5 two picks on it", (await prisma.pick.count({ where: { userId: user.id, capperId: cappers[0]?.id } })) === 2);
    }

    // ---- 6. Wrong row count fails closed ----
    {
      const user = await makeUser("count");
      userIds.push(user.id);
      const rows = [pending("Count Capper", sportName("MLB"), 0), pending("Count Capper", sportName("MLB"), 1)];
      let threw = "";
      try {
        await insertPicksWithEntitlementCheck(user.id, 3, (tx) => resolveImportRefs(tx, user.id, rows));
      } catch (err) {
        threw = err instanceof Error ? err.message : String(err);
      }
      check("6 a row-count mismatch throws", threw.includes("returned 2 rows, expected 3"), threw);
      check("6 and leaves no capper", (await cappersOf(user.id)).length === 0);
      const none = await insertPicksWithEntitlementCheck(user.id, 0, async () => {
        throw new Error("must not run");
      });
      check("6 zero rows: no transaction, builder not run", none.allowed === true && none.created.length === 0);
    }

    // ---- 7. Shared client (how the parlay import uses the helpers) ----
    {
      const user = await makeUser("shared");
      userIds.push(user.id);
      const existing: { id: string; name: string }[] = [];
      const capperCache = new Map<string, string>();
      const sportCache = new Map<string, string>();
      const a = await resolveOrCreateCapperId(user.id, "Parlay Pat", existing, capperCache);
      const b = await resolveOrCreateCapperId(user.id, "parlay-pat", existing, capperCache);
      check("7 capper: created once, found by normalized name after", a === b && (await cappersOf(user.id)).length === 1);
      const s1 = await resolveOrCreateSportId(sportName("SHARED"), sportCache);
      const s2 = await resolveOrCreateSportId(sportName("shared"), new Map());
      check("7 sport: created once, found case-insensitively after", s1 === s2);
      const [c1, c2] = await Promise.all([
        resolveOrCreateSportId(sportName("SHARED2"), new Map()),
        resolveOrCreateSportId(sportName("SHARED2"), new Map()),
      ]);
      check("7 sport: concurrent creates on the shared client agree", c1 === c2 && (await prisma.sport.count({ where: { name: sportName("SHARED2") } })) === 1);
    }

    // ---- 8. Source inspection ----
    {
      const src = readFileSync("src/server/actions/bulk-picks.ts", "utf8");
      const fn = src.slice(src.indexOf("export async function bulkImportPicksAction("), src.indexOf("// ---- MLP (moneyline parlay) import ----"));
      // Code only: comments mention the functions this must not call.
      const code = (text: string) =>
        text
          .split("\n")
          .filter((l) => !l.trim().startsWith("//"))
          .join("\n");
      const txStart = fn.indexOf("const [result] = await Promise.all([");
      const beforeTx = code(fn.slice(0, txStart));
      check("8 nothing is written before the transaction", !/prisma\.|resolveOrCreateCapperId|resolveOrCreateSportId|findOrCreateCapper/.test(beforeTx));
      check("8 refs are resolved on the transaction client", /insertPicksWithEntitlementCheck\(user\.id, toInsert\.length, \(tx\) => resolveImportRefs\(tx, user\.id, toInsert\)\)/.test(fn));
      check("8 every item is resolved concurrently, without its own retry wait", /Promise\.all\(items\.map\(\(item\) => resolveOne\(item, getOdds\)\)\)/.test(fn) && /retryOnMiss: false/.test(fn));
      check("8 exactly one wait in the whole action", (fn.match(/setTimeout\(/g) ?? []).length === 1);
      const loop = code(fn.slice(fn.indexOf("for (let i = 0; i < items.length; i++)"), txStart));
      check("8 the per-item loop awaits nothing", !/\bawait\b/.test(loop));
      const page = readFileSync("src/app/(app)/picks/import/page.tsx", "utf8");
      check("8 the import route declares maxDuration", /export const maxDuration = 60;/.test(page));
    }

    // ---- 9. The real action: 25 unmatched lines wait once, not 25 times ----
    // MLB lines with no team in the text resolve to no game without touching the
    // network. Each used to sleep 1 s before giving up, one after another (25 s).
    {
      // As the dev-bypass user (NODE_ENV/DEV_AUTH_BYPASS are read per call), with the
      // same react.cache shim the other real-action tests use under bare tsx.
      const env = process.env as Record<string, string | undefined>;
      const saved = { NODE_ENV: env.NODE_ENV, DEV_AUTH_BYPASS: env.DEV_AUTH_BYPASS };
      env.NODE_ENV = "development";
      env.DEV_AUTH_BYPASS = "true";
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const react = require("react") as { cache?: unknown };
      react.cache ??= <T,>(fn: T) => fn;
      const { bulkImportPicksAction } = await import("@/server/actions/bulk-picks");
      const items = Array.from({ length: 25 }, (_, i) => ({
        capperName: `${TAG} Slow ${i % 4}`,
        sportName: "MLB",
        description: `Nowhere Nobody -1.5 #${i}`,
        betType: "SPREAD" as const,
        odds: -110,
        hasExplicitOdds: true,
        teamNicknames: [] as string[],
        units: 1,
        period: "FULL_GAME" as const,
        gameNumber: null,
      }));
      const started = Date.now();
      let out: { success?: boolean; imported?: number; unmatchedGames?: string[] } = {};
      try {
        out = (await bulkImportPicksAction(items as never)) as typeof out;
      } catch (e) {
        // Outside a Next request the trailing revalidateTag throws, after all the work.
        if (!/static generation store missing/.test(e instanceof Error ? e.message : String(e))) throw e;
      }
      const elapsed = Date.now() - started;
      check("9 25 unmatched lines finish in under 5 s", elapsed < 5000, elapsed + " ms");
      check("9 and still take the one shared retry wait", elapsed >= 1000, elapsed + " ms");
      const dev = await prisma.user.findFirst({ where: { supabaseId: "dev-local-bypass" } });
      if (dev && dev.createdAt.getTime() >= Date.now() - 600000) userIds.push(dev.id);
      const left = dev ? await prisma.capper.count({ where: { userId: dev.id, name: { startsWith: `${TAG} Slow` } } }) : 0;
      check("9 no capper is created for lines that were all dropped", left === 0, String(left));
      env.NODE_ENV = saved.NODE_ENV;
      env.DEV_AUTH_BYPASS = saved.DEV_AUTH_BYPASS;
    }
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.sport.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.$disconnect();
  }

  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nAll passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
