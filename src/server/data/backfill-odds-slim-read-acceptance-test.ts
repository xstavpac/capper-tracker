// Proof that backfillOddsForSport's "check" path (and the dormant CFL score
// window gate) make the SAME decisions when they read only each cached
// game's id + commenceTime instead of the whole OddsSnapshot blob, and that
// the write path still produces exactly the merged blob it always did.
//
// DB-backed against a seeded throwaway DB (see scripts/run-tests.mjs); stubs
// global fetch (Odds API bulk listing) and freezes the clock. The EXPECTED
// decision table below was captured by running this scenario against the
// pre-change code (full findUnique of the blob). Also asserts the slim
// helper's output IS the (id, commenceTime) projection of the blob, and that
// the check path no longer reads `data` whole. Cleans up after itself. Run:
//   npx tsx src/server/data/backfill-odds-slim-read-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import { backfillOddsForSport, cflGameWithinScoreWindow, getOddsGameStubs } from "@/server/data/odds";

let failures = 0;
// Key-order-insensitive: jsonb does not preserve object key order.
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)]));
  return v;
}
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(canon(actual)) === JSON.stringify(canon(expected));
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!pass) failures++;
}

const MLB = "baseball_mlb";
const NFL = "americanfootball_nfl";
const CFL = "americanfootball_cfl";
const DAY = "2026-06-15";
const T0 = Date.parse("2026-06-15T14:00:00Z");

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

// --- fetch stub: counts Odds API bulk listing calls, serves `bulk`.
let bulk: unknown[] | "fail" = [];
let fetchCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown) => {
  const url = String(input);
  if (!url.includes("api.the-odds-api.com")) throw new Error("unexpected fetch: " + url);
  fetchCalls++;
  const headers = new Headers({ "x-requests-remaining": "19000", "x-requests-used": "1000" });
  if (bulk === "fail") return { ok: false, status: 500, statusText: "ERR", headers, text: async () => "boom", json: async () => ({}) } as Response;
  return { ok: true, status: 200, statusText: "OK", headers, json: async () => bulk, text: async () => JSON.stringify(bulk) } as Response;
}) as typeof fetch;

// --- prisma: usage log is stubbed (not under test); oddsSnapshot reads are
// spied so the check path's read shape can be asserted.
type AnyFn = (...a: unknown[]) => unknown;
const restores: (() => void)[] = [];
function patch(model: string, method: string, fn: AnyFn) {
  const target = (prisma as unknown as Record<string, Record<string, AnyFn>>)[model];
  const orig = target[method];
  target[method] = fn;
  restores.push(() => {
    target[method] = orig;
  });
}
patch("oddsApiUsageLog", "count", async () => 0);
patch("oddsApiUsageLog", "create", async () => ({}));
const wholeBlobReads = { n: 0 };
for (const m of ["findUnique", "findFirst", "findMany"]) {
  const target = (prisma as unknown as Record<string, Record<string, AnyFn>>).oddsSnapshot;
  const orig = target[m];
  target[m] = function (...a: unknown[]) {
    const args = (a[0] ?? {}) as { select?: unknown };
    // A read that returns `data` = no select at all, or select.data true.
    const sel = args.select as { data?: boolean } | undefined;
    if (!sel || sel.data) wholeBlobReads.n++;
    return orig.apply(target, a);
  };
  restores.push(() => {
    target[m] = orig;
  });
}

const game = (id: string, iso: string, extra: Record<string, unknown> = {}) => ({
  id,
  sportKey: MLB,
  homeTeam: "H" + id,
  awayTeam: "A" + id,
  commenceTime: iso,
  bookmakers: [{ key: "b", title: "B", markets: [{ key: "h2h", outcomes: [{ name: "H" + id, price: -120 }, { name: "A" + id, price: 100 }] }] }],
  ...extra,
});
const raw = (g: ReturnType<typeof game>) => ({
  id: g.id,
  sport_key: g.sportKey,
  home_team: g.homeTeam,
  away_team: g.awayTeam,
  commence_time: g.commenceTime,
  bookmakers: g.bookmakers,
});

const g1 = game("e1", "2026-06-15T17:00:00Z"); // 13:00 ET
const g2 = game("e2", "2026-06-15T20:00:00Z"); // 16:00 ET
const g3 = game("e3", "2026-06-15T23:00:00Z"); // 19:00 ET
const gNew = game("e4", "2026-06-15T23:30:00Z"); // late nightcap, not cached yet
const gTomorrow = game("e5", "2026-06-16T23:00:00Z");
const gStarted = game("e6", "2026-06-15T13:00:00Z"); // began before the clock

