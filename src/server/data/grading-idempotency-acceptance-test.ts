// Proof for the conditional grading writes (updateMany + PENDING / fuzzy
// predicate) added to gradePickPool / regradeFuzzyPool / gradeAllPendingLegs
// / regradeAllFuzzyMatchedLegs. The bug they fix: update({ where: { id } })
// throws Prisma P2025 if the row was deleted mid-run (the /picks delete
// feature), and that rejection propagates out of Promise.all and 500s the
// whole grading cron with no retry.
//
// Covers: duplicate delivery, deletion race, partial batch failure, and that
// a count-0 leg is excluded from the parent-parlay recompute.
//
// Pure: the prisma singleton's methods are swapped for spies before each
// call, so no database is touched. Run with:
//   npx tsx src/server/data/grading-idempotency-acceptance-test.ts
// Exits non-zero on any failed assertion.
import { prisma } from "@/lib/prisma";
import { gradePickPool, regradeFuzzyPool } from "@/server/data/grading";
import { gradeAllPendingLegs } from "@/server/data/parlay-grading";
import type { Pick, Leg, GameResult } from "@prisma/client";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const SPORT_KEY = "baseball_mlb";
const SPORT_NAME = "MLB";
const T = new Date("2026-06-01T23:00:00Z");

const gameResult = (over: Partial<GameResult> = {}): GameResult =>
  ({
    id: "gr-1",
    sportKey: SPORT_KEY,
    externalId: "ext-1",
    homeTeam: "Yankees",
    awayTeam: "Red Sox",
    homeScore: 5,
    awayScore: 3,
    firstFiveHomeScore: null,
    firstFiveAwayScore: null,
    firstInningHomeScore: null,
    firstInningAwayScore: null,
    gameDate: T,
    ...over,
  }) as unknown as GameResult;

const pendingPick = (id: string, over: Partial<Pick> = {}): Pick =>
  ({
    id,
    userId: "user-" + id,
    status: "PENDING",
    betType: "MONEYLINE",
    period: "FULL_GAME",
    betDetail: null,
    line: null,
    homeTeam: "Yankees",
    awayTeam: "Red Sox",
    gameTime: T,
    pickedSide: "HOME",
    ...over,
  }) as unknown as Pick;

// Restores prisma methods this suite patches, between cases.
const originals: Record<string, unknown> = {};
function patch(path: string, fn: unknown) {
  const [model, method] = path.split(".");
  const target = (prisma as unknown as Record<string, Record<string, unknown>>)[model];
  originals[path] ??= target[method];
  target[method] = fn;
}
function restoreAll() {
  for (const path of Object.keys(originals)) {
    const [model, method] = path.split(".");
    (prisma as unknown as Record<string, Record<string, unknown>>)[model][method] = originals[path];
  }
}

