// Proof that a failing odds_api_usage_log write (recordBulkUsage's guard,
// odds.ts) never takes down the actual odds fetch/cache-write for the sport
// it's logging usage for. This matters specifically because both call sites
// (getOddsForSportUncached, exercised here via seedOddsSnapshot; and
// backfillOddsForSport) run inside the refresh-odds cron's
// Promise.all(LIVE_SPORTS.map(...)) - an unguarded throw there for one sport
// would reject that whole Promise.all and 500 the entire cron run, even
// though every other sport's fetch already succeeded moments earlier.
//
// Stubs global fetch, prisma.oddsSnapshot/oddsApiUsageLog, AND the global
// Date (see freezeTime/unfreezeTime below) - no real network, no real DB, no
// real wall clock. Uses "baseball_mlb" (in season 2026-03-15 to 2026-11-05,
// no preseason-key handoff complication) so isSportInSeason doesn't need to
// be mocked. Run with:
//   npx tsx src/server/data/odds-usage-log-failure-acceptance-test.ts
//
// The Date freeze exists because backfillOddsForSport deliberately requires
// its freshly-fetched games to fall on the SAME Eastern calendar day as
// `easternDateKey(new Date())` at call time (see its own comment on that
// filter - it's what stops an evening run from "backfilling" tomorrow's
// entire slate). A fixture built from a real-wall-clock-relative offset
// (the previous version used `Date.now() + 6h`) is only reliably same-day
// when the suite happens to run more than 6 hours before Eastern midnight -
// it silently rolled into tomorrow (by Eastern clock) whenever run within
// ~6 hours of Eastern midnight, which turned "backfillOddsForSport should
// append a genuinely-missing game" into "nothing missing" for no reason
// related to the code under test. Freezing time removes that dependency on
// when the suite happens to execute, in CI or locally, entirely.
import { prisma } from "@/lib/prisma";
import { seedOddsSnapshot, backfillOddsForSport } from "@/server/data/odds";
import { easternDateKey } from "@/lib/dates";

// A fixed, safe instant: mid-afternoon Eastern, deep in MLB's in-season
// window (2026-03-15 to 2026-11-05, comfortably clear of both boundaries and
// of DST transitions), so it never needs updating for isSportInSeason to
// keep treating "baseball_mlb" as in season. Real-wall-clock-independent by
// construction - see freezeTime below.
const RealDate = globalThis.Date;
const FROZEN_NOW_ISO = "2026-06-15T15:00:00.000-04:00";

// Freezes `new Date()` (no-args) and `Date.now()` to FROZEN_NOW_ISO while
// leaving `new Date(<explicit arg>)` - used throughout odds.ts to parse a
// specific game's commenceTime - behaving exactly like the real Date. Every
// "what time is it right now" read the code under test performs
// (easternDateKey(new Date()), `fetchedAt = new Date()`, isSportInSeason's
// default referenceDate) resolves to this same fixed instant, so the whole
// test run's notion of "today"/"now" is pinned regardless of when it's
// actually executed.
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) {
      super(FROZEN_NOW_ISO);
    } else {
      // @ts-expect-error - forwarding a variadic Date constructor
      super(...args);
    }
  }
  static now() {
    return new RealDate(FROZEN_NOW_ISO).getTime();
  }
}
function freezeTime() {
  globalThis.Date = FrozenDate as unknown as DateConstructor;
}
function unfreezeTime() {
  globalThis.Date = RealDate;
}

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}
function ok(label: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
}

const prismaOriginals: Record<string, unknown> = {};
function patch(path: string, fn: unknown) {
  const [model, method] = path.split(".");
  const target = (prisma as unknown as Record<string, Record<string, unknown>>)[model];
  prismaOriginals[path] ??= target[method];
  target[method] = fn;
}
function restorePrisma() {
  for (const path of Object.keys(prismaOriginals)) {
    const [model, method] = path.split(".");
    (prisma as unknown as Record<string, Record<string, unknown>>)[model][method] = prismaOriginals[path];
  }
  for (const key of Object.keys(prismaOriginals)) delete prismaOriginals[key];
}

const realFetch = globalThis.fetch;
function stubFetch(body: unknown, headers: Record<string, string>) {
  globalThis.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(headers),
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as Response) as typeof fetch;
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}

const realConsoleError = console.error;
function captureConsoleError(): string[] {
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  return lines;
}
function restoreConsoleError() {
  console.error = realConsoleError;
}

