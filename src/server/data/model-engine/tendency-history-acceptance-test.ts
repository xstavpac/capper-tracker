// Parity for the batched tendency history (tendency-history.ts): resolving a
// team_tendencies variable from a sync pass's one batch read gives exactly what
// resolveTeamTendency's own per-team query gives - the same value, the same
// snapshot timestamp, the same not-found - and the batch is one query.
//
// Real-database test (seeds a test-only sportKey, removes its rows by id):
//   node --require ./scripts/server-only-stub.cjs --import tsx src/server/data/model-engine/tendency-history-acceptance-test.ts
//
//  1. resolveVariable, every (team, asOf, variable) case, with and without the
//     source: before the first snapshot, on a snapshot date, between dates (a
//     gap), after the last, a team with no snapshots, a team the source wasn't
//     built for, a source for another sportKey.
//  2. Query count: one findMany for every listed-team lookup; an unlisted team
//     or another sport falls back to its own query; no lookup, no query.
//  3. End to end: runModelDefinition(decayDeltaModel) on a seeded graded game,
//     with and without the source (unbounded and bounded): identical context,
//     buckets, unavailable ids.
//  4. The bound: for several asOf spans, every case still matches (an asOf
//     outside the span falls back to the per-team query); the bounded read
//     keeps exactly [latest snapshot at or before the earliest day, latest day];
//     one raw read serves every in-span lookup.
import { prisma } from "@/lib/prisma";
import { easternDayStart } from "@/lib/dates";
import { decayDeltaModel } from "@/lib/model-engine/fixtures/decay-delta";
import { resolveVariable } from "./resolver";
import { runModelDefinition } from "./orchestrate";
import { createTendencyHistorySource } from "./tendency-history";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

const TAG = `th${Date.now()}`;
const SPORT = `test_tendency_${TAG}`;
const A = `${TAG} Alphas`;
const B = `${TAG} Bravos`;
const EMPTY = `${TAG} No Snapshots`;
const UNLISTED = `${TAG} Unlisted`;
const at = (key: string) => new Date(easternDayStart(key).getTime() + 12 * 3_600_000); // noon Eastern
const VARIABLES = ["tendency_fav_win_pct", "tendency_dog_win_pct", "tendency_over_rate"];

// Counts team_tendency_snapshots findMany calls made through the shared client.
let findManyCalls = 0;
const delegate = prisma.teamTendencySnapshot as unknown as { findMany: (...a: unknown[]) => Promise<unknown> };
const realFindMany = delegate.findMany.bind(delegate);
delegate.findMany = (...a: unknown[]) => {
  findManyCalls++;
  return realFindMany(...a);
};
// ...and raw reads (the bounded source's one query).
let rawCalls = 0;
const client = prisma as unknown as { $queryRaw: (...a: unknown[]) => Promise<unknown> };
const realQueryRaw = client.$queryRaw.bind(prisma);
client.$queryRaw = (...a: unknown[]) => {
  rawCalls++;
  return realQueryRaw(...a);
};