async function main() {
  // ---- 1. Duplicate delivery: a second pass over the same picks writes nothing ----
  {
    const updateManyCalls: unknown[] = [];
    let nextCount = 1;
    patch("gameResult.findMany", async () => [gameResult()]);
    patch("pick.updateMany", async (args: unknown) => {
      updateManyCalls.push(args);
      return { count: nextCount };
    });

    const first = await gradePickPool([pendingPick("a"), pendingPick("b")], SPORT_KEY, SPORT_NAME);
    expect("first pass grades both", { graded: first.graded, users: first.changedUserIds.size }, { graded: 2, users: 2 });

    nextCount = 0; // now the rows are no longer PENDING
    const second = await gradePickPool([pendingPick("a"), pendingPick("b")], SPORT_KEY, SPORT_NAME);
    expect(
      "second pass grades nothing, adds no changedUserIds",
      { graded: second.graded, users: second.changedUserIds.size, notMatched: second.notMatched },
      { graded: 0, users: 0, notMatched: 0 }
    );
    expect(
      "every write was updateMany gated on status: PENDING",
      (updateManyCalls[0] as { where: Record<string, unknown> }).where,
      { id: "a", status: "PENDING" }
    );
  }

  // ---- 2. Deletion race: updateMany count 0 is a clean no-op, never a throw ----
  {
    patch("gameResult.findMany", async () => [gameResult()]);
    patch("pick.updateMany", async () => ({ count: 0 })); // row deleted between findMany and update

    let threw = false;
    let result: { graded: number; notMatched: number } | null = null;
    try {
      result = await gradePickPool([pendingPick("x"), pendingPick("y")], SPORT_KEY, SPORT_NAME);
    } catch {
      threw = true;
    }
    expect("deleted-mid-run pick does not throw (would be P2025 with update())", threw, false);
    expect("nothing counted as graded", result && result.graded, 0);
  }

  // ---- 3. Partial batch failure: writes are independent, not all-or-nothing ----
  {
    patch("gameResult.findMany", async () => [gameResult()]);
    let calls = 0;
    patch("pick.updateMany", async () => {
      calls += 1;
      if (calls === 2) throw new Error("simulated transient write failure");
      return { count: 1 };
    });

    let threw = false;
    try {
      await gradePickPool([pendingPick("p1"), pendingPick("p2"), pendingPick("p3")], SPORT_KEY, SPORT_NAME);
    } catch {
      threw = true;
    }
    expect("a failed write propagates (so the retry re-queries PENDING)", threw, true);
    expect("the other writes in the batch still executed (no batch transaction)", calls, 3);
  }

  // ---- 3b. regradeFuzzyPool: duplicate delivery upgrades nothing the second time ----
  {
    const graded = (id: string): Pick =>
      pendingPick(id, { status: "LOSS", betDetail: "Yankees ML", pickedSide: null, gradedViaFuzzyMatch: true } as Partial<Pick>);
    patch("gameResult.findMany", async () => [gameResult()]); // exact match -> outcome WIN, != LOSS -> "changed"
    let nextCount = 1;
    patch("pick.updateMany", async () => ({ count: nextCount }));

    const first = await regradeFuzzyPool([graded("r1")], SPORT_KEY, SPORT_NAME);
    expect("first regrade upgrades the fuzzy pick", first.upgraded, 1);

    nextCount = 0; // already upgraded / no longer gradedViaFuzzyMatch
    const second = await regradeFuzzyPool([graded("r1")], SPORT_KEY, SPORT_NAME);
    expect("second regrade upgrades nothing", { upgraded: second.upgraded, users: second.changedUserIds.size }, { upgraded: 0, users: 0 });
  }

  // ---- 4. Parlay recompute: a count-0 leg is excluded from the parent recompute ----
  {
    const legRow = (id: string, parlayBetId: string): Leg =>
      ({
        id,
        parlayBetId,
        legIndex: 0,
        sportId: "s1",
        status: "PENDING",
        betType: "MONEYLINE",
        period: "FULL_GAME",
        betDetail: "Yankees ML",
        line: null,
        homeTeam: "Yankees",
        awayTeam: "Red Sox",
        gameTime: T,
      }) as unknown as Leg;

    patch("sport.findUnique", async () => ({ id: "s1", name: SPORT_NAME }));
    patch("leg.count", async () => 2);
    patch("gameResult.findMany", async () => [gameResult()]);
    patch("leg.findMany", async (args: { where?: Record<string, unknown> }) => {
      // gradeAllPendingLegs' pending-list query vs recomputeParlayBetStatus' per-parlay query
      if (args.where && args.where.status === "PENDING") return [legRow("legA", "P1"), legRow("legB", "P2")];
      return [{ status: "WIN" }, { status: "WIN" }];
    });
    // legA writes (count 1), legB is already graded / gone (count 0)
    patch("leg.updateMany", async (args: { where: { id: string } }) => ({ count: args.where.id === "legA" ? 1 : 0 }));

    const recomputeFindUniqueIds: string[] = [];
    patch("parlayBet.findUnique", async (args: { where: { id: string } }) => {
      recomputeFindUniqueIds.push(args.where.id);
      return { status: "PENDING" };
    });
    const parlayUpdateManyIds: string[] = [];
    patch("parlayBet.updateMany", async (args: { where: { id: string } }) => {
      parlayUpdateManyIds.push(args.where.id);
      return { count: 1 };
    });

    const res = await gradeAllPendingLegs(SPORT_KEY, SPORT_NAME);
    expect("only legA counted as graded (legB matched 0 rows)", res.graded, 1);
    expect("recompute ran for P1 only, never P2", recomputeFindUniqueIds.sort(), ["P1"]);
    expect("parent write (CAS) happened for P1 only", parlayUpdateManyIds.sort(), ["P1"]);
  }

  restoreAll();
  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
  if (failures > 0) process.exit(1);
}

main();
