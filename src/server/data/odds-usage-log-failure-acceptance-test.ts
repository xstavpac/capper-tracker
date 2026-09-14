// Proof that a failing odds_api_usage_log write (recordBulkUsage's guard,
// odds.ts) never takes down the actual odds fetch/cache-write for the sport
// it's logging usage for. This matters specifically because both call sites
// (getOddsForSportUncached, exercised here via seedOddsSnapshot; and
// backfillOddsForSport) run inside the refresh-odds cron's
// Promise.all(LIVE_SPORTS.map(...)) - an unguarded throw there for one sport
// would reject that whole Promise.all and 500 the entire cron run, even
// though every other sport's fetch already succeeded moments earlier.
//
// Stubs global fetch and prisma.oddsSnapshot/oddsApiUsageLog - no real
// network, no real DB. Uses "baseball_mlb" (in season 2026-03-15 to
// 2026-11-05, no preseason-key handoff complication) so isSportInSeason
// doesn't need to be mocked. Run with:
//   npx tsx src/server/data/odds-usage-log-failure-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import { seedOddsSnapshot, backfillOddsForSport } from "@/server/data/odds";
import { easternDateKey } from "@/lib/dates";

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
const fetchDate = easternDateKey(new Date());
const laterToday = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

async function main() {
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

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
