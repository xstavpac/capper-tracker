// Proof for the grading retry backoff (pick_grade_failures.nextAttemptAt):
//   1. The backoff table: 7 immediate retries, hourly through the 19th, daily
//      through the 29th, stop at the 30th - and the SQL in recordGradeFailures
//      computes the same table as gradeRetryDelaySeconds.
//   2. The candidate query (gradeCandidateWhere) leaves out a pick inside its
//      backoff, a stopped pick, a game days away and a pick past the lookback,
//      and keeps a pick with no row, a due row and a legacy row (NULL).
//   3. The real per-user pass (gradePendingPicks): a "no final matched" pick
//      whose game started under 8h ago is not written up as a failure; one
//      older is, and its row is pushed out; a pick in backoff is not touched.
//   4. A pick that grades loses its failure row; so does one graded by hand.
//   5. New or corrected game data ends the backoff for the picks it concerns.
//
// DB-backed (seeded throwaway rows, every one deleted by id). Run with:
//   npx tsx src/server/data/grading-failures-backoff-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import { gradePendingPicks, gradeCandidateWhere, GRADING_PICK_SELECT } from "@/server/data/grading";
import {
  recordGradeFailures,
  resetGradeFailuresForGames,
  gradeRetryDelaySeconds,
  GRADE_RETRY_STOPPED_AT,
} from "@/server/data/grading-failures";
import { updatePickStatus } from "@/server/data/picks";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!pass) failures++;
}

const PREFIX = "__GradeBackoff__";
const H = 3600000;
const id = (n: string) => `${PREFIX}${n}`;

// ---- 1a. The table, as written down ----
{
  const t = (n: number) => gradeRetryDelaySeconds(n);
  expect("delay: attempts 1..7 retry on the next run", [t(1), t(7)], [0, 0]);
  expect("delay: attempts 8..19 wait an hour", [t(8), t(19)], [3600, 3600]);
  expect("delay: attempts 20..29 wait a day", [t(20), t(29)], [86400, 86400]);
  expect("delay: the 30th failure stops retries", [t(30), t(31), t(402)], [null, null, null]);
}

