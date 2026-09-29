// Proof for persistFinalScores' odds/GameResult egress behavior:
//   1. OUTPUT IS UNCHANGED: the GameResult rows written (incl. the ledger
//      fields favTeam / totalLine / lineSource) and the pick statuses the
//      grader then assigns are byte-identical to what the pre-change code
//      produced. The EXPECTED_* constants below were captured by running this
//      same scenario against the code before the change.
//   2. ODDS ARE READ LAZILY: a run with no finals, or where no final needs
//      ledger fields (every final's row already has favTeam), performs ZERO
//      OddsSnapshot reads; a run where some final does need them performs
//      exactly ONE, however many finals there are.
//   3. GameResult existence checks are ONE batched read per run, not one
//      findUnique per final.
//
// DB-backed (seeded throwaway DB - see scripts/run-tests.mjs). Stubs global
// fetch (MLB schedule + live-feed) and freezes the clock so the scenario is
// independent of the calendar. Cleans up everything it creates. Run with:
//   npx tsx src/server/data/persist-final-scores-lazy-odds-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { persistFinalScores, gradeAllPendingPicks, fetchExistingResultState } from "@/server/data/grading";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!pass) failures++;
}

const SPORT = "baseball_mlb";
const FETCH_DATE = "2026-06-15";
const PREFIX = "lazyodds-";
const T0 = Date.parse("2026-06-15T14:00:00Z");

// --- frozen, steppable clock (each scenario advances an hour so the
// getLiveScoresForSport process-local memo from the previous one has expired,
// staying inside the same Eastern day so the odds snapshot key is stable).
const RealDate = Date;
let now = T0;
class FakeDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(now);
    else super(...(args as [string]));
  }
  static now() {
    return now;
  }
}
function freezeClock() {
  (globalThis as { Date: unknown }).Date = FakeDate;
}
function unfreezeClock() {
  (globalThis as { Date: unknown }).Date = RealDate;
}

// --- MLB schedule fixtures
type Fx = { pk: number; home: string; away: string; state: "Final" | "Preview"; hs: number; as: number; at: string };
const G_NEEDS = { pk: 990001, home: "Boston Red Sox", away: "New York Yankees", state: "Final", hs: 5, as: 3, at: "2026-06-15T17:05:00Z" } as Fx;
const G_HAS = { pk: 990002, home: "Chicago Cubs", away: "St. Louis Cardinals", state: "Final", hs: 2, as: 7, at: "2026-06-15T17:10:00Z" } as Fx;
const G_NOODDS = { pk: 990003, home: "Houston Astros", away: "Texas Rangers", state: "Final", hs: 1, as: 0, at: "2026-06-15T17:15:00Z" } as Fx;
const G_PREVIEW = { pk: 990004, home: "Seattle Mariners", away: "Oakland Athletics", state: "Preview", hs: 0, as: 0, at: "2026-06-15T23:05:00Z" } as Fx;

