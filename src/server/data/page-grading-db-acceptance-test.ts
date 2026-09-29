// DB-backed proof of page-grading's demand gate: the REAL sportNamesWithDuePendingPicks
// query against a real Postgres, using disposable rows it creates and deletes
// itself (unique names, nothing shared is modified except an idempotent upsert
// of the MLB reference Sport row). Skipped by scripts/run-tests.mjs when no
// DATABASE_URL is available; the orchestration/throttle logic is covered
// without a DB in page-grading-acceptance-test.ts.
//
// Run with: npx tsx src/server/data/page-grading-db-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import { gradeUserPagePicks, sportNamesWithDuePendingPicks, type PageGradingDeps } from "@/server/data/page-grading";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const tag = `t-gradegate-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const HOUR = 3600_000;

async function main() {
  const now = new Date();
  const userIds: string[] = [];
  const sportIds: string[] = [];
  try {
    const mkUser = async (n: string) => {
      const u = await prisma.user.create({ data: { supabaseId: `${tag}-${n}`, email: `${tag}-${n}@example.test` } });
      userIds.push(u.id);
      const c = await prisma.capper.create({ data: { userId: u.id, name: `${tag}-${n}`, source: "OTHER" } });
      return { userId: u.id, capperId: c.id };
    };
    const mkSport = async (name: string) => {
      const s = await prisma.sport.create({ data: { name } });
      sportIds.push(s.id);
      return s.id;
    };
    const mkPick = (
      who: { userId: string; capperId: string },
      sportId: string,
      gameTime: Date,
      status: "PENDING" | "WIN" = "PENDING"
    ) =>
      prisma.pick.create({
        data: {
          ...who,
          sportId,
          homeTeam: "Home",
          awayTeam: "Away",
          betType: "MONEYLINE",
          odds: -110,
          units: 1,
          gameTime,
          status,
        },
      });

    const me = await mkUser("me");
    const other = await mkUser("other");
    const started = await mkSport(`${tag}-started`);
    const soon = await mkSport(`${tag}-soon`);
    const future = await mkSport(`${tag}-future`);
    const graded = await mkSport(`${tag}-graded`);
    const others = await mkSport(`${tag}-others`);

    await mkPick(me, started, new Date(now.getTime() - 2 * HOUR)); // started, PENDING -> due
    await mkPick(me, soon, new Date(now.getTime() + 5 * HOUR)); // inside the 6h drift tolerance -> due
    await mkPick(me, future, new Date(now.getTime() + 7 * HOUR)); // beyond it -> not due
    await mkPick(me, graded, new Date(now.getTime() - 2 * HOUR), "WIN"); // already graded -> not due
    await mkPick(other, others, new Date(now.getTime() - 2 * HOUR)); // someone else's -> not due

    const due = [...(await sportNamesWithDuePendingPicks(me.userId, now))].sort();
    expect(
      "gate: started + within-6h PENDING sports only (not far-future, graded, or another user's)",
      due,
      [`${tag}-soon`, `${tag}-started`].sort()
    );
    expect("gate: user with no picks -> empty", (await sportNamesWithDuePendingPicks("no-such-user", now)).size, 0);

    // End to end through the real gate: a due MLB pick triggers persist + grade for MLB only.
    const mlb = await prisma.sport.upsert({ where: { name: "MLB" }, update: {}, create: { name: "MLB" } });
    const mlbUser = await mkUser("mlb");
    await mkPick(mlbUser, mlb.id, new Date(now.getTime() - 3 * HOUR));
    const calls = { persist: [] as string[], grade: [] as string[] };
    const deps: PageGradingDeps = {
      now: () => now.getTime() + 10 * 86400_000, // fresh memo window, never collides with real traffic
      dueSportNames: sportNamesWithDuePendingPicks,
      claimWindow: async () => true,
      persist: async (k) => void calls.persist.push(k),
      grade: async (_u, name) => void calls.grade.push(name),
    };
    await gradeUserPagePicks(mlbUser.userId, undefined, deps, 45);
    expect("e2e: due MLB pick -> persist MLB once", calls.persist, ["baseball_mlb"]);
    expect("e2e: due MLB pick -> grade MLB only", calls.grade, ["MLB"]);

    calls.persist.length = 0;
    calls.grade.length = 0;
    await gradeUserPagePicks(other.userId, undefined, deps, 45);
    expect("e2e: user whose only pending pick is in a non-resolvable sport -> no persist/grade", [calls.persist, calls.grade], [[], []]);
  } finally {
    // Picks/cappers cascade from the user; sports have no cascade, so picks go first.
    await prisma.pick.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.sport.deleteMany({ where: { id: { in: sportIds } } });
    await prisma.$disconnect();
  }

  if (failures > 0) {
    console.log(`\n${failures} assertion(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll assertions passed");
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
