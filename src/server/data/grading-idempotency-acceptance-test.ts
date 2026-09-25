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
// Section 5 covers a separate concern - the fetchCandidatePool egress fix
// (narrowed `select`, the date bound it derives from the actual picks being
// graded, and skipping the query entirely for an empty pool) - via the same
// gameResult.findMany-patching approach.
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

  // ---- 5. fetchCandidatePool egress fix: narrowed select, pick-derived date
  // bound, and skip-when-empty. All exercised through gradePickPool/
  // regradeFuzzyPool (not fetchCandidatePool directly - it isn't exported),
  // the same way the rest of this file proves grading.ts's internals. ----

  const CANDIDATE_SELECT_SHAPE = {
    gameDate: true,
    homeTeam: true,
    awayTeam: true,
    externalId: true,
    homeScore: true,
    awayScore: true,
    firstFiveHomeScore: true,
    firstFiveAwayScore: true,
    firstInningHomeScore: true,
    firstInningAwayScore: true,
    linescoreJson: true,
    gameNumber: true,
  };

  // 5a. Only the columns grading actually reads are selected - no JSON blobs
  // beyond linescoreJson (which resolveOutcome's segmentScore does read, for
  // quarter/period bets), no turnover/ledger/isPreseason fields. gameNumber IS
  // included - matchGameResult requires it to disambiguate two doubleheader
  // legs (see its own comment).
  {
    const findManyCalls: { select?: unknown }[] = [];
    patch("gameResult.findMany", async (args: { select?: unknown }) => {
      findManyCalls.push(args);
      return [gameResult()];
    });
    patch("pick.updateMany", async () => ({ count: 1 }));

    await gradePickPool([pendingPick("sel-a")], SPORT_KEY, SPORT_NAME);

    expect("candidate query selects exactly the columns grading reads", findManyCalls[0].select, CANDIDATE_SELECT_SHAPE);
  }

  // 5b. The date range is derived from the actual picks being graded (the
  // earliest/latest gameTime in THIS call, +/-2d), never a hardcoded window.
  {
    const findManyCalls: { where?: { gameDate?: { gte: Date; lt: Date } } }[] = [];
    patch("gameResult.findMany", async (args: { where?: { gameDate?: { gte: Date; lt: Date } } }) => {
      findManyCalls.push(args);
      return [];
    });
    patch("pick.updateMany", async () => ({ count: 0 }));

    const DAY = 86400000;
    const earliest = new Date("2026-06-01T00:00:00Z");
    const latest = new Date("2026-06-10T00:00:00Z");
    await gradePickPool(
      [pendingPick("d1", { gameTime: earliest }), pendingPick("d2", { gameTime: latest })],
      SPORT_KEY,
      SPORT_NAME
    );

    const where = findManyCalls[0].where!.gameDate!;
    expect("candidate window starts 2 days before the EARLIEST pick's own gameTime", where.gte.getTime(), earliest.getTime() - 2 * DAY);
    expect("candidate window ends 2 days after the LATEST pick's own gameTime", where.lt.getTime(), latest.getTime() + 2 * DAY);
  }

  // 5c. No pending/fuzzy picks -> no GameResult query at all.
  {
    let findManyCalled = false;
    patch("gameResult.findMany", async () => {
      findManyCalled = true;
      return [];
    });

    const graded = await gradePickPool([], SPORT_KEY, SPORT_NAME);
    expect("gradePickPool with an empty pick list issues no GameResult query", findManyCalled, false);
    expect("gradePickPool with an empty pick list returns a clean zero result", { graded: graded.graded, notMatched: graded.notMatched, users: graded.changedUserIds.size }, { graded: 0, notMatched: 0, users: 0 });

    findManyCalled = false;
    const regraded = await regradeFuzzyPool([], SPORT_KEY, SPORT_NAME);
    expect("regradeFuzzyPool with an empty pick list issues no GameResult query", findManyCalled, false);
    expect(
      "regradeFuzzyPool with an empty pick list returns a clean zero result",
      { checked: regraded.checked, upgraded: regraded.upgraded, users: regraded.changedUserIds.size },
      { checked: 0, upgraded: 0, users: 0 }
    );
  }

  // A GameResult row shaped EXACTLY like the narrowed select - no extra
  // fields - proving grading never silently relied on one of the dropped
  // columns (if it did, that field would be `undefined` here and the outcome
  // below would come out wrong instead of matching pre-fix behavior).
  const selectShapedGame = (over: Record<string, unknown> = {}) =>
    ({
      gameDate: T,
      homeTeam: "Yankees",
      awayTeam: "Red Sox",
      externalId: "ext-1",
      homeScore: 5,
      awayScore: 3,
      firstFiveHomeScore: null,
      firstFiveAwayScore: null,
      firstInningHomeScore: null,
      firstInningAwayScore: null,
      linescoreJson: null,
      ...over,
    }) as unknown as GameResult;

  // 5d. Identical grading result (moneyline) off a select-shaped row.
  {
    patch("gameResult.findMany", async () => [selectShapedGame()]);
    const updates: { data: { status: string } }[] = [];
    patch("pick.updateMany", async (args: { data: { status: string } }) => {
      updates.push(args);
      return { count: 1 };
    });

    await gradePickPool([pendingPick("shape-ml", { pickedSide: "HOME" })], SPORT_KEY, SPORT_NAME);
    expect("moneyline grades correctly off a row containing only the selected columns", updates[0].data.status, "WIN");
  }

  // 5d(ii). Same, for a quarter bet - proves linescoreJson (the one JSON
  // column still selected) is still read correctly.
  {
    const quarterGame = selectShapedGame({ linescoreJson: [{ home: 4, away: 3 }] });
    patch("gameResult.findMany", async () => [quarterGame]);
    const updates: { data: { status: string } }[] = [];
    patch("pick.updateMany", async (args: { data: { status: string } }) => {
      updates.push(args);
      return { count: 1 };
    });

    const quarterPick = pendingPick("shape-q1", {
      betType: "TOTAL",
      period: "FIRST_QUARTER",
      betDetail: "Over 6.5 1st Quarter",
      line: 6.5,
      pickedSide: null,
    });
    await gradePickPool([quarterPick], SPORT_KEY, SPORT_NAME);
    expect("1st-quarter total (Q1 combined = 7) grades WIN off the select-shaped row's linescoreJson", updates[0].data.status, "WIN");
  }

  // 5d(iii). Same, for NRFI - proves the firstInning* columns still work.
  {
    const nrfiGame = selectShapedGame({ firstInningHomeScore: 0, firstInningAwayScore: 0 });
    patch("gameResult.findMany", async () => [nrfiGame]);
    const updates: { data: { status: string } }[] = [];
    patch("pick.updateMany", async (args: { data: { status: string } }) => {
      updates.push(args);
      return { count: 1 };
    });

    const nrfiPick = pendingPick("shape-nrfi", { betType: "NRFI", betDetail: "NRFI", pickedSide: null });
    await gradePickPool([nrfiPick], SPORT_KEY, SPORT_NAME);
    expect("NRFI (scoreless 1st) grades WIN off the select-shaped row's firstInning columns", updates[0].data.status, "WIN");
  }

  // 5e. Rescheduled/late game: the actual gameDate lands a few hours after
  // the pick's scheduled gameTime (a rain delay, a late start) - still within
  // MAX_GAME_TIME_DRIFT_MS (6h), so it's still an exact match and still
  // grades, off the select-shaped row.
  {
    const delayedGame = selectShapedGame({ gameDate: new Date(T.getTime() + 3 * 3600000) });
    patch("gameResult.findMany", async () => [delayedGame]);
    const updates: { data: { status: string } }[] = [];
    patch("pick.updateMany", async (args: { data: { status: string } }) => {
      updates.push(args);
      return { count: 1 };
    });

    await gradePickPool([pendingPick("delayed", { pickedSide: "HOME" })], SPORT_KEY, SPORT_NAME);
    expect("a game that started 3h late (within the 6h drift tolerance) still exact-matches and grades", updates[0].data.status, "WIN");
  }

  // 5f. Wide batch: a pick's own game sits right at the edge of the shared
  // multi-pick pool window (fetchCandidatePool spans the earliest pick's
  // gameTime-2d through the latest pick's gameTime+2d) - still matches, since
  // its game is always within 6h of ITS OWN pick's gameTime regardless of how
  // wide the batch is.
  {
    const earlyPickTime = new Date("2026-06-01T12:00:00Z");
    const latePickTime = new Date("2026-06-09T12:00:00Z"); // 8 days later - a wide batch
    const earlyGame = selectShapedGame({ gameDate: earlyPickTime, externalId: "ext-early" });
    const lateGame = selectShapedGame({ gameDate: latePickTime, externalId: "ext-late" });
    patch("gameResult.findMany", async () => [earlyGame, lateGame]);
    const updates: { data: { status: string } }[] = [];
    patch("pick.updateMany", async (args: { data: { status: string } }) => {
      updates.push(args);
      return { count: 1 };
    });

    await gradePickPool(
      [
        pendingPick("wide-early", { gameTime: earlyPickTime, pickedSide: "HOME" }),
        pendingPick("wide-late", { gameTime: latePickTime, pickedSide: "HOME" }),
      ],
      SPORT_KEY,
      SPORT_NAME
    );
    expect("both the early and late pick in a wide batch grade correctly off the one shared, narrowed-select query", updates.length, 2);
    expect(
      "the pick near the edge of the shared window still grades (not silently dropped by the shared query)",
      updates.every((u) => u.data.status === "WIN"),
      true
    );
  }

  restoreAll();
  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
  if (failures > 0) process.exit(1);
}

main();
