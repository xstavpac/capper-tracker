// The 7-day schedule store against a real database (server/data/schedule-store.ts):
//   1. the daily pull with a fake ESPN / MLB: every planned date requested, one
//      date failing -> that date kept from before, the rest upserted, the
//      league's feed_syncs outcome an error naming the date
//   2. upsert (a second pull replaces a day's games) and prune (days before
//      today deleted, by id)
//   3. the cache: key / tag contract, the pull invalidates the league's tag,
//      concurrent reads share one database read
//   4. Feed health: a daily league's "next 7 days" comes from the store
//      (postponed left out), football keeps the odds snapshot
//   5. the wide-schedule tiebreaker and catalog import matching read the store
//      through resolveGameForNickname; the token day rule matches a named day 2
//      days out from it
//
// Test rows are written under a sport key no league uses (feed health under its
// own 2031 dates) and deleted by id afterwards.
//
// DB-backed (runs when DATABASE_URL is set). Run with:
//   npx tsx src/server/data/schedule-store-acceptance-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { cacheKeys } from "@/lib/cache-keys";
import { addDaysToDateKey, easternDateKey } from "@/lib/dates";
import type { StoredScheduleGame } from "@/lib/schedule-store";
import {
  getStoredSchedule,
  getUpcomingScheduleGames,
  pullLeagueSchedule,
  refreshScheduleStore,
  scheduleUpsertSql,
  type ScheduleFetchJson,
} from "@/server/data/schedule-store";
import { feedHealthSql, parseFeedHealthRow } from "@/server/data/feed-health";
import { runTeamWideScheduleCheck } from "@/server/data/catalog-disambiguation-checks";
import { resolveGameForNickname } from "@/server/data/odds";
import { namedPickDay } from "@/lib/ingest-line-outcome";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!pass) failures++;
}

// NBA is in season on this date; the pull is pointed at a sport key nobody else
// writes (the league list is a parameter) but planned with NBA's season window.
const NOW = new Date("2026-12-01T20:00:00Z"); // Tuesday, 15:00 ET
const TODAY = easternDateKey(NOW);
const TEST_SPORT = "__schedule-store-test__";
const espnEvent = (id: string, home: string, away: string, date: string) => ({
  id,
  date,
  status: { type: { state: "pre" } },
  competitions: [{ competitors: [{ homeAway: "home", team: { displayName: home } }, { homeAway: "away", team: { displayName: away } }] }],
});