let slate: Fx[] = [];
let feedFetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown) => {
  const url = String(input);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (url.includes("statsapi.mlb.com/api/v1/schedule")) {
    return json({
      dates: [
        {
          games: slate.map((g) => ({
            gamePk: g.pk,
            gameDate: g.at,
            gameNumber: 1,
            doubleHeader: "N",
            status: { abstractGameState: g.state },
            teams: { home: { team: { name: g.home }, score: g.hs }, away: { team: { name: g.away }, score: g.as } },
            linescore: {
              innings: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ num: n, home: { runs: n === 1 ? 1 : 0 }, away: { runs: n === 2 ? 2 : 0 } })),
            },
          })),
        },
      ],
    });
  }
  if (url.includes("statsapi.mlb.com/api/v1.1/game/") && url.endsWith("/feed/live")) {
    feedFetches++;
    return json({
      liveData: {
        linescore: {
          innings: [1, 2, 3, 4, 5].map((n) => ({ num: n, home: { runs: n === 1 ? 1 : 0 }, away: { runs: n === 2 ? 2 : 0 } })),
        },
      },
    });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

// --- prisma spies (count, then delegate to the real method)
const counts = { oddsSnapshot: 0, gameResultFindUnique: 0, gameResultBatch: 0 };
type AnyFn = (...a: unknown[]) => unknown;
const restores: (() => void)[] = [];
function spy(model: string, method: string, onCall: () => void) {
  const target = (prisma as unknown as Record<string, Record<string, AnyFn>>)[model];
  const orig = target[method];
  target[method] = function (...a: unknown[]) {
    onCall();
    return orig.apply(target, a);
  };
  restores.push(() => {
    target[method] = orig;
  });
}
for (const m of ["findUnique", "findFirst", "findMany", "findUniqueOrThrow", "findFirstOrThrow", "count", "aggregate"]) {
  spy("oddsSnapshot", m, () => counts.oddsSnapshot++);
}
spy("gameResult", "findUnique", () => counts.gameResultFindUnique++);
spy("gameResult", "findMany", () => counts.gameResultBatch++);
// The batched existence read may be a raw query (it projects null-flags for
// the JSON columns instead of transferring them) - count those too. Raw
// queries reach the driver as a tagged template / Prisma.sql object whose
// text mentions the table.
const origQueryRaw = prisma.$queryRaw.bind(prisma);
(prisma as unknown as { $queryRaw: unknown }).$queryRaw = (...a: unknown[]) => {
  const sqlText = JSON.stringify(a[0] ?? "");
  if (sqlText.includes("game_results")) counts.gameResultBatch++;
  return (origQueryRaw as unknown as AnyFn)(...a);
};
restores.push(() => {
  (prisma as unknown as { $queryRaw: unknown }).$queryRaw = origQueryRaw;
});

function resetCounts() {
  counts.oddsSnapshot = 0;
  counts.gameResultFindUnique = 0;
  counts.gameResultBatch = 0;
  feedFetches = 0;
}

let createdSport = false;
async function cleanup() {
  await prisma.pick.deleteMany({ where: { notes: { startsWith: PREFIX } } });
  await prisma.gameResult.deleteMany({ where: { sportKey: SPORT, externalId: { startsWith: "9900" } } });
  await prisma.oddsSnapshot.deleteMany({ where: { sportKey: SPORT, fetchDate: FETCH_DATE } });
  await prisma.capper.deleteMany({ where: { name: PREFIX + "capper" } });
  await prisma.user.deleteMany({ where: { supabaseId: PREFIX + "user" } });
  // Only drop the Sport row if this run created it (other suites own theirs).
  if (createdSport) await prisma.sport.deleteMany({ where: { name: "MLB" } });
}

const oddsGame = (g: Fx, homePrice: number, awayPrice: number, total: number | null) => ({
  id: "odds-" + g.pk,
  sport_key: SPORT,
  commenceTime: g.at,
  homeTeam: g.home,
  awayTeam: g.away,
  bookmakers: [
    {
      key: "book",
      title: "Book",
      markets: [
        {
          key: "h2h",
          outcomes: [
            { name: g.home, price: homePrice },
            { name: g.away, price: awayPrice },
          ],
        },
        ...(total === null
          ? []
          : [
              {
                key: "totals",
                outcomes: [
                  { name: "Over", price: -110, point: total },
                  { name: "Under", price: -110, point: total },
                ],
              },
            ]),
      ],
    },
  ],
});

// Captures exactly what the change must not alter.
async function snapshotRows() {
  const rows = await prisma.gameResult.findMany({
    where: { sportKey: SPORT, externalId: { startsWith: "9900" } },
    orderBy: { externalId: "asc" },
  });
  return rows.map((r) => ({
    externalId: r.externalId,
    homeTeam: r.homeTeam,
    awayTeam: r.awayTeam,
    homeScore: r.homeScore,
    awayScore: r.awayScore,
    firstFive: [r.firstFiveHomeScore, r.firstFiveAwayScore],
    firstInning: [r.firstInningHomeScore, r.firstInningAwayScore],
    favTeam: r.favTeam,
    totalLine: r.totalLine,
    lineSource: r.lineSource,
    isPreseason: r.isPreseason,
    gameNumber: r.gameNumber,
    innings: (r.inningsJson as unknown[] | null)?.length ?? null,
  }));
}

async function run(label: string, games: Fx[]) {
  now += 3600_000;
  slate = games;
  resetCounts();
  freezeClock();
  let written: number;
  try {
    written = await persistFinalScores(SPORT);
  } finally {
    unfreezeClock();
  }
  console.log(`  [${label}] written=${written} oddsSnapshotReads=${counts.oddsSnapshot} gameResultFindUnique=${counts.gameResultFindUnique} gameResultBatchReads=${counts.gameResultBatch} feedFetches=${feedFetches}`);
  return { written, odds: counts.oddsSnapshot, unique: counts.gameResultFindUnique, batch: counts.gameResultBatch };
}

// Filled from a run against the pre-change code (see header).
const EXPECTED_ROWS_AFTER_MIXED: unknown = JSON.parse(
  '[{"externalId":"990001","homeTeam":"Boston Red Sox","awayTeam":"New York Yankees","homeScore":5,"awayScore":3,"firstFive":[1,2],"firstInning":[1,0],"favTeam":"Boston Red Sox","totalLine":8.5,"lineSource":"odds_snapshot","isPreseason":false,"gameNumber":1,"innings":9},{"externalId":"990002","homeTeam":"Chicago Cubs","awayTeam":"St. Louis Cardinals","homeScore":2,"awayScore":7,"firstFive":[1,2],"firstInning":[1,0],"favTeam":"St. Louis Cardinals","totalLine":7,"lineSource":"odds_snapshot","isPreseason":false,"gameNumber":null,"innings":9},{"externalId":"990003","homeTeam":"Houston Astros","awayTeam":"Texas Rangers","homeScore":1,"awayScore":0,"firstFive":[1,2],"firstInning":[1,0],"favTeam":null,"totalLine":null,"lineSource":null,"isPreseason":false,"gameNumber":1,"innings":9}]'
);
const EXPECTED_STATUSES: unknown = JSON.parse(
  '[["lazyodds-has-away","WIN"],["lazyodds-needs-away","LOSS"],["lazyodds-needs-home","WIN"],["lazyodds-noodds-home","WIN"]]'
);

async function main() {
  await cleanup();
  const user = await prisma.user.create({ data: { supabaseId: PREFIX + "user", email: PREFIX + "user@example.invalid" } });
  const capper = await prisma.capper.create({ data: { userId: user.id, name: PREFIX + "capper", source: "OTHER" } });
  const sportExisted = (await prisma.sport.findUnique({ where: { name: "MLB" } })) !== null;
  createdSport = !sportExisted;
  const sport = await prisma.sport.upsert({ where: { name: "MLB" }, update: {}, create: { name: "MLB" } });

  // Today's odds snapshot: G_NEEDS is priced (home favored) with a total;
  // G_HAS is priced (away favored) - but its row will already carry a favTeam,
  // so the snapshot must NOT be consulted for it; G_NOODDS is absent entirely.
  await prisma.oddsSnapshot.create({
    data: {
      sportKey: SPORT,
      fetchDate: FETCH_DATE,
      data: [oddsGame(G_NEEDS, -150, 130, 8.5), oddsGame(G_HAS, 120, -140, 9)] as never,
    },
  });
  // G_HAS already has a complete row incl. favTeam (immutable-once-set).
  await prisma.gameResult.create({
    data: {
      sportKey: SPORT,
      externalId: String(G_HAS.pk),
      homeTeam: G_HAS.home,
      awayTeam: G_HAS.away,
      homeScore: 0,
      awayScore: 0,
      gameDate: new Date(G_HAS.at),
      firstFiveHomeScore: 1,
      firstFiveAwayScore: 2,
      firstInningHomeScore: 1,
      firstInningAwayScore: 0,
      favTeam: G_HAS.away,
      totalLine: 7,
      lineSource: "odds_snapshot",
    },
  });

  // 1. No finals at all -> zero odds reads (and no per-game reads).
  const none = await run("no finals", [G_PREVIEW]);
  expect("no-finals: zero OddsSnapshot reads", none.odds, 0);
  expect("no-finals: nothing written", none.written, 0);

  // 2. Finals exist but none needs ledger fields -> zero odds reads.
  const noneNeeding = await run("no final needs ledger", [G_HAS, G_PREVIEW]);
  expect("no-final-needs-ledger: zero OddsSnapshot reads", noneNeeding.odds, 0);
  expect("no-final-needs-ledger: 1 final written", noneNeeding.written, 1);

  // 3. Mixed: one final needs odds (no row yet), one doesn't, one needs them
  //    but isn't in the snapshot -> exactly one odds read, one batched
  //    GameResult read, no per-game findUnique.
  const mixed = await run("mixed", [G_NEEDS, G_HAS, G_NOODDS, G_PREVIEW]);
  expect("mixed: exactly one OddsSnapshot read", mixed.odds, 1);
  expect("mixed: 3 finals written", mixed.written, 3);
  expect("mixed: no per-game GameResult.findUnique", mixed.unique, 0);
  expect("mixed: exactly one batched GameResult read", mixed.batch, 1);

  const rows = await snapshotRows();
  expect("GameResult rows identical to pre-change output", rows, EXPECTED_ROWS_AFTER_MIXED);

  // 4. Second run over the same finals: rows now complete/immutable. G_NOODDS
  //    still has favTeam null (not in snapshot) so it legitimately still
  //    needs the ledger -> still exactly one read, same outcome.
  const again = await run("rerun", [G_NEEDS, G_HAS, G_NOODDS]);
  expect("rerun: exactly one OddsSnapshot read (G_NOODDS still unresolved)", again.odds, 1);
  const rows2 = await snapshotRows();
  expect("rerun: rows unchanged", rows2, rows);

  // 5. The batched read's "missing" flags must agree with how Prisma reads
  //    each JSON column (SQL NULL and a stored JSON null both read as null in
  //    Prisma - the old per-row gates were `=== null` on that reading).
  await prisma.gameResult.deleteMany({ where: { sportKey: SPORT, externalId: { startsWith: "9900" } } });
  const mkRow = (id: string, j: Record<string, unknown>) =>
    prisma.gameResult.create({
      data: { sportKey: SPORT, externalId: id, homeTeam: "A", awayTeam: "B", homeScore: 1, awayScore: 0, gameDate: new Date(T0), ...j } as never,
    });
  await mkRow("990010", {});
  await mkRow("990011", { linescoreJson: Prisma.JsonNull, quartersJson: Prisma.JsonNull, scoringPlaysJson: Prisma.JsonNull });
  await mkRow("990012", { linescoreJson: [{ home: 1, away: 0 }], quartersJson: [{ home: 1, away: 0 }], scoringPlaysJson: [{ x: 1 }], homeTurnovers: 0, favTeam: "A" });
  const ids = ["990010", "990011", "990012", "990013"];
  const flags = await fetchExistingResultState(SPORT, ids);
  const viaPrisma = await prisma.gameResult.findMany({ where: { sportKey: SPORT, externalId: { in: ids } } });
  for (const r of viaPrisma) {
    const f = flags.get(r.externalId)!;
    expect(`flags match Prisma's null reading for ${r.externalId}`, [f.linescoreMissing, f.quartersMissing, f.scoringPlaysMissing, f.homeTurnovers === null, f.favTeam === null], [r.linescoreJson === null, r.quartersJson === null, r.scoringPlaysJson === null, r.homeTurnovers === null, r.favTeam === null]);
  }
  expect("absent id is simply absent from the map", flags.has("990013"), false);
  await prisma.gameResult.deleteMany({ where: { sportKey: SPORT, externalId: { startsWith: "9900" } } });
  // Pick statuses the grader assigns from those rows.
  const mk = (n: string, g: Fx, side: "HOME" | "AWAY") =>
    prisma.pick.create({
      data: {
        userId: user.id,
        capperId: capper.id,
        sportId: sport.id,
        homeTeam: g.home,
        awayTeam: g.away,
        betType: "MONEYLINE",
        odds: -110,
        units: 1,
        gameTime: new Date(g.at),
        pickedSide: side,
        notes: PREFIX + n,
      },
    });
  slate = [G_NEEDS, G_HAS, G_NOODDS];
  await run("rebuild rows for grading", slate);
  await mk("needs-home", G_NEEDS, "HOME");
  await mk("needs-away", G_NEEDS, "AWAY");
  await mk("has-away", G_HAS, "AWAY");
  await mk("noodds-home", G_NOODDS, "HOME");
  const gradedRes = await gradeAllPendingPicks(SPORT, "MLB");
  const picks = await prisma.pick.findMany({ where: { notes: { startsWith: PREFIX } }, orderBy: { notes: "asc" } });
  const statuses = picks.map((p) => [p.notes, p.status]);
  expect("pick statuses identical to pre-change output", statuses, EXPECTED_STATUSES);
  expect("all four picks graded", gradedRes.graded >= 4, true);
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(async () => {
    unfreezeClock();
    restores.forEach((r) => r());
    globalThis.fetch = realFetch;
    await cleanup().catch(() => {});
    await prisma.$disconnect();
    console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  });