async function main() {
  const snapshotIds: string[] = [];
  const gameIds: string[] = [];
  try {
    const snap = (teamName: string, snapshotDate: string, n: number) => ({
      sportKey: SPORT,
      teamName,
      snapshotDate,
      favWins: n,
      favLosses: 10 - n,
      favPushes: 0,
      dogWins: 10 - n,
      dogLosses: n,
      dogPushes: 1,
      overCount: n + 1,
      underCount: 9 - n,
      totalPushCount: 0,
    });
    const seeded = await prisma.$transaction(
      [snap(A, "2031-04-01", 3), snap(A, "2031-04-03", 5), snap(A, "2031-04-06", 7), snap(B, "2031-04-02", 4), snap(B, "2031-04-04", 6), snap(UNLISTED, "2031-04-02", 2)].map(
        (data) => prisma.teamTendencySnapshot.create({ data, select: { id: true } })
      )
    );
    snapshotIds.push(...seeded.map((r) => r.id));

    // 1
    const asOfs = ["2031-03-31", "2031-04-01", "2031-04-02", "2031-04-03", "2031-04-05", "2031-04-06", "2031-04-20"].map(at);
    const teams = [A, B, EMPTY, UNLISTED];
    const source = createTendencyHistorySource(SPORT, [A, B, EMPTY]);
    const otherSport = createTendencyHistorySource(`${SPORT}_other`, [A, B, EMPTY]);
    let cases = 0;
    let mismatches = 0;
    let found = 0;
    for (const teamName of teams) {
      for (const asOf of asOfs) {
        for (const v of VARIABLES) {
          const want = await resolveVariable(v, { type: "team", teamName }, asOf, { sportKey: SPORT });
          const got = await resolveVariable(v, { type: "team", teamName }, asOf, { sportKey: SPORT, tendencyHistory: source });
          const gotOther = await resolveVariable(v, { type: "team", teamName }, asOf, { sportKey: SPORT, tendencyHistory: otherSport });
          cases++;
          if (want.found) found++;
          if (JSON.stringify(got) !== JSON.stringify(want) || JSON.stringify(gotOther) !== JSON.stringify(want)) {
            mismatches++;
            console.log("  mismatch", teamName, asOf.toISOString(), v, JSON.stringify({ want, got, gotOther }));
          }
        }
      }
    }
    check(`all ${cases} (team, asOf, variable) cases identical with and without the batch source`, mismatches, 0);
    check("the cases cover both found and not-found results", found > 0 && found < cases, true);
    const before = await resolveVariable("tendency_fav_win_pct", { type: "team", teamName: A }, asOfs[0], { sportKey: SPORT, tendencyHistory: source });
    check("before the first snapshot: not found", before.found, false);
    const gap = await resolveVariable("tendency_fav_win_pct", { type: "team", teamName: A }, at("2031-04-05"), { sportKey: SPORT, tendencyHistory: source });
    check("in a gap: the latest earlier snapshot (04-03, 5 of 10)", { found: gap.found, value: gap.value }, { found: true, value: 0.5 });

    // 2
    const fresh = createTendencyHistorySource(SPORT, [A, B, EMPTY]);
    findManyCalls = 0;
    for (const teamName of [A, B, EMPTY, A, B]) for (const asOf of asOfs) await resolveVariable("tendency_over_rate", { type: "team", teamName }, asOf, { sportKey: SPORT, tendencyHistory: fresh });
    check("35 lookups over the listed teams: one query", findManyCalls, 1);
    findManyCalls = 0;
    await resolveVariable("tendency_over_rate", { type: "team", teamName: UNLISTED }, asOfs[3], { sportKey: SPORT, tendencyHistory: fresh });
    check("a team the source wasn't built for: its own query", findManyCalls, 1);
    findManyCalls = 0;
    createTendencyHistorySource(SPORT, [A, B]);
    check("a source nobody asks: no query", findManyCalls, 0);
    findManyCalls = 0;
    for (const asOf of asOfs) await resolveVariable("tendency_over_rate", { type: "team", teamName: A }, asOf, { sportKey: SPORT });
    check("without a source: one query per lookup (7)", findManyCalls, 7);

    // 3
    const game = await prisma.gameResult.create({
      data: { sportKey: SPORT, externalId: `${TAG}-g1`, homeTeam: A, awayTeam: B, homeScore: 5, awayScore: 3, gameDate: at("2031-04-05"), favTeam: A, totalLine: 8.5 },
      select: { id: true, gameDate: true },
    });
    gameIds.push(game.id);
    const event = { gameResultId: game.id, asOf: game.gameDate };
    const plain = await runModelDefinition(decayDeltaModel, event);
    const batched = await runModelDefinition(decayDeltaModel, event, { tendencyHistory: createTendencyHistorySource(SPORT, [A, B]) });
    check("runModelDefinition: same context with and without the source", batched.context, plain.context);
    check("runModelDefinition: same buckets", batched.buckets, plain.buckets);
    check("runModelDefinition: same unavailable ids", [...batched.unavailableIds].sort(), [...plain.unavailableIds].sort());
    // A's 04-03 snapshot (fav 5/10) and B's 04-04 one (dog 4/10): both inputs resolved, so the match isn't vacuous.
    check("runModelDefinition: both tendency inputs resolved from the seeded rows", [plain.context["di_fav_rate"], plain.context["di_dog_rate"]], [0.5, 0.4]);
    const boundedRun = await runModelDefinition(decayDeltaModel, event, { tendencyHistory: createTendencyHistorySource(SPORT, [A, B], [game.gameDate]) });
    check("runModelDefinition: same context with the bounded source", boundedRun.context, plain.context);
    check("runModelDefinition: same buckets with the bounded source", boundedRun.buckets, plain.buckets);

    // 4. The bound: the read keeps only [latest snapshot at or before the earliest asOf day, latest asOf day].
    const spans: [string, Date[]][] = [
      ["every case date", asOfs],
      ["a narrow span (04-03..04-05)", [at("2031-04-03"), at("2031-04-05")]],
      ["one day in a gap (04-05)", [at("2031-04-05")]],
      ["before any snapshot (03-31)", [at("2031-03-31")]],
    ];
    for (const [label, span] of spans) {
      const bounded = createTendencyHistorySource(SPORT, [A, B, EMPTY], span);
      let diff = 0;
      for (const teamName of teams)
        for (const asOf of asOfs)
          for (const v of VARIABLES) {
            const want = await resolveVariable(v, { type: "team", teamName }, asOf, { sportKey: SPORT });
            const got = await resolveVariable(v, { type: "team", teamName }, asOf, { sportKey: SPORT, tendencyHistory: bounded });
            if (JSON.stringify(got) !== JSON.stringify(want)) diff++;
          }
      check(`bounded to ${label}: all ${cases} cases identical (out-of-span asOfs fall back)`, diff, 0);
    }
    const dates = async (span: Date[], asOf: Date) =>
      (await createTendencyHistorySource(SPORT, [A], span).rowsFor(A, asOf))?.map((r) => r.snapshotDate) ?? null;
    check("A bounded to 04-05: just its 04-03 row", await dates([at("2031-04-05")], at("2031-04-05")), ["2031-04-03"]);
    check("A bounded to 04-02..04-06: 04-01 (the floor) through 04-06", await dates([at("2031-04-06"), at("2031-04-02")], at("2031-04-02")), ["2031-04-01", "2031-04-03", "2031-04-06"]);
    check("A bounded to 04-20: only its last row", await dates([at("2031-04-20")], at("2031-04-20")), ["2031-04-06"]);
    check("A bounded to 03-31 (before any snapshot): no rows, not found", await dates([at("2031-03-31")], at("2031-03-31")), []);
    check("an asOf outside the bounded span: no rows from the source (falls back)", createTendencyHistorySource(SPORT, [A], [at("2031-04-05")]).rowsFor(A, at("2031-04-06")), null);
    findManyCalls = 0;
    rawCalls = 0;
    const one = createTendencyHistorySource(SPORT, [A, B, EMPTY], [at("2031-04-03"), at("2031-04-05")]);
    for (const teamName of [A, B, EMPTY]) for (const asOf of [at("2031-04-03"), at("2031-04-04"), at("2031-04-05")]) await resolveVariable("tendency_over_rate", { type: "team", teamName }, asOf, { sportKey: SPORT, tendencyHistory: one });
    check("bounded: 9 in-span lookups, one read in total", { raw: rawCalls, findMany: findManyCalls }, { raw: 1, findMany: 0 });
  } finally {
    delegate.findMany = realFindMany;
    client.$queryRaw = realQueryRaw;
    await prisma.gameResult.deleteMany({ where: { id: { in: gameIds } } });
    await prisma.teamTendencySnapshot.deleteMany({ where: { id: { in: snapshotIds } } });
  }
}

main()
  .catch((err) => {
    console.error("FAIL: unexpected error", err);
    failures++;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(failures ? 1 : 0);
  });