const SPORT = "baseball_mlb";
// Both derived from FROZEN_NOW_ISO via RealDate, never the real clock -
// laterToday is 2 hours after the frozen "now", comfortably same-Eastern-day
// and still in the future no matter when this file is actually executed.
const fetchDate = easternDateKey(new RealDate(FROZEN_NOW_ISO));
const laterToday = new RealDate(new RealDate(FROZEN_NOW_ISO).getTime() + 2 * 60 * 60 * 1000).toISOString();

async function main() {
  // seedOddsSnapshot/backfillOddsForSport both bail out early with
  // no_api_key/no_api_key-equivalent statuses when ODDS_API_KEY is unset -
  // CI sets no such secret for this suite, so a fixed test value is needed
  // here regardless of what's in the environment (never used for a real
  // call - stubFetch below only ever returns the stubbed response).
  const realApiKey = process.env.ODDS_API_KEY;
  process.env.ODDS_API_KEY = "test-key";
  freezeTime();

  // =====================================================================
  // 1. seedOddsSnapshot (the cron's actual call path via
  //    getOddsForSportUncached) - usage-log write throws, odds fetch must
  //    still succeed and cache the games.
  // =====================================================================
  patch("oddsSnapshot.findUnique", async () => null); // cache miss -> real fetch path
  let upserted: unknown = null;
  patch("oddsSnapshot.upsert", async ({ create }: { create: { data: unknown } }) => {
    upserted = create.data;
    return {};
  });
  patch("oddsApiUsageLog.count", async () => 0);
  patch("oddsApiUsageLog.create", async () => {
    throw new Error("simulated DB write failure");
  });
  stubFetch([{ id: "g1", sport_key: SPORT, home_team: "Dodgers", away_team: "Giants", commence_time: laterToday, bookmakers: [] }], {
    "x-requests-remaining": "19000",
    "x-requests-used": "1000",
  });
  const errorLines = captureConsoleError();

  let seedThrew = false;
  let seedResult: Awaited<ReturnType<typeof seedOddsSnapshot>> | null = null;
  try {
    seedResult = await seedOddsSnapshot(SPORT);
  } catch {
    seedThrew = true;
  }
  restoreConsoleError();

  ok("seedOddsSnapshot: does NOT throw when the usage-log write fails", !seedThrew);
  expect("seedOddsSnapshot: still reports 'seeded' despite the usage-log write failing", seedResult?.status, "seeded");
  expect("seedOddsSnapshot: the fetched game was still counted", seedResult?.games, 1);
  ok("seedOddsSnapshot: the game data was still cached (oddsSnapshot.upsert ran)", upserted !== null);
  ok(
    "seedOddsSnapshot: the usage-log failure was logged loudly",
    errorLines.some((l) => l.includes("[odds-api-usage] failed to persist usage log") && l.includes(SPORT))
  );

  restorePrisma();
  restoreFetch();

  // =====================================================================
  // 2. backfillOddsForSport - the other call site sharing the same guard -
  //    usage-log write throws, the backfill must still append the missing
  //    game and report success.
  // =====================================================================
  const existingGame = { id: "existing1", sportKey: SPORT, homeTeam: "A", awayTeam: "B", commenceTime: laterToday, bookmakers: [] };
  patch("oddsSnapshot.findUnique", async () => ({ data: [existingGame] }));
  let updatedData: unknown = null;
  patch("oddsSnapshot.update", async ({ data }: { data: { data: unknown } }) => {
    updatedData = data.data;
    return {};
  });
  patch("oddsApiUsageLog.count", async () => 0);
  patch("oddsApiUsageLog.create", async () => {
    throw new Error("simulated DB write failure");
  });
  stubFetch(
    [{ id: "missing1", sport_key: SPORT, home_team: "C", away_team: "D", commence_time: laterToday, bookmakers: [] }],
    { "x-requests-remaining": "18999", "x-requests-used": "1001" }
  );

  let backfillThrew = false;
  let backfillResult: Awaited<ReturnType<typeof backfillOddsForSport>> | null = null;
  try {
    backfillResult = await backfillOddsForSport(SPORT);
  } catch {
    backfillThrew = true;
  }

  ok("backfillOddsForSport: does NOT throw when the usage-log write fails", !backfillThrew);
  expect("backfillOddsForSport: still reports 'added' despite the usage-log write failing", backfillResult?.status, "added");
  expect("backfillOddsForSport: the missing game was still counted", backfillResult?.added, 1);
  ok(
    "backfillOddsForSport: the missing game was still appended (oddsSnapshot.update ran)",
    Array.isArray(updatedData) && (updatedData as unknown[]).length === 2
  );

  restorePrisma();
  restoreFetch();
  unfreezeTime();
  if (realApiKey === undefined) delete process.env.ODDS_API_KEY;
  else process.env.ODDS_API_KEY = realApiKey;

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