async function seed(sportKey: string, fetchDate: string, games: unknown[]) {
  await prisma.oddsSnapshot.upsert({
    where: { sportKey_fetchDate: { sportKey, fetchDate } },
    update: { data: games as never },
    create: { sportKey, fetchDate, data: games as never },
  });
}
async function readData(sportKey: string, fetchDate: string) {
  return (await prisma.oddsSnapshot.findUnique({ where: { sportKey_fetchDate: { sportKey, fetchDate } } }))?.data;
}
async function cleanup() {
  await prisma.oddsSnapshot.deleteMany({ where: { fetchDate: { in: [DAY, "2026-06-14"] }, sportKey: { in: [MLB, NFL, CFL] } } });
}

async function run(label: string, sportKey: string, atMs: number, apiBulk: unknown[] | "fail" = []) {
  now = atMs;
  bulk = apiBulk;
  fetchCalls = 0;
  wholeBlobReads.n = 0;
  (globalThis as { Date: unknown }).Date = FakeDate;
  let res: { added: number; status: string };
  try {
    res = await backfillOddsForSport(sportKey);
  } finally {
    (globalThis as { Date: unknown }).Date = RealDate;
  }
  const out = { label, status: res.status, added: res.added, fetchCalls };
  console.log("  " + JSON.stringify(out) + ` wholeBlobReads=${wholeBlobReads.n}`);
  return { ...out, wholeBlobReads: wholeBlobReads.n };
}

// Decision table captured from the pre-change code.
const EXPECTED_DECISIONS: unknown = JSON.parse(
  '[{"label":"off_season","status":"off_season","added":0,"fetchCalls":0},{"label":"no_base_row","status":"no_base_row","added":0,"fetchCalls":0},{"label":"all_started","status":"all_started","added":0,"fetchCalls":0},{"label":"nothing_missing","status":"nothing_missing","added":0,"fetchCalls":1},{"label":"added","status":"added","added":1,"fetchCalls":1},{"label":"empty_row_fetches","status":"added","added":1,"fetchCalls":1},{"label":"fetch_failed","status":"fetch_failed","added":0,"fetchCalls":1},{"label":"no_api_key","status":"no_api_key","added":0,"fetchCalls":0}]'
);
const EXPECTED_GATE: unknown = JSON.parse(
  '[["in-window game today",true],["only out-of-window today",false],["starting within +1h",true],["yesterday row counts",true],["empty snapshot",false],["dormant: no rows",false]]'
);