async function idsFor(sportKey: string): Promise<string[]> {
  return (await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM schedule_days WHERE "sportKey" = ${sportKey}`).map((r) => r.id);
}
async function deleteIds(ids: string[]) {
  if (ids.length) await prisma.$executeRaw`DELETE FROM schedule_days WHERE id = ANY(${ids}::text[])`;
}
async function rowsFor(sportKey: string) {
  return prisma.$queryRaw<{ gameDate: string; games: StoredScheduleGame[]; fetchedAt: Date }[]>`
    SELECT "gameDate", games, "fetchedAt" FROM schedule_days WHERE "sportKey" = ${sportKey} ORDER BY "gameDate"`;
}

async function pullAndStore() {
  // 1. The pull. NBA's planning (7 dates in season), a fake ESPN: Dec 3 fails.
  const requested: string[] = [];
  const failDate = addDaysToDateKey(TODAY, 2);
  const fetchJson: ScheduleFetchJson = async (url) => {
    requested.push(url);
    const date = /dates=(\d{8})/.exec(url)![1];
    const key = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`;
    if (key === failDate) throw new Error("HTTP 503");
    return { events: [espnEvent("e-" + key, "Boston Celtics", "Miami Heat", key + "T23:30Z")] };
  };
  const pulled = await pullLeagueSchedule("basketball_nba", { kind: "espn", path: "basketball/nba" }, NOW, fetchJson);
  expect("pull: one ESPN request per planned date", requested.length, 7);
  expect("pull: the failed date is recorded, the other 6 came back", [pulled.failed.map((f) => f.date), pulled.days.size], [[failDate], 6]);

  // MLB: one range request; when it fails, every planned date fails.
  let mlbCalls = 0;
  const mlbFail = await pullLeagueSchedule("baseball_mlb", { kind: "mlb" }, new Date("2026-06-10T17:00:00Z"), async () => {
    mlbCalls++;
    throw new Error("HTTP 500");
  });
  expect("pull: MLB is one start-end request; its failure fails all 7 dates", [mlbCalls, mlbFail.failed.length, mlbFail.days.size], [1, 7, 0]);

  // 2. The whole step (refreshScheduleStore) for one league under TEST_SPORT,
  //    planned with NBA's 7 dates. Seed first: the failing date holds
  //    yesterday's pull (it must survive), and an old day (Nov 28) the prune
  //    must delete.
  await prisma.$executeRaw(
    scheduleUpsertSql(
      TEST_SPORT,
      new Map([
        [failDate, [{ id: "old-dec3", home: "Boston Celtics", away: "Utah Jazz", start: failDate + "T23:30Z", status: "preview" }]],
        ["2026-11-28", [{ id: "old", home: "A", away: "B", start: "2026-11-28T23:30Z", status: "final" }]],
      ]),
      new Date(NOW.getTime() - 86_400_000)
    )!
  );
  const invalidated: string[] = [];
  const outcomes: unknown[] = [];
  const summary = await refreshScheduleStore(NOW, {
    fetchJson,
    leagues: [{ sportKey: TEST_SPORT, source: { kind: "espn", path: "basketball/nba" } }],
    planDates: () => pulled.planned,
    invalidate: (tag) => invalidated.push(tag),
    recordSyncs: async (feed, o) => void outcomes.push(feed, ...o),
  });
  const rows = await rowsFor(TEST_SPORT);
  expect("store: 7 days from today, the old day pruned", rows.map((r) => r.gameDate), pulled.planned);
  expect("store: the failed date kept yesterday's games", rows.find((r) => r.gameDate === failDate)?.games.map((g) => g.id), ["old-dec3"]);
  expect("store: a pulled date holds today's games", rows.find((r) => r.gameDate === TODAY)?.games.map((g) => g.id), ["e-" + TODAY]);
  expect("store: fetchedAt is the run's own instant, in UTC", rows.find((r) => r.gameDate === TODAY)?.fetchedAt.toISOString(), NOW.toISOString());
  expect("store: the failed date's fetchedAt is still yesterday's", rows.find((r) => r.gameDate === failDate)?.fetchedAt.toISOString(), new Date(NOW.getTime() - 86_400_000).toISOString());
  expect("summary: 6 days stored, the failed date named, >= 1 old row pruned", [summary.leagues[0].stored, summary.leagues[0].failed, summary.pruned >= 1], [6, [failDate], true]);
  expect("cache: the run invalidated the league's tag", invalidated, [cacheKeys.scheduleTag(TEST_SPORT)]);
  expect("feed_syncs: one 'schedule' outcome, an error naming the failed date", outcomes, [
    "schedule",
    { sportKey: TEST_SPORT, ok: false, error: `schedule pull failed for 1 of 7 dates (${failDate}): ESPN: HTTP 503` },
  ]);

  // Upsert: a second run with every date back replaces the kept day's games.
  const ok: ScheduleFetchJson = async (url) => {
    const date = /dates=(\d{8})/.exec(url)![1];
    const key = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`;
    return { events: key === failDate ? [espnEvent("new-dec3", "Boston Celtics", "Utah Jazz", key + "T23:30Z")] : [] };
  };
  outcomes.length = 0;
  await refreshScheduleStore(NOW, {
    fetchJson: ok,
    leagues: [{ sportKey: TEST_SPORT, source: { kind: "espn", path: "basketball/nba" } }],
    planDates: () => pulled.planned,
    invalidate: () => {},
    recordSyncs: async (feed, o) => void outcomes.push(feed, ...o),
  });
  const rows2 = await rowsFor(TEST_SPORT);
  expect("upsert: still one row per day", rows2.length, 7);
  expect("upsert: the day's games replaced", rows2.find((r) => r.gameDate === failDate)?.games.map((g) => g.id), ["new-dec3"]);
  expect("upsert: an empty answer is stored as an empty day (a real answer)", rows2.find((r) => r.gameDate === TODAY)?.games, []);
  expect("feed_syncs: every date back -> success", outcomes, ["schedule", { sportKey: TEST_SPORT, ok: true }]);

  // 3. The cache. Outside a Next request there is no Data Cache, so this checks
  //    the contract: key / tag, the read's rows, and single-flight.
  expect("cache key carries league + ET day; tag is per league", [cacheKeys.schedule(TEST_SPORT, TODAY), cacheKeys.scheduleTag(TEST_SPORT)], [
    `schedule:${TEST_SPORT}:${TODAY}`,
    `schedule:${TEST_SPORT}`,
  ]);
  let loads = 0;
  const load = async (sportKey: string, todayKey: string) => {
    loads++;
    return (await rowsFor(sportKey)).filter((r) => r.gameDate >= todayKey).map(({ gameDate, games }) => ({ gameDate, games }));
  };
  const [a, b] = await Promise.all([getStoredSchedule(TEST_SPORT, NOW, load), getStoredSchedule(TEST_SPORT, NOW, load)]);
  expect("cache: two concurrent reads share one database read", loads, 1);
  expect("cache: both get the same 7 days", [a.length, b.length], [7, 7]);
  const real = await getStoredSchedule(TEST_SPORT, NOW);
  expect("read: the real loader returns today on, in date order", real.map((r) => r.gameDate), pulled.planned);
  const upcoming = await getUpcomingScheduleGames(TEST_SPORT, NOW);
  expect("read: resolver games start at today+2", upcoming.map((g) => g.id), ["new-dec3"]);
}

// 4. Feed health ------------------------------------------------------------------------
async function feedHealthPart() {
  const NOW2 = new Date("2031-03-10T18:00:00.000Z");
  const at = (days: number) => new Date(NOW2.getTime() + days * 86_400_000).toISOString();
  const g = (id: string, start: string, status: StoredScheduleGame["status"] = "preview"): StoredScheduleGame => ({ id, home: "H", away: "A", start, status });
  const write = (sportKey: string, days: [string, StoredScheduleGame[]][]) => prisma.$executeRaw(scheduleUpsertSql(sportKey, new Map(days), NOW2)!);
  const before = { nba: await idsFor("basketball_nba"), nfl: await idsFor("americanfootball_nfl") };
  try {
    // NBA: 2 playable games ahead within 7 days, 1 postponed, 1 already started, 1 day out of range (8 days).
    await write("basketball_nba", [
      ["2031-03-10", [g("n1", at(-0.1)), g("n2", at(0.2))]],
      ["2031-03-12", [g("n3", at(2)), g("n4", at(2.1), "postponed")]],
      ["2031-03-18", [g("n5", at(8))]],
      ["2031-03-09", [g("n0", at(-1))]],
    ]);
    // NFL: stored too, but football keeps the odds snapshot.
    await write("americanfootball_nfl", [["2031-03-11", [g("f1", at(1))]]]);
    const [row] = await prisma.$queryRaw<Parameters<typeof parseFeedHealthRow>[0][]>(feedHealthSql(new Date(NOW2)));
    const parsed = parseFeedHealthRow(row);
    const nba = parsed.find((d) => d.sportKey === "basketball_nba")!;
    expect("feed health: NBA posted comes from the store", nba.postedSource, "schedule");
    expect("feed health: NBA next 7 days = 2 (started, postponed, 8-days-out and yesterday's left out)", nba.next7, 2);
    expect("feed health: NBA next game is the one 0.2 days out", nba.nextGameAt?.toISOString(), at(0.2));
    const nfl = parsed.find((d) => d.sportKey === "americanfootball_nfl")!;
    expect("feed health: NFL does not read the store (no odds snapshot -> nothing posted)", [nfl.postedSource, nfl.next7], [null, 0]);
    const nhl = parsed.find((d) => d.sportKey === "icehockey_nhl")!;
    expect("feed health: a daily league with no stored days falls back to the odds side", nhl.postedSource === "schedule", false);
  } finally {
    await deleteIds((await idsFor("basketball_nba")).filter((id) => !before.nba.includes(id)));
    await deleteIds((await idsFor("americanfootball_nfl")).filter((id) => !before.nfl.includes(id)));
  }
}

// 5. Resolvers through the real read ----------------------------------------------------
// WNBA is off season today, so its score feed and odds read return [] with no
// network call - the store is the only feed with anything in it.
async function resolverPart() {
  const WNBA = "basketball_wnba";
  const now = new Date();
  const today = easternDateKey(now);
  const plus3 = addDaysToDateKey(today, 3);
  const plus2 = addDaysToDateKey(today, 2);
  const before = await idsFor(WNBA);
  try {
    expect("tiebreaker: no stored game -> 'nothing on the schedule'", (await runTeamWideScheduleCheck([{ nickname: "liberty", sport: "WNBA" }]))["liberty|WNBA"], false);
    await prisma.$executeRaw(
      scheduleUpsertSql(
        WNBA,
        new Map([
          [plus2, [{ id: "w2", home: "Las Vegas Aces", away: "Seattle Storm", start: plus2 + "T23:00:00Z", status: "preview" }]],
          [plus3, [{ id: "w3", home: "New York Liberty", away: "Chicago Sky", start: plus3 + "T23:00:00Z", status: "preview" }]],
        ]),
        now
      )!
    );
    expect("tiebreaker: a stored game 3 days out -> 'has a real scheduled game'", (await runTeamWideScheduleCheck([{ nickname: "liberty", sport: "WNBA" }]))["liberty|WNBA"], true);
    const imported = await resolveGameForNickname(WNBA, "liberty", { getOdds: async () => [] });
    expect("catalog import: a pick on a game 3 days out matches the stored game", [imported.game?.id, imported.game?.homeTeam], ["w3", "New York Liberty"]);
    const nearTerm = await resolveGameForNickname(WNBA, "liberty", { nearTermOnly: true });
    expect("near-term check stays score-feed only (no stored game)", nearTerm.game, null);
    const requestDay = today;
    const namedDay = namedPickDay("Aces ML " + plus2.slice(5).replace("-", "/"), requestDay);
    const token = await resolveGameForNickname(WNBA, "aces", { getOdds: async () => [], day: { requestDay, namedDay } });
    expect("token day rule: a named day 2 days out matches its stored game", [namedDay, token.game?.id], [plus2, "w2"]);
    const wrongDay = await resolveGameForNickname(WNBA, "aces", { getOdds: async () => [], day: { requestDay, namedDay: plus3 } });
    expect("token day rule: a named day with no stored game for the team matches nothing", wrongDay.game, null);
  } finally {
    await deleteIds((await idsFor(WNBA)).filter((id) => !before.includes(id)));
  }
}

// Source-level: the cron runs the step, on its own catch.
function sourcePart() {
  const src = readFileSync(join(process.cwd(), "src/app/api/cron/refresh-scores/route.ts"), "utf8");
  expect("refresh-scores runs refreshScheduleStore on its own try/catch", /try \{\s*schedule = await refreshScheduleStore\(\);/.test(src), true);
  const odds = readFileSync(join(process.cwd(), "src/server/data/odds.ts"), "utf8");
  expect("import matching reads the store only when the score feed has no upcoming match (ESPN first)", odds.includes("const scheduleGames = scoreHasUpcoming ? [] : await listings();"), true);
  expect("the token day rule reads it only when the score feed has no game that day", odds.includes("const daySchedule = scoreHasDay ? [] : await listings();"), true);
}

async function main() {
  const startIds = await idsFor(TEST_SPORT);
  try {
    await pullAndStore();
  } finally {
    await deleteIds([...new Set([...startIds, ...(await idsFor(TEST_SPORT))])]);
  }
  await feedHealthPart();
  await resolverPart();
  sourcePart();
  await prisma.$disconnect();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
