// Option D's capper-history query (runCapperLeagueHistory) against a LOCAL database: it counts only the importing
// user's own GRADED NCAAF / NCAAB picks for the named capper in the last 30 days, and nothing else - no pending or
// cancelled rows, no rows older than the window, no recipient copies, no other sport, no other user's same-named capper.
//   npx tsx src/server/data/capper-college-history-db-acceptance-test.ts   (DATABASE_URL must be localhost)
//
// Every row it creates is recorded and deleted BY ID, with before/after counts printed. Skips (exit 0) when
// DATABASE_URL is missing or is not a local database.

// A module (not a global script), so its helper names cannot collide with the other test files.
export {};

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!pass) failures++;
}

function isLocal(url: string | undefined): boolean {
  try {
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(url ?? "").hostname);
  } catch {
    return false;
  }
}

const PREFIX = "__OptD__";
const DAY = 24 * 3600 * 1000;

async function main() {
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile(".env");
    } catch {
      /* no .env */
    }
  }
  if (!isLocal(process.env.DATABASE_URL)) {
    console.log("SKIP: DATABASE_URL is not a local database - this test writes fixtures.");
    return;
  }
  const { prisma } = await import("@/lib/prisma");
  const { runCapperLeagueHistory } = await import("@/server/data/catalog-disambiguation-checks");
  const { historyLeague } = await import("@/lib/college-line-signal");

  const created = { users: [] as string[], cappers: [] as string[], picks: [] as string[], sports: [] as string[] };
  const global = async () => ({
    users: await prisma.user.count(),
    cappers: await prisma.capper.count(),
    picks: await prisma.pick.count(),
    sports: await prisma.sport.count(),
    odds_snapshots: await prisma.oddsSnapshot.count(),
  });
  const before = await global();
  console.log("BEFORE:", JSON.stringify(before));

  try {
    const sportId = async (name: string) => {
      const found = await prisma.sport.findUnique({ where: { name }, select: { id: true } });
      if (found) return found.id;
      const made = await prisma.sport.create({ data: { name }, select: { id: true } });
      created.sports.push(made.id);
      return made.id;
    };
    const ncaaf = await sportId("NCAAF");
    const ncaab = await sportId("NCAAB");
    const nfl = await sportId("NFL");

    const mkUser = async (tag: string) => {
      const u = await prisma.user.create({ data: { supabaseId: PREFIX + tag, email: PREFIX + tag + "@example.test" }, select: { id: true } });
      created.users.push(u.id);
      return u.id;
    };
    const me = await mkUser("me");
    const other = await mkUser("other");
    const mkCapper = async (userId: string, name: string) => {
      const c = await prisma.capper.create({ data: { userId, name, source: "OTHER" }, select: { id: true } });
      created.cappers.push(c.id);
      return c.id;
    };
    const mine = await mkCapper(me, PREFIX + "Sharp");
    const theirs = await mkCapper(other, PREFIX + "Sharp"); // same name, a different user's capper

    const now = Date.now();
    // Set by raw SQL, by recorded id: the column is the point of the test, and a client generated before it
    // existed (a shared node_modules) would not accept it as a create argument.
    const copyIds: string[] = [];
    type Spec = { userId: string; capperId: string; sportId: string; n: number; status: "WIN" | "LOSS" | "PUSH" | "PENDING" | "CANCELLED"; ageDays: number; copy?: boolean };
    const add = async (s: Spec) => {
      for (let i = 0; i < s.n; i++) {
        const p = await prisma.pick.create({
          data: {
            userId: s.userId,
            capperId: s.capperId,
            sportId: s.sportId,
            homeTeam: PREFIX + "Home",
            awayTeam: PREFIX + "Away",
            betType: "SPREAD",
            odds: -110,
            line: -3.5,
            units: 1,
            gameTime: new Date(now - s.ageDays * DAY),
            status: s.status,
          },
          select: { id: true },
        });
        created.picks.push(p.id);
        if (s.copy) copyIds.push(p.id);
      }
    };
    const mineBase = { userId: me, capperId: mine };
    // Counted: graded, in window, mine. NCAAB 6 WIN + 3 LOSS + 1 PUSH = 10, NCAAF 1.
    await add({ ...mineBase, sportId: ncaab, n: 6, status: "WIN", ageDays: 2 });
    await add({ ...mineBase, sportId: ncaab, n: 3, status: "LOSS", ageDays: 10 });
    await add({ ...mineBase, sportId: ncaab, n: 1, status: "PUSH", ageDays: 29 });
    await add({ ...mineBase, sportId: ncaaf, n: 1, status: "WIN", ageDays: 5 });
    // Not counted.
    // (the recipient copies are flagged just below)
    await add({ ...mineBase, sportId: ncaab, n: 5, status: "PENDING", ageDays: 1 });
    await add({ ...mineBase, sportId: ncaab, n: 2, status: "CANCELLED", ageDays: 1 });
    await add({ ...mineBase, sportId: ncaaf, n: 20, status: "WIN", ageDays: 31 }); // outside the window
    await add({ ...mineBase, sportId: ncaaf, n: 20, status: "WIN", ageDays: 3, copy: true }); // a copy delivered to this user
    await add({ ...mineBase, sportId: nfl, n: 5, status: "WIN", ageDays: 3 }); // another sport
    await add({ userId: other, capperId: theirs, sportId: ncaaf, n: 30, status: "WIN", ageDays: 3 }); // someone else's

    await prisma.$executeRaw`UPDATE picks SET "isRecipientCopy" = true WHERE id = ANY(${copyIds}::text[]) AND "userId" = ${me}`;
    expect("20 recipient copies flagged", copyIds.length, 20);

    const key = (PREFIX + "Sharp").toLowerCase();
    const mineRes = await runCapperLeagueHistory(me, [PREFIX + "Sharp"]);
    expect("importing user: only their own graded in-window college picks, split per league", mineRes, { [key]: { NCAAF: 1, NCAAB: 10 } });
    expect("... which is 10 of 11 = lopsided NCAAB", historyLeague(mineRes[key]), "NCAAB");
    const otherRes = await runCapperLeagueHistory(other, [PREFIX + "SHARP"]);
    expect("the other user sees only their own capper's picks (name matched case-insensitively)", otherRes, { [key]: { NCAAF: 30, NCAAB: 0 } });
    expect("a capper the user does not have returns nothing", await runCapperLeagueHistory(me, [PREFIX + "Nobody"]), {});
    expect("no names asks nothing", await runCapperLeagueHistory(me, []), {});
  } finally {
    // Cleanup by recorded id, scoped to the users this run created.
    for (let i = 0; i < created.picks.length; i += 500) {
      await prisma.pick.deleteMany({ where: { id: { in: created.picks.slice(i, i + 500) }, userId: { in: created.users } } });
    }
    await prisma.capper.deleteMany({ where: { id: { in: created.cappers }, userId: { in: created.users } } });
    await prisma.user.deleteMany({ where: { id: { in: created.users } } });
    if (created.sports.length > 0) await prisma.sport.deleteMany({ where: { id: { in: created.sports } } });
    const after = await global();
    console.log("AFTER: ", JSON.stringify(after));
    expect("row counts are back to where they started", after, before);
    await prisma.$disconnect();
  }

  if (failures > 0) {
    console.log(`${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
  console.log("ALL CHECKS PASSED");
}

main();