async function main() {
  const savedKey = process.env.ODDS_API_KEY;
  process.env.ODDS_API_KEY = "test-key";
  await cleanup();
  const decisions: unknown[] = [];
  const keep = (r: Awaited<ReturnType<typeof run>>) => {
    const { wholeBlobReads: _w, ...rest } = r;
    decisions.push(rest);
    return r;
  };

  // 1. off season -> no read, no fetch
  keep(await run("off_season", NFL, T0));
  // 2. in season, no row today
  keep(await run("no_base_row", MLB, T0));
  // 3. row exists, every game today started -> all_started, no fetch
  await seed(MLB, DAY, [g1, g2, g3]);
  keep(await run("all_started", MLB, Date.parse("2026-06-15T23:45:00Z")));
  // 4. some not started; API returns nothing new (tomorrow + started noise)
  keep(await run("nothing_missing", MLB, T0, [raw(g1), raw(g2), raw(g3), raw(gTomorrow), raw(gStarted)]));
  expect("nothing_missing left the blob untouched", await readData(MLB, DAY), JSON.parse(JSON.stringify([g1, g2, g3])));
  // 5. API returns a new same-day game -> appended, existing bytes untouched
  const added = keep(await run("added", MLB, T0, [raw(g1), raw(g3), raw(gNew), raw(gTomorrow), raw(gStarted)]));
  const afterAdd = await readData(MLB, DAY);
  // 6. empty cached list must NOT be skipped as all_started
  await seed(MLB, DAY, []);
  keep(await run("empty_row_fetches", MLB, T0, [raw(g3)]));
  const afterEmptyAdd = await readData(MLB, DAY);
  // 7. primary fetch failure
  await seed(MLB, DAY, [g1, g3]);
  keep(await run("fetch_failed", MLB, T0, "fail"));
  // 8. no api key
  delete process.env.ODDS_API_KEY;
  keep(await run("no_api_key", MLB, T0));
  process.env.ODDS_API_KEY = "test-key";

  expect("added path merged blob (existing games first, then the new one)", afterAdd, [g1, g2, g3, gNew]);
  expect("empty row + one fresh game -> exactly that game stored", (afterEmptyAdd as { id: string }[]).map((g) => g.id), ["e3"]);
  expect("added: one game appended", added.added, 1);

  const cmp = JSON.parse(JSON.stringify(decisions));
  expect("decision table identical to pre-change output", cmp, EXPECTED_DECISIONS);

  // 9. The check path must not read the whole blob any more (steps 3, 4, 7).
  await seed(MLB, DAY, [g1, g2, g3]);
  const checkOnly = await run("check path only (nothing_missing)", MLB, T0, [raw(g1), raw(g2), raw(g3)]);
  expect("check path performs no whole-blob read", checkOnly.wholeBlobReads, 0);
  const allStarted = await run("check path only (all_started)", MLB, Date.parse("2026-06-15T23:45:00Z"));
  expect("all_started performs no whole-blob read", allStarted.wholeBlobReads, 0);

  // 9b. The helper returns exactly the (id, commenceTime) projection of the
  //     blob; a date with no row is absent; an empty row is [] (present).
  await seed(MLB, DAY, [g1, g2, g3, gNew]);
  await seed(MLB, "2026-06-14", []);
  const stubs = await getOddsGameStubs(MLB, [DAY, "2026-06-14", "2026-06-13"]);
  const blob = (await readData(MLB, DAY)) as { id: string; commenceTime: string }[];
  expect("stubs == projection of blob", stubs.get(DAY), blob.map((g) => ({ id: g.id, commenceTime: g.commenceTime })));
  expect("empty row -> [] (present)", stubs.get("2026-06-14"), []);
  expect("missing date is absent", stubs.has("2026-06-13"), false);
  await prisma.oddsSnapshot.deleteMany({ where: { sportKey: MLB, fetchDate: "2026-06-14" } });

  // 10. CFL score-window gate: same answers as before for in-window / out-of-window.
  const cflIn = game("c1", "2026-06-15T15:00:00Z", { sportKey: CFL }); // started 1h before
  const cflOut = game("c2", "2026-06-15T02:00:00Z", { sportKey: CFL }); // 12h before
  const cflSoon = game("c3", "2026-06-15T14:30:00Z", { sportKey: CFL }); // starts in 30m (<= +1h)
  const cflLate = game("c4", "2026-06-15T16:30:00Z", { sportKey: CFL }); // starts in 2.5h (> +1h)
  const gate = async (label: string, games: unknown[], yGames: unknown[] | null, atMs: number) => {
    await prisma.oddsSnapshot.deleteMany({ where: { sportKey: CFL, fetchDate: { in: [DAY, "2026-06-14"] } } });
    await seed(CFL, DAY, games);
    if (yGames) await seed(CFL, "2026-06-14", yGames);
    now = atMs;
    wholeBlobReads.n = 0;
    (globalThis as { Date: unknown }).Date = FakeDate;
    let r: boolean;
    try {
      r = await cflGameWithinScoreWindow();
    } finally {
      (globalThis as { Date: unknown }).Date = RealDate;
    }
    gateBlobReads += wholeBlobReads.n;
    return [label, r];
  };
  let gateBlobReads = 0;
  const clock = T0 + 1 * 3600_000; // 15:00Z
  const gateResults = [
    await gate("in-window game today", [cflIn], null, clock),
    await gate("only out-of-window today", [cflOut, cflLate], null, clock),
    await gate("starting within +1h", [cflSoon], null, T0),
    await gate("yesterday row counts", [cflOut], [game("c5", "2026-06-15T10:00:00Z", { sportKey: CFL })], clock),
    await gate("empty snapshot", [], null, clock),
  ];
  await prisma.oddsSnapshot.deleteMany({ where: { sportKey: CFL, fetchDate: { in: [DAY, "2026-06-14"] } } });
  await prisma.oddsSnapshot.deleteMany({ where: { sportKey: CFL, fetchDate: { in: [DAY, "2026-06-14"] } } });
  const noRows = await (async () => {
    now = clock;
    (globalThis as { Date: unknown }).Date = FakeDate;
    try {
      return await cflGameWithinScoreWindow();
    } finally {
      (globalThis as { Date: unknown }).Date = RealDate;
    }
  })();
  gateResults.push(["dormant: no rows", noRows]);
  expect("CFL gate answers identical to pre-change output", gateResults, EXPECTED_GATE);
  expect("CFL gate performs no whole-blob read", gateBlobReads, 0);

  if (savedKey === undefined) delete process.env.ODDS_API_KEY;
  else process.env.ODDS_API_KEY = savedKey;
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(async () => {
    (globalThis as { Date: unknown }).Date = RealDate;
    restores.forEach((r) => r());
    globalThis.fetch = realFetch;
    await cleanup().catch(() => {});
    await prisma.oddsSnapshot.deleteMany({ where: { sportKey: CFL, fetchDate: { in: [DAY, "2026-06-14"] } } }).catch(() => {});
    await prisma.$disconnect();
    console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  });
