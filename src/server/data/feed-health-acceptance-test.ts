// Feed health against a real database: the one aggregate statement
// (feedHealthSql) counts played games and posted snapshot games per league
// for a given `now`, excluding preseason rows and stale snapshots; the
// feed_syncs upsert keeps the last success and last error side by side; and
// the four sync crons are wired to record (source level).
//
// Test rows live in 2031 (a `now` no real row reaches) and are deleted by
// primary key afterwards. The upsert check uses a sportKey no league has.
//
// DB-backed (runs when DATABASE_URL is set). Run with:
//   npx tsx src/server/data/feed-health-acceptance-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { feedHealthSql, parseFeedHealthRow, loadFeedHealth } from "@/server/data/feed-health";
import { feedSyncUpsertSql, oddsSyncOutcome, recordFeedSyncs, trackScoreSync, withFeedSyncs, type FeedSyncOutcome } from "@/server/data/feed-syncs";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const DAY = 86_400_000;
const NOW = new Date("2031-03-10T18:00:00.000Z");
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
const TEST_SPORT = "__feed-health-test__";

async function dbPart() {
  const gameIds: string[] = [];
  const snapIds: string[] = [];
  try {
    // NHL: played 2 in the last 7 days, 1 more 7-14 days back, 1 preseason
    // (excluded), 1 at 15 days (out of range), 1 in the future (not played).
    const games: [string, Date, boolean][] = [
      ["a", at(-1), false],
      ["b", at(-3), false],
      ["c", at(-10), false],
      ["d", at(-2), true],
      ["e", at(-15), false],
      ["f", at(0.1), false],
    ];
    for (const [suffix, gameDate, isPreseason] of games) {
      const r = await prisma.gameResult.create({
        data: { sportKey: "icehockey_nhl", externalId: "__feed-health-test__" + suffix, homeTeam: "H", awayTeam: "A", homeScore: 1, awayScore: 0, gameDate, isPreseason },
        select: { id: true },
      });
      gameIds.push(r.id);
    }
    // NHL posted: today's snapshot (ET 2031-03-10) with 3 games - one already
    // started, two ahead (one 8 days out: counted as "next", not in next7).
    // An older snapshot (2031-03-07) must be ignored.
    const snap = (fetchDate: string, commence: Date[]) =>
      prisma.oddsSnapshot.create({
        data: { sportKey: "icehockey_nhl", fetchDate, data: commence.map((c, i) => ({ id: fetchDate + i, commenceTime: c.toISOString(), homeTeam: "H", awayTeam: "A" })) },
        select: { id: true },
      });
    snapIds.push((await snap("2031-03-10", [at(-0.1), at(0.2), at(8)])).id);
    snapIds.push((await snap("2031-03-07", [at(1), at(2), at(3), at(4)])).id);
    // NBA: only a stale snapshot (2031-03-01) - no posted data at all.
    snapIds.push(
      (await prisma.oddsSnapshot.create({ data: { sportKey: "basketball_nba", fetchDate: "2031-03-01", data: [{ id: "x", commenceTime: at(1).toISOString() }] }, select: { id: true } })).id
    );

    const [row] = await prisma.$queryRaw<Parameters<typeof parseFeedHealthRow>[0][]>(feedHealthSql(NOW));
    const parsed = parseFeedHealthRow(row);
    const nhl = parsed.find((d) => d.sportKey === "icehockey_nhl")!;
    expect("played: 2 in 7 days, 3 in 14 (preseason, 15-day-old and future rows excluded)", [nhl.past7, nhl.past14], [2, 3]);
    expect("played: last game is the 1-day-old one", nhl.lastGameAt?.toISOString(), at(-1).toISOString());
    expect("posted: today's snapshot, 1 game in the next 7 days", [nhl.postedFetchDate, nhl.next7], ["2031-03-10", 1]);
    expect("posted: next game is the one 0.2 days out", nhl.nextGameAt?.toISOString(), at(0.2).toISOString());
    const nba = parsed.find((d) => d.sportKey === "basketball_nba")!;
    expect("a snapshot older than yesterday ET is not used", [nba.postedFetchDate, nba.next7, nba.nextGameAt], [null, 0, null]);
    expect("seven leagues come back", parsed.length, 7);

    // The full load runs end to end and judges NHL In season.
    const health = await loadFeedHealth(NOW);
    expect("loadFeedHealth: NHL In season at the test 'now'", health.find((h) => h.sportKey === "icehockey_nhl")?.status, "in_season");
  } finally {
    if (gameIds.length) await prisma.gameResult.deleteMany({ where: { id: { in: gameIds } } });
    if (snapIds.length) await prisma.oddsSnapshot.deleteMany({ where: { id: { in: snapIds } } });
  }

  // feed_syncs upsert: success, then error, then success again - each keeps
  // the other's columns.
  const read = () =>
    prisma.feedSync.findUnique({ where: { feed_sportKey: { feed: "scores", sportKey: TEST_SPORT } }, select: { lastSuccessAt: true, lastErrorAt: true, lastError: true } });
  try {
    const t1 = new Date("2031-03-10T10:00:00.000Z");
    const t2 = new Date("2031-03-10T11:00:00.000Z");
    const t3 = new Date("2031-03-10T12:00:00.000Z");
    await prisma.$executeRaw(feedSyncUpsertSql("scores", [{ sportKey: TEST_SPORT, ok: true }], t1));
    expect("first success creates the row", await read(), { lastSuccessAt: t1, lastErrorAt: null, lastError: null });
    await prisma.$executeRaw(feedSyncUpsertSql("scores", [{ sportKey: TEST_SPORT, ok: false, error: "x".repeat(400) }], t2));
    const afterErr = await read();
    expect("an error keeps the last success and records the error, clipped to 300", [afterErr?.lastSuccessAt, afterErr?.lastErrorAt, afterErr?.lastError?.length], [t1, t2, 300]);
    await prisma.$executeRaw(feedSyncUpsertSql("scores", [{ sportKey: TEST_SPORT, ok: true }], t3));
    const afterOk = await read();
    expect("a later success moves only lastSuccessAt", [afterOk?.lastSuccessAt, afterOk?.lastErrorAt, afterOk?.lastError?.length], [t3, t2, 300]);
    // timestamps are stored as UTC wall time regardless of the session zone
    const [{ raw }] = await prisma.$queryRaw<{ raw: string }[]>`SELECT to_char("lastSuccessAt", 'YYYY-MM-DD HH24:MI') AS raw FROM feed_syncs WHERE feed = 'scores' AND "sportKey" = ${TEST_SPORT}`;
    expect("stored as UTC wall time", raw, "2031-03-10 12:00");

    // withFeedSyncs + trackScoreSync: a throw is recorded, rethrown, and the
    // leagues already done are recorded too.
    let rethrown = false;
    try {
      await withFeedSyncs("scores", (o) =>
        Promise.all([
          trackScoreSync(TEST_SPORT, o, true, async () => {
            throw new Error("ESPN exploded");
          }),
        ])
      );
    } catch (err) {
      rethrown = err instanceof Error && err.message === "ESPN exploded";
    }
    expect("trackScoreSync rethrows", rethrown, true);
    expect("... and withFeedSyncs recorded the error", (await read())?.lastError, "ESPN exploded");
    // a failing write never throws out of recordFeedSyncs
    await recordFeedSyncs("scores", [{ sportKey: TEST_SPORT, ok: true }], new Date("not a date"));
    expect("recordFeedSyncs swallows its own failure", true, true);
  } finally {
    await prisma.feedSync.deleteMany({ where: { feed: "scores", sportKey: TEST_SPORT } });
  }
}

