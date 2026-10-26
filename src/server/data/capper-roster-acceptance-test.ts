// The cached capper roster and the reads that stopped asking the database for it
// (capper-roster.ts and its callers). Real database, a query-logging PrismaClient installed as
// globalThis.prisma before any app module loads (lib/prisma.ts reuses it), so every statement the
// code sends is counted.
//
// 1. The roster read is ONE statement of four columns (id, name, colorTag, isFavorite), favorites
//    first then by name, and returns exactly what the old id + name query ordered the same way.
//    getCappersForUser is that same roster.
// 2. Pick counts: for every capper of two users the user-scoped raw SQL equals the Prisma _count
//    it replaced (the old statement's grouped subquery had no userId filter - asserted gone), a
//    capper with no picks counts 0, and the one intended difference is pinned: another user's
//    pick on this user's capper no longer counts.
// 3. The pick import's capper reads: with three new cappers, ONE roster scan (insertPicksDeduped's
//    own, inside its transaction) where it used to be five (that one, resolveImportRefs', and one
//    per new capper in findOrCreateCapper); every pick still lands on the right capper.
//    findOrCreateCapper scans once on its own and not at all when given the caller's roster.
// 4. The /live board's picks (getPicksForGames): each pick's capper {name, colorTag, isFavorite}
//    is the capper's, and no `FROM cappers WHERE id IN (...)` follow-up statement is sent.
//
// DB-backed and WRITING: seeded users (cascading to their cappers and picks), deleted by id.
// Refuses to run unless DATABASE_URL is local.
//   node --require ./scripts/server-only-stub.cjs --import tsx src/server/data/capper-roster-acceptance-test.ts
import { PrismaClient } from "@prisma/client";
import { normalizeSql } from "@/lib/db-monitor";
import { drainQueryLog } from "@/server/data/query-log-drain";

