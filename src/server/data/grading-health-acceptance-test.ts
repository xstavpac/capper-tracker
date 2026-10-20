// Grading tab against a real database: gradePickPool records why it couldn't
// grade a pick (pick_grade_failures), and the page's one statement finds the
// stuck ones.
//
//   A  NRFI whose final matched but has no first-inning score: "matched but
//      couldn't grade", final 4h ago -> stuck (3h rule)
//   B  moneyline with no final at all, started 10h ago -> stuck (8h rule)
//   C  moneyline with no final, started 2h ago -> not stuck yet
//
// A second pass counts the retry. The combined status statement's grading
// check runs. Everything is seeded under its own user and deleted by id.
//
// DB-backed (runs when DATABASE_URL is set). Run with:
//   npx tsx src/server/data/grading-health-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import { gradePickPool } from "@/server/data/grading";
import { loadGradingView } from "@/server/data/grading-health";
import { loadAdminStatus } from "@/server/data/admin-status";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const PREFIX = "__GradingHealth__";
const H = 3600000;

async function main() {
  const now = new Date();
  const userId = `${PREFIX}user`;
  const capperId = `${PREFIX}capper`;
  const gameResultId = `${PREFIX}game`;
  const pickIds = { A: `${PREFIX}pick-a`, B: `${PREFIX}pick-b`, C: `${PREFIX}pick-c` };
  let createdSportId: string | null = null;

  try {
    let sport = await prisma.sport.findUnique({ where: { name: "MLB" } });
    if (!sport) {
      sport = await prisma.sport.create({ data: { name: "MLB" } });
      createdSportId = sport.id;
    }
    await prisma.user.create({ data: { id: userId, supabaseId: `${PREFIX}sb`, email: `${PREFIX}user@example.invalid` } });
    await prisma.capper.create({ data: { id: capperId, userId, name: `${PREFIX} Capper`, source: "OTHER" } });
    await prisma.gameResult.create({
      data: {
        id: gameResultId,
        sportKey: "baseball_mlb",
        externalId: `${PREFIX}ext`,
        homeTeam: "Gh Home Herons",
        awayTeam: "Gh Away Ospreys",
        homeScore: 4,
        awayScore: 2,
        gameDate: new Date(now.getTime() - 5 * H),
        createdAt: new Date(now.getTime() - 4 * H), // first seen final 4h ago
      },
    });
    const pick = (id: string, over: Record<string, unknown>) => ({
      id,
      userId,
      capperId,
      sportId: sport!.id,
      odds: -110,
      units: 1,
      status: "PENDING" as const,
      ...over,
    });
    await prisma.pick.createMany({
      data: [
        pick(pickIds.A, { homeTeam: "Gh Home Herons", awayTeam: "Gh Away Ospreys", betType: "NRFI", betDetail: "NRFI Herons/Ospreys", gameTime: new Date(now.getTime() - 5 * H) }),
        pick(pickIds.B, { homeTeam: "Gh Lost Larks", awayTeam: "Gh Lost Loons", betType: "MONEYLINE", betDetail: "Larks ML", pickedSide: "HOME", gameTime: new Date(now.getTime() - 10 * H) }),
        pick(pickIds.C, { homeTeam: "Gh Late Lynx", awayTeam: "Gh Late Lemurs", betType: "MONEYLINE", betDetail: "Lynx ML", pickedSide: "HOME", gameTime: new Date(now.getTime() - 2 * H) }),
      ] as never,
    });
    const seeded = await prisma.pick.findMany({ where: { id: { in: Object.values(pickIds) }, userId } });

    const run1 = await gradePickPool(seeded, "baseball_mlb", "MLB");
    expect("pass 1: nothing graded, all three missed", [run1.graded, run1.notMatched], [0, 3]);
    const rows = await prisma.pickGradeFailure.findMany({ where: { pickId: { in: Object.values(pickIds) } }, orderBy: { pickId: "asc" } });
    expect("a failure row per miss", rows.map((r) => r.pickId), [pickIds.A, pickIds.B, pickIds.C]);
    const a = rows.find((r) => r.pickId === pickIds.A)!;
    expect("A: matched final recorded with when it went final, and why it can't be graded", [a.gameResultId, a.finalSeenAt?.toISOString(), a.reason.startsWith("matched a final game but couldn't grade this NRFI")], [gameResultId, new Date(now.getTime() - 4 * H).toISOString(), true]);
    const b = rows.find((r) => r.pickId === pickIds.B)!;
    expect("B: no match, no final time", [b.gameResultId, b.finalSeenAt, b.reason.startsWith("no final game matched")], [null, null, true]);

    await gradePickPool(seeded, "baseball_mlb", "MLB");
    const a2 = await prisma.pickGradeFailure.findUnique({ where: { pickId: pickIds.A } });
    expect("pass 2: the retry is counted, first-seen kept", [a2?.attempts, a2?.firstSeenAt.toISOString()], [2, a.firstSeenAt.toISOString()]);

    const view = await loadGradingView(new Date());
    const mine = view.stuck.filter((p) => Object.values(pickIds).includes(p.id));
    expect("stuck: A (final 4h ago) and B (no final, 10h), not C (2h)", mine.map((p) => p.id).sort(), [pickIds.A, pickIds.B]);
    expect("stuck A carries its reason and final time", [mine.find((p) => p.id === pickIds.A)?.reason?.startsWith("matched a final game"), mine.find((p) => p.id === pickIds.A)?.finalSeenAt instanceof Date], [true, true]);
    const mlb = view.bySport.find((s) => s.sport === "MLB");
    expect("MLB row counts them (at least our 3 pending, 2 stuck), auto-graded", [(mlb?.pending ?? 0) >= 3, (mlb?.stuck ?? 0) >= 2, mlb?.autoGraded], [true, true, true]);
    expect("stuck total >= ours", view.stuckTotal >= 2, true);

    const alerts = await loadAdminStatus();
    expect("combined status statement: grading dot is on, not a failed check", [!!alerts.grading, (alerts.grading ?? "").startsWith("Status check failed")], [true, false]);
  } finally {
    await prisma.pick.deleteMany({ where: { id: { in: Object.values(pickIds) }, userId } });
    await prisma.gameResult.deleteMany({ where: { id: gameResultId } });
    await prisma.capper.deleteMany({ where: { id: capperId, userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    if (createdSportId) await prisma.sport.deleteMany({ where: { id: createdSportId } });
    const left = await prisma.pickGradeFailure.count({ where: { pickId: { in: Object.values(pickIds) } } });
    console.log(`cleanup: seeded rows deleted by id (failure rows left: ${left})`);
  }

  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nGrading health DB checks passed.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