function pureAndSourcePart() {
  // Gated leagues that fetched nothing record nothing; untracked throw passes.
  const outcomes: FeedSyncOutcome[] = [];
  void trackScoreSync("x", outcomes, false, async () => 1).then(() => expect("season-gated run records nothing", outcomes, []));

  expect(
    "odds outcomes: real answers succeed, failures error, no-call statuses record nothing",
    (["seeded", "cached", "nothing_missing", "added", "fetch_failed", "no_api_key", "off_season", "all_started", "no_base_row"] as const).map((s) => {
      const o = oddsSyncOutcome("k", s);
      return o === null ? null : o.ok;
    }),
    [true, true, true, true, false, false, null, null, null]
  );

  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  for (const p of ["src/app/api/cron/grade-picks/route.ts", "src/app/api/cron/refresh-scores/route.ts"]) {
    const s = src(p);
    expect(`${p}: persistFinalScores runs inside trackScoreSync under withFeedSyncs("scores")`, /withFeedSyncs\("scores"[\s\S]*trackScoreSync\([^)]*scoreFeedFetches\(sportKey\), \(\) => persistFinalScores\(/.test(s), true);
  }
  for (const p of ["src/app/api/cron/refresh-odds/route.ts", "src/app/api/cron/backfill-odds/route.ts"]) {
    expect(`${p}: records odds syncs once per run`, (src(p).match(/recordFeedSyncs\(\s*"odds"/g) ?? []).length, 1);
  }
  const odds = src("src/server/data/odds.ts");
  const gated = [...odds.matchAll(/if \(sportKey === "([a-z_]+)"\) \{\s*(?:\/\/[^\n]*\n\s*)*if \(!isSportInSeason\(sportKey\)\) return \[\];/g)].map((m) => m[1]).sort();
  const listed = [...(/SEASON_GATED_SCORE_SPORT_KEYS[^=]*= new Set\(\[([^\]]*)\]/.exec(odds)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
  expect("scoreFeedFetches' gated list matches dispatchLiveScoresForSport's season gates", listed, gated);
  expect("admin tab registered", /key: "feed-health", href: "\/admin\/feed-health"/.test(src("src/lib/admin-tabs.ts")), true);
  expect("page gated by requireAdminOpsPage", /await requireAdminOpsPage\(\)/.test(src("src/app/(app)/admin/feed-health/page.tsx")), true);
  expect("header badge only reads the cached summary, admins only", /showAdminOps \? await getFeedHealthSummary\(\)/.test(src("src/app/(app)/layout.tsx")), true);
}

async function main() {
  pureAndSourcePart();
  if (!process.env.DATABASE_URL) {
    console.log("SKIP: DB part (no DATABASE_URL)");
  } else {
    await dbPart();
  }
  await new Promise((r) => setTimeout(r, 0));
  await prisma.$disconnect();
  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nALL PASS");
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