const queries: string[] = [];
const logged = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
logged.$on("query", (e) => queries.push(normalizeSql(e.query)));
(globalThis as unknown as { prisma: PrismaClient }).prisma = logged;
// Wait for every event of the calls so far, then (resetLog) start a new window.
const drain = () => drainQueryLog(logged, queries);
const resetLog = async () => {
  await drain();
  queries.length = 0;
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

const TAG = `roster-${Date.now()}`;
// A statement that reads this table's cappers by user: the roster (ORDER BY) or the names scan (none).
const isRosterRead = (q: string) => /FROM "cappers" WHERE "cappers"\."userId" = \$\d+/.test(q) && /^SELECT "cappers"\."id", "cappers"\."name"/.test(q);
const isNamesScan = (q: string) => isRosterRead(q) && !/ORDER BY/.test(q) && /^SELECT "cappers"\."id", "cappers"\."name" FROM/.test(q);
const isIdInList = (q: string) => /FROM "cappers" WHERE "cappers"\."id" IN \(/.test(q);

async function main() {
  if (!["localhost", "127.0.0.1"].includes(hostOf(process.env.DATABASE_URL))) {
    throw new Error("Refusing to run: DATABASE_URL is not local.");
  }
  const { prisma } = await import("@/lib/prisma");
  const { getCapperRoster } = await import("@/server/data/capper-roster");
  const { getCappersForUser, loadCappersWithPickCounts } = await import("@/server/data/cappers");
  const { findOrCreateCapper } = await import("@/server/data/capper-find-or-create");
  const { insertPicksDeduped } = await import("@/server/data/pick-dedup");
  const { getPicksForGames } = await import("@/server/data/picks");

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
    const existing = await prisma.sport.findUnique({ where: { name: "MLB" }, select: { id: true } });
    const sport = existing ?? { id: (createdSportId = (await prisma.sport.create({ data: { name: "MLB" } })).id) };

    const a = await makeUser("a");
    const b = await makeUser("b");
    const zed = await prisma.capper.create({ data: { userId: a.id, name: "Zed", source: "OTHER", isFavorite: true, colorTag: "red" } });
    const alpha = await prisma.capper.create({ data: { userId: a.id, name: "alpha", source: "OTHER" } });
    const beta = await prisma.capper.create({ data: { userId: a.id, name: "Beta", source: "OTHER", colorTag: "blue" } });
    const other = await prisma.capper.create({ data: { userId: b.id, name: "Other", source: "OTHER" } });

    // ---- 1. The roster ----
    await resetLog();
    const roster = await getCapperRoster(a.id);
    await drain();
    const rosterStatements = queries.filter((q) => /FROM "cappers"/.test(q));
    check("1 one statement for the roster", rosterStatements.length === 1, String(rosterStatements.length));
    check(
      "1 four columns, user-scoped, favorites first then name",
      /^SELECT "cappers"\."id", "cappers"\."name", "cappers"\."colorTag", "cappers"\."isFavorite" FROM "cappers" WHERE "cappers"\."userId" = \$1 ORDER BY "cappers"\."isFavorite" DESC, "cappers"\."name" ASC/.test(rosterStatements[0] ?? ""),
      rosterStatements[0]
    );
    const reference = await prisma.capper.findMany({
      where: { userId: a.id },
      select: { id: true, name: true, colorTag: true, isFavorite: true },
      orderBy: [{ isFavorite: "desc" }, { name: "asc" }],
    });
    check("1 same rows, same order as the direct query", JSON.stringify(roster) === JSON.stringify(reference));
    check("1 the favorite is first", roster[0]?.id === zed.id && roster.length === 3, roster.map((c) => c.name).join("|"));
    check("1 colorTag and isFavorite are carried", roster[0]?.colorTag === "red" && roster[0]?.isFavorite === true && roster.find((c) => c.id === alpha.id)?.colorTag === null);
    check("1 getCappersForUser is the roster", JSON.stringify(await getCappersForUser(a.id)) === JSON.stringify(roster));
    check("1 another user's cappers never appear", !roster.some((c) => c.id === other.id));

    // ---- 2. Pick counts ----
    const base = { sportId: sport.id, odds: -110, units: 1, homeTeam: "H", awayTeam: "A", betType: "MONEYLINE" as const, gameTime: new Date("2026-06-01T17:00:00.000Z") };
    await prisma.pick.createMany({
      data: [
        ...[0, 1, 2].map(() => ({ ...base, userId: a.id, capperId: zed.id })),
        { ...base, userId: a.id, capperId: alpha.id },
        ...[0, 1].map(() => ({ ...base, userId: b.id, capperId: other.id })),
        // a's pick on b's capper: counted by the old all-users join, not by the user-scoped one
        { ...base, userId: a.id, capperId: other.id },
      ],
    });
    const oldCounts = async (userId: string) =>
      (
        await prisma.capper.findMany({ where: { userId }, select: { id: true, name: true, _count: { select: { picks: true } } }, orderBy: { name: "asc" } })
      ).map((c) => ({ id: c.id, name: c.name, pickCount: c._count.picks }));
    await resetLog();
    const newA = await loadCappersWithPickCounts(a.id);
    await drain();
    const countStatements = queries.filter((q) => /FROM cappers/.test(q));
    check("2 one statement", countStatements.length === 1, String(countStatements.length));
    check("2 the grouped subquery is this user's picks only", /FROM picks WHERE "userId" = \$\d+ GROUP BY "capperId"/.test(countStatements[0] ?? "") && !/\$\d+ ?= ?\$\d+/.test(countStatements[0] ?? ""), countStatements[0]);
    check("2 user a: same counts, same order as Prisma's _count", JSON.stringify(newA) === JSON.stringify(await oldCounts(a.id)), JSON.stringify({ newA, old: await oldCounts(a.id) }));
    check("2 zero-pick capper counts 0", newA.find((c) => c.id === beta.id)?.pickCount === 0 && newA.find((c) => c.id === zed.id)?.pickCount === 3);
    const newB = await loadCappersWithPickCounts(b.id);
    const oldB = await oldCounts(b.id);
    check("2 user b: old counted a's pick on b's capper (3), the scoped count does not (2)", oldB[0]?.pickCount === 3 && newB[0]?.pickCount === 2, JSON.stringify({ newB, oldB }));
    check("2 the counts are ints, not bigints", newB.every((c) => typeof c.pickCount === "number"));

    // ---- 3. The pick import's capper reads ----
    const c = await makeUser("c");
    const sharp = await prisma.capper.create({ data: { userId: c.id, name: "Sharp Sam", source: "OTHER" } });
    const row = (capperName: string, i: number) => ({
      capperName,
      sportName: "MLB",
      homeTeam: "Home " + i,
      awayTeam: "Away " + i,
      betType: "MONEYLINE" as const,
      betDetail: `${TAG}#${i}`,
      odds: -120,
      units: 1,
      gameTime: new Date(Date.UTC(2026, 5, 2 + i, 17)),
      pickedSide: "HOME" as const,
      mlFavoredSide: "HOME" as const,
    });
    await resetLog();
    const imported = await insertPicksDeduped(c.id, [row("sharp-sam", 0), row("New One", 1), row("New Two", 2), row("New Three", 3), row("New One", 4)]);
    await drain();
    const scans = queries.filter(isNamesScan);
    check("3 the import is allowed", imported.allowed === true);
    check("3 one roster scan for the whole import (was five)", scans.length === 1, String(scans.length));
    const cappersC = await prisma.capper.findMany({ where: { userId: c.id }, orderBy: { name: "asc" } });
    check("3 one existing capper reused, three created", cappersC.length === 4 && cappersC.filter((x) => x.id === sharp.id).length === 1, cappersC.map((x) => x.name).join("|"));
    const created = imported.allowed ? imported.created : [];
    const pickRows = await prisma.pick.findMany({ where: { id: { in: created.map((p) => p.id) } } });
    const byDetail = new Map(pickRows.map((p) => [p.betDetail, p.capperId]));
    const idOf = (name: string) => cappersC.find((x) => x.name === name)?.id;
    check(
      "3 every pick is on the right capper",
      byDetail.get(`${TAG}#0`) === sharp.id && byDetail.get(`${TAG}#1`) === idOf("New One") && byDetail.get(`${TAG}#4`) === idOf("New One") && byDetail.get(`${TAG}#2`) === idOf("New Two") && byDetail.get(`${TAG}#3`) === idOf("New Three"),
      JSON.stringify([...byDetail])
    );

    await resetLog();
    const own = await findOrCreateCapper(c.id, "Standalone", { source: "OTHER" });
    await drain();
    check("3 findOrCreateCapper on its own: one scan, creates", queries.filter(isNamesScan).length === 1 && own.created === true);
    await resetLog();
    const known = await prisma.capper.findMany({ where: { userId: c.id }, select: { id: true, name: true } });
    await resetLog();
    const again = await findOrCreateCapper(c.id, "standalone", { source: "OTHER" }, prisma, known);
    await drain();
    check("3 given the caller's roster: no scan, finds the existing capper", queries.filter(isNamesScan).length === 0 && again.created === false && again.capper.id === own.capper.id);
    await resetLog();
    const fresh = await findOrCreateCapper(c.id, "Brand New", { source: "OTHER" }, prisma, known);
    await drain();
    check("3 given the caller's roster: no scan, creates a name it lacks", queries.filter(isNamesScan).length === 0 && fresh.created === true);

    // ---- 4. The /live board's picks ----
    const game = { homeTeam: "New York Yankees", awayTeam: "Boston Red Sox", commenceTime: new Date("2026-07-01T23:05:00.000Z") };
    await prisma.pick.createMany({
      data: [
        { userId: a.id, capperId: zed.id, sportId: sport.id, homeTeam: game.homeTeam, awayTeam: game.awayTeam, betType: "TOTAL", betDetail: "Over 8.5", line: 8.5, odds: -110, units: 1, gameTime: game.commenceTime },
        { userId: a.id, capperId: beta.id, sportId: sport.id, homeTeam: game.homeTeam, awayTeam: game.awayTeam, betType: "MONEYLINE", betDetail: "New York Yankees ML", pickedSide: "HOME", odds: -130, units: 1, gameTime: game.commenceTime },
        // a pick of a's on another user's capper: its capper is read by id, as the relation select did
        { userId: a.id, capperId: other.id, sportId: sport.id, homeTeam: game.homeTeam, awayTeam: game.awayTeam, betType: "TOTAL", betDetail: "Under 9", line: 9, odds: -110, units: 1, gameTime: game.commenceTime },
      ],
    });
    await resetLog();
    const [matched] = await getPicksForGames(a.id, "MLB", [game]);
    await drain();
    const capperOf = (id: string) => matched?.find((p) => p.capperId === id)?.capper;
    check("4 the three picks come back", matched?.length === 3, String(matched?.length));
    check("4 favorite capper: name, colour and favorite flag", JSON.stringify(capperOf(zed.id)) === JSON.stringify({ name: "Zed", colorTag: "red", isFavorite: true }), JSON.stringify(capperOf(zed.id)));
    check("4 plain capper", JSON.stringify(capperOf(beta.id)) === JSON.stringify({ name: "Beta", colorTag: "blue", isFavorite: false }), JSON.stringify(capperOf(beta.id)));
    check("4 a capper outside the roster is read by id", JSON.stringify(capperOf(other.id)) === JSON.stringify({ name: "Other", colorTag: null, isFavorite: false }), JSON.stringify(capperOf(other.id)));
    const rosterReads = queries.filter(isRosterRead);
    const idLists = queries.filter(isIdInList);
    check("4 one roster read, and one by-id read only for the capper outside it", rosterReads.length === 1 && idLists.length === 1, JSON.stringify({ rosterReads: rosterReads.length, idLists: idLists.length }));

    await resetLog();
    await prisma.pick.deleteMany({ where: { userId: a.id, capperId: other.id } });
    await resetLog();
    const [onlyOwn] = await getPicksForGames(a.id, "MLB", [game]);
    await drain();
    check("4 own cappers only: no by-id capper statement at all", onlyOwn?.length === 2 && queries.filter(isIdInList).length === 0, JSON.stringify({ n: onlyOwn?.length, idLists: queries.filter(isIdInList).length }));
  } finally {
    if (userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
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