async function main() {
  const now = new Date();
  const userId = id("user");
  const capperId = id("capper");
  const ids = {
    future: id("future"),
    soon: id("soon"),
    nofail: id("nofail"),
    backoff: id("backoff"),
    due: id("due"),
    legacy: id("legacy"),
    stopped: id("stopped"),
    old: id("old"),
    win: id("win"),
    manual: id("manual"),
    tableProbe: id("probe"),
    resetGame: id("reset-game"),
    resetNoMatch: id("reset-nomatch"),
    resetFar: id("reset-far"),
  };
  const gameResultIds = [id("gr-win"), id("gr-reset")];
  let createdSportId: string | null = null;

  try {
    let sport = await prisma.sport.findUnique({ where: { name: "MLB" } });
    if (!sport) {
      sport = await prisma.sport.create({ data: { name: "MLB" } });
      createdSportId = sport.id;
    }
    await prisma.user.create({ data: { id: userId, supabaseId: id("sb"), email: `${PREFIX}user@example.invalid` } });
    await prisma.capper.create({ data: { id: capperId, userId, name: `${PREFIX} Capper`, source: "OTHER" } });

    const pick = (pid: string, tag: string, gameTime: Date) => ({
      id: pid,
      userId,
      capperId,
      sportId: sport!.id,
      // Distinct last words: the matcher's fuzzy pass keys on a team's last word.
      homeTeam: `Gb ${tag}Home`,
      awayTeam: `Gb ${tag}Away`,
      betType: "MONEYLINE" as const,
      betDetail: `Gb ${tag}Home ML`,
      pickedSide: "HOME" as const,
      odds: -110,
      units: 1,
      status: "PENDING" as const,
      gameTime,
    });
    const ago = (h: number) => new Date(now.getTime() - h * H);
    await prisma.pick.createMany({
      data: [
        pick(ids.future, "Future", new Date(now.getTime() + 72 * H)),
        pick(ids.soon, "Soon", new Date(now.getTime() + 2 * H)),
        pick(ids.nofail, "Nofail", ago(1)),
        pick(ids.backoff, "Backoff", ago(10)),
        pick(ids.due, "Due", ago(10)),
        pick(ids.legacy, "Legacy", ago(10)),
        pick(ids.stopped, "Stopped", ago(10)),
        pick(ids.old, "Old", ago(24 * 20)),
        pick(ids.win, "Win", ago(3)),
        pick(ids.manual, "Manual", ago(10)),
        pick(ids.tableProbe, "Probe", ago(10)),
        pick(ids.resetGame, "ResetGame", ago(10)),
        pick(ids.resetNoMatch, "ResetNoMatch", ago(30)),
        pick(ids.resetFar, "ResetFar", ago(24 * 6)),
      ] as never,
    });
    const row = (pickId: string, over: Record<string, unknown>) => ({
      pickId,
      reason: "seeded",
      firstSeenAt: ago(5),
      lastSeenAt: ago(1),
      attempts: 3,
      ...over,
    });
    await prisma.pickGradeFailure.createMany({
      data: [
        row(ids.backoff, { nextAttemptAt: new Date(now.getTime() + H) }),
        row(ids.due, { attempts: 8, nextAttemptAt: new Date(now.getTime() - 60000) }),
        row(ids.legacy, { attempts: 5, nextAttemptAt: null }),
        row(ids.stopped, { attempts: 30, nextAttemptAt: GRADE_RETRY_STOPPED_AT }),
        row(ids.old, { nextAttemptAt: null }),
      ],
    });

    // ---- 1b. The SQL computes the same table ----
    for (const n of [1, 2, 7, 8, 19, 20, 29, 30, 31]) {
      if (n > 1) await prisma.pickGradeFailure.upsert({ where: { pickId: ids.tableProbe }, update: { attempts: n - 1 }, create: row(ids.tableProbe, { attempts: n - 1 }) });
      await recordGradeFailures([{ pickId: ids.tableProbe, reason: "probe", gameResultId: null, finalSeenAt: null }]);
      const r = (await prisma.pickGradeFailure.findUnique({ where: { pickId: ids.tableProbe } }))!;
      const want = gradeRetryDelaySeconds(r.attempts);
      const gotSeconds = r.nextAttemptAt ? (r.nextAttemptAt.getTime() - r.lastSeenAt.getTime()) / 1000 : null;
      const ok =
        want === null
          ? r.nextAttemptAt?.getTime() === GRADE_RETRY_STOPPED_AT.getTime()
          : gotSeconds !== null && Math.abs(gotSeconds - want) < 1;
      expect(`SQL backoff after failure ${r.attempts} matches the table (${want === null ? "stop" : want + "s"})`, [r.attempts, ok], [n, true]);
    }

    // ---- 2. The candidate query ----
    const inScope = Object.values(ids);
    const candidates = await prisma.pick.findMany({
      where: { id: { in: inScope }, status: "PENDING", ...gradeCandidateWhere(now) },
      select: GRADING_PICK_SELECT,
    });
    const candidateIds = candidates.map((p) => p.id).sort();
    expect(
      "candidates: no row / due row / legacy NULL row / a game within the 6h gate; not a game days away, a pick in backoff, a stopped one, or one past the lookback",
      candidateIds.filter((p) => [ids.future, ids.soon, ids.nofail, ids.backoff, ids.due, ids.legacy, ids.stopped, ids.old].includes(p)),
      [ids.due, ids.legacy, ids.nofail, ids.soon].sort()
    );
    expect("the candidate read returns only the grading columns", Object.keys(candidates[0] ?? {}).sort(), Object.keys(GRADING_PICK_SELECT).sort());

    // ---- 3 + 4. The real per-user pass ----
    await prisma.gameResult.create({
      data: { id: gameResultIds[0], sportKey: "baseball_mlb", externalId: id("ext-win"), homeTeam: "Gb WinHome", awayTeam: "Gb WinAway", homeScore: 5, awayScore: 3, gameDate: ago(3) },
    });
    await prisma.pickGradeFailure.create({ data: row(ids.win, { reason: "seeded", attempts: 4 }) });
    await prisma.pickGradeFailure.create({ data: row(ids.manual, { reason: "seeded", attempts: 4 }) });

    const before = await prisma.pickGradeFailure.findMany({ where: { pickId: { in: [ids.backoff, ids.stopped] } }, orderBy: { pickId: "asc" } });
    const run = await gradePendingPicks(userId, "MLB", "baseball_mlb");
    expect("pass: only the win graded", run.graded, 1);
    const rowsAfter = await prisma.pickGradeFailure.findMany({ where: { pickId: { in: inScope } } });
    const byPick = new Map(rowsAfter.map((r) => [r.pickId, r]));
    expect("graded pick: its failure row is gone", byPick.has(ids.win), false);
    expect("a no-match pick whose game started 1h ago is not written up yet", byPick.has(ids.nofail), false);
    expect("a pick for a game 2h away is not written up either", byPick.has(ids.soon), false);
    expect("the due pick (10h, no match) was counted: attempt 9, an hour out", [byPick.get(ids.due)?.attempts, Math.round(((byPick.get(ids.due)?.nextAttemptAt?.getTime() ?? 0) - (byPick.get(ids.due)?.lastSeenAt.getTime() ?? 0)) / 1000)], [9, 3600]);
    expect("the legacy NULL row was counted: attempt 6, next run", [byPick.get(ids.legacy)?.attempts, Math.round(((byPick.get(ids.legacy)?.nextAttemptAt?.getTime() ?? 0) - (byPick.get(ids.legacy)?.lastSeenAt.getTime() ?? 0)) / 1000)], [6, 0]);
    const afterIn = rowsAfter.filter((r) => [ids.backoff, ids.stopped].includes(r.pickId)).sort((a, b) => a.pickId.localeCompare(b.pickId));
    expect("a pick in backoff and a stopped pick were not touched", afterIn.map((r) => [r.attempts, r.lastSeenAt.getTime()]), before.map((r) => [r.attempts, r.lastSeenAt.getTime()]));

    await updatePickStatus(userId, ids.manual, "WIN");
    expect("graded by hand: its failure row is gone", (await prisma.pickGradeFailure.findUnique({ where: { pickId: ids.manual } })) === null, true);

    // ---- 5. New or corrected game data ends the backoff ----
    await prisma.gameResult.create({
      data: { id: gameResultIds[1], sportKey: "baseball_mlb", externalId: id("ext-reset"), homeTeam: "Gb ResetGameHome", awayTeam: "Gb ResetGameAway", homeScore: 1, awayScore: 0, gameDate: ago(10) },
    });
    // The pass above already wrote these up (no match, more than 8h old); start from known rows.
    await prisma.pickGradeFailure.deleteMany({ where: { pickId: { in: [ids.resetGame, ids.resetNoMatch, ids.resetFar] } } });
    await prisma.pickGradeFailure.createMany({
      data: [
        row(ids.resetGame, { gameResultId: gameResultIds[1], reason: "matched a final game but couldn't grade" }),
        row(ids.resetNoMatch, { gameResultId: null }),
        row(ids.resetFar, { gameResultId: null }),
      ],
    });
    await resetGradeFailuresForGames({ sportId: null, gameResultIds: [gameResultIds[1]], newGameDates: [] });
    const left1 = new Set((await prisma.pickGradeFailure.findMany({ where: { pickId: { in: [ids.resetGame, ids.resetNoMatch, ids.resetFar] } } })).map((r) => r.pickId));
    expect("a corrected game ends the backoff of the picks matched to it, and only them", [...left1].sort(), [ids.resetFar, ids.resetNoMatch].sort());
    await resetGradeFailuresForGames({ sportId: sport.id, gameResultIds: [], newGameDates: [ago(30)] });
    const left2 = new Set((await prisma.pickGradeFailure.findMany({ where: { pickId: { in: [ids.resetNoMatch, ids.resetFar] } } })).map((r) => r.pickId));
    expect("a new final ends the backoff of no-match picks within +-2 days of it, not a pick 6 days away", [...left2], [ids.resetFar]);
    await resetGradeFailuresForGames({ sportId: null, gameResultIds: [], newGameDates: [] });
    expect("nothing new: no statement, nothing deleted", (await prisma.pickGradeFailure.count({ where: { pickId: ids.resetFar } })), 1);
  } finally {
    await prisma.pick.deleteMany({ where: { id: { in: Object.values(ids) }, userId } });
    await prisma.gameResult.deleteMany({ where: { id: { in: gameResultIds } } });
    await prisma.capper.deleteMany({ where: { id: capperId, userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    if (createdSportId) await prisma.sport.deleteMany({ where: { id: createdSportId } });
    const left = await prisma.pickGradeFailure.count({ where: { pickId: { in: Object.values(ids) } } });
    console.log(`cleanup: seeded rows deleted by id (failure rows left: ${left})`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(async () => {
    await prisma.$disconnect();
    console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  });
