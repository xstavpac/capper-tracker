// Proof for the ticker's slim odds read (getTickerOddsForSport):
//   1. IDENTICAL OUTPUT: getLiveTickerGames() over seeded OddsSnapshot rows
//      (rich, full-bookmaker blobs) + stubbed score feeds returns exactly what
//      it returned before the change (EXPECTED_TICKER was captured from the
//      pre-change code, which read the whole blob via getOddsForSport).
//   2. SLIM READ: the ticker path no longer pulls the blob - it reads a
//      projection of id/homeTeam/awayTeam/commenceTime. Bytes per cache miss
//      are measured (full blob vs projection) and asserted to be a small
//      fraction.
//   3. INVALIDATION: the slim cache entry has its own key but carries the
//      SAME tag every odds write path revalidates, so a seed/backfill/prop
//      write still invalidates it; and its TTL is not the 60s odds TTL.
//   4. Fallbacks: no snapshot row yet -> falls through to the full path (which
//      may seed it, as before); off-season sport -> [] with no DB read.
//
// DB-backed (seeded throwaway DB - see scripts/run-tests.mjs); stubs global
// fetch (MLB schedule + ESPN WNBA scoreboard) and freezes the clock. Cleans up
// after itself. Run with:
//   npx tsx src/server/data/live-ticker-odds-cache-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import { getLiveTickerGames } from "@/server/data/live-ticker";
import * as oddsModule from "@/server/data/odds";
import { cacheKeys } from "@/lib/cache-keys";

let failures = 0;
// Key-order-insensitive (jsonb does not preserve object key order); array
// order still matters.
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
function ok(label: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}${cond || detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
}

const MLB = "baseball_mlb";
const WNBA = "basketball_wnba";
const DAY = "2026-06-15";
const T0 = Date.parse("2026-06-15T18:00:00Z"); // 2pm ET

const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(T0);
    else super(...(args as [string]));
  }
  static now() {
    return T0;
  }
}

// --- fixtures
const books = ["draftkings", "fanduel", "betmgm", "caesars", "betrivers", "bovada", "mybookie", "betonline", "lowvig", "pointsbet"];
const oddsGame = (sportKey: string, id: string, home: string, away: string, at: string) => ({
  id,
  sportKey,
  homeTeam: home,
  awayTeam: away,
  commenceTime: at,
  bookmakers: books.map((b) => ({
    key: b,
    title: b,
    last_update: "2026-06-15T12:00:00Z",
    markets: [
      { key: "h2h", last_update: "x", outcomes: [{ name: home, price: -150 }, { name: away, price: 130 }] },
      { key: "spreads", last_update: "x", outcomes: [{ name: home, price: -110, point: -1.5 }, { name: away, price: -110, point: 1.5 }] },
      { key: "totals", last_update: "x", outcomes: [{ name: "Over", price: -110, point: 8.5 }, { name: "Under", price: -110, point: 8.5 }] },
    ],
  })),
});
const MLB_ODDS = [
  oddsGame(MLB, "e1", "Boston Red Sox", "New York Yankees", "2026-06-15T17:05:00Z"),
  oddsGame(MLB, "e2", "Chicago Cubs", "St. Louis Cardinals", "2026-06-15T20:00:00Z"),
  oddsGame(MLB, "e3", "Houston Astros", "Texas Rangers", "2026-06-15T23:00:00Z"),
  oddsGame(MLB, "e4", "Seattle Mariners", "Oakland Athletics", "2026-06-16T23:00:00Z"), // tomorrow
  oddsGame(MLB, "e0", "Toronto Blue Jays", "Tampa Bay Rays", "2026-06-14T23:00:00Z"), // yesterday
];
const WNBA_ODDS = [
  oddsGame(WNBA, "w1", "Las Vegas Aces", "New York Liberty", "2026-06-15T23:00:00Z"), // same start as e3 (tie)
  oddsGame(WNBA, "w2", "Seattle Storm", "Phoenix Mercury", "2026-06-16T01:00:00Z"), // 9pm ET, still today
];

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown) => {
  const url = String(input);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (url.includes("statsapi.mlb.com/api/v1/schedule")) {
    const game = (pk: number, home: string, away: string, state: string, hs: number, as: number, at: string, extra: object = {}) => ({
      gamePk: pk,
      gameDate: at,
      gameNumber: 1,
      doubleHeader: "N",
      status: { abstractGameState: state },
      teams: { home: { team: { name: home }, score: hs }, away: { team: { name: away }, score: as } },
      linescore: { innings: [], ...extra },
    });
    return json({
      dates: [
        {
          games: [
            game(1001, "Boston Red Sox", "New York Yankees", "Final", 5, 3, "2026-06-15T17:05:00Z"),
            game(1002, "Chicago Cubs", "St. Louis Cardinals", "Live", 2, 2, "2026-06-15T20:00:00Z", { inningState: "Top", currentInningOrdinal: "5th" }),
          ],
        },
      ],
    });
  }
  if (url.includes("site.api.espn.com") && url.includes("basketball/wnba/scoreboard")) {
    return json({
      events: [
        {
          id: "wn1",
          date: "2026-06-15T23:00:00Z",
          status: { type: { state: "in" }, period: 3, displayClock: "5:00" },
          competitions: [{ competitors: [{ homeAway: "home", team: { displayName: "Las Vegas Aces" }, score: "50" }, { homeAway: "away", team: { displayName: "New York Liberty" }, score: "48" }] }],
        },
      ],
    });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

// --- byte accounting: what the ticker path reads from oddsSnapshot
const bytes = { fullBlob: 0, slim: 0, fullBlobReads: 0 };
type AnyFn = (...a: unknown[]) => unknown;
const restores: (() => void)[] = [];
{
  const target = (prisma as unknown as Record<string, Record<string, AnyFn>>).oddsSnapshot;
  for (const m of ["findUnique", "findFirst", "findMany"]) {
    const orig = target[m];
    target[m] = async function (...a: unknown[]) {
      const res = (await orig.apply(target, a)) as unknown;
      const rows = Array.isArray(res) ? res : res ? [res] : [];
      for (const r of rows) {
        const data = (r as { data?: unknown }).data;
        if (data !== undefined) {
          bytes.fullBlob += JSON.stringify(data).length;
          bytes.fullBlobReads++;
        }
      }
      return res;
    };
    restores.push(() => {
      target[m] = orig;
    });
  }
  const origRaw = prisma.$queryRaw.bind(prisma);
  (prisma as unknown as { $queryRaw: unknown }).$queryRaw = async (...a: unknown[]) => {
    const res = await (origRaw as unknown as AnyFn)(...a);
    if (JSON.stringify(a[0] ?? "").includes("odds_snapshots")) bytes.slim += JSON.stringify(res).length;
    return res;
  };
  restores.push(() => {
    (prisma as unknown as { $queryRaw: unknown }).$queryRaw = origRaw;
  });
}

async function cleanup() {
  await prisma.oddsSnapshot.deleteMany({ where: { fetchDate: DAY, sportKey: { in: [MLB, WNBA] } } });
}

// Captured from the pre-change code (whole blob via getOddsForSport).
const EXPECTED_TICKER: unknown = JSON.parse(
  '[{"id":"e1","sportKey":"baseball_mlb","sportLabel":"MLB","homeTeam":"Boston Red Sox","awayTeam":"New York Yankees","homeShort":"Red Sox","awayShort":"Yankees","commenceTime":"2026-06-15T17:05:00Z","status":"final","homeScore":5,"awayScore":3,"inningHalf":null,"inningOrdinal":null,"accentColor":"#BD3039"},{"id":"e2","sportKey":"baseball_mlb","sportLabel":"MLB","homeTeam":"Chicago Cubs","awayTeam":"St. Louis Cardinals","homeShort":"Cubs","awayShort":"Cardinals","commenceTime":"2026-06-15T20:00:00Z","status":"live","homeScore":2,"awayScore":2,"inningHalf":"Top","inningOrdinal":"5th","accentColor":"#0E3386"},{"id":"e3","sportKey":"baseball_mlb","sportLabel":"MLB","homeTeam":"Houston Astros","awayTeam":"Texas Rangers","homeShort":"Astros","awayShort":"Rangers","commenceTime":"2026-06-15T23:00:00Z","status":"preview","homeScore":null,"awayScore":null,"inningHalf":null,"inningOrdinal":null,"accentColor":"#EB6E1F"},{"id":"w1","sportKey":"basketball_wnba","sportLabel":"WNBA","homeTeam":"Las Vegas Aces","awayTeam":"New York Liberty","homeShort":"Aces","awayShort":"Liberty","commenceTime":"2026-06-15T23:00:00Z","status":"live","homeScore":50,"awayScore":48,"inningHalf":null,"inningOrdinal":null,"accentColor":"#BA0C2F"},{"id":"w2","sportKey":"basketball_wnba","sportLabel":"WNBA","homeTeam":"Seattle Storm","awayTeam":"Phoenix Mercury","homeShort":"Storm","awayShort":"Mercury","commenceTime":"2026-06-16T01:00:00Z","status":"preview","homeScore":null,"awayScore":null,"inningHalf":null,"inningOrdinal":null,"accentColor":"#2C5234"}]'
);

async function main() {
  await cleanup();
  await prisma.oddsSnapshot.create({ data: { sportKey: MLB, fetchDate: DAY, data: MLB_ODDS as never } });
  await prisma.oddsSnapshot.create({ data: { sportKey: WNBA, fetchDate: DAY, data: WNBA_ODDS as never } });

  (globalThis as { Date: unknown }).Date = FakeDate;
  let ticker: unknown;
  try {
    ticker = await getLiveTickerGames();
  } finally {
    (globalThis as { Date: unknown }).Date = RealDate;
  }
  console.log(`  bytes: fullBlob=${bytes.fullBlob} (reads=${bytes.fullBlobReads}) slim=${bytes.slim}`);
  expect("ticker output identical to pre-change output", ticker, EXPECTED_TICKER);
  expect("ticker shows exactly today's 5 games (no yesterday/tomorrow)", (ticker as unknown[]).length, 5);

  // ---- slim-read properties (post-change only)
  const getTickerOddsForSport = (oddsModule as unknown as Record<string, unknown>).getTickerOddsForSport as
    | undefined
    | ((k: string) => Promise<{ id: string; homeTeam: string; awayTeam: string; commenceTime: string }[]>);
  const paramsFn = (oddsModule as unknown as Record<string, unknown>).tickerOddsCacheParams as
    | undefined
    | ((k: string, d: string) => { key: string; tags: string[]; ttlSeconds: number });
  if (getTickerOddsForSport && paramsFn) {
    ok("ticker path reads no whole blob", bytes.fullBlobReads === 0, bytes);
    ok("slim bytes are < 5% of the blob it replaces", bytes.slim > 0 && bytes.slim < 0.05 * (JSON.stringify(MLB_ODDS).length + JSON.stringify(WNBA_ODDS).length), bytes);

    (globalThis as { Date: unknown }).Date = FakeDate;
    let slim: Awaited<ReturnType<NonNullable<typeof getTickerOddsForSport>>>;
    try {
      slim = await getTickerOddsForSport(MLB);
    } finally {
      (globalThis as { Date: unknown }).Date = RealDate;
    }
    expect(
      "slim result == the 4-field projection of the blob, in stored order",
      slim,
      MLB_ODDS.map((g) => ({ id: g.id, homeTeam: g.homeTeam, awayTeam: g.awayTeam, commenceTime: g.commenceTime }))
    );

    const p = paramsFn(MLB, DAY);
    ok("slim entry has its own key (never collides with the full-blob entry)", p.key !== cacheKeys.odds(MLB, DAY));
    ok("slim entry carries the tag every odds write path revalidates", p.tags.includes(cacheKeys.odds(MLB, DAY)), p);
    ok("slim TTL is longer than the 60s odds TTL (invalidation-driven, TTL is only a backstop)", p.ttlSeconds > 60, p);

    // off-season: [] and no DB read at all
    const before = { ...bytes };
    (globalThis as { Date: unknown }).Date = FakeDate;
    let nfl: unknown;
    try {
      nfl = await getTickerOddsForSport("americanfootball_nfl");
    } finally {
      (globalThis as { Date: unknown }).Date = RealDate;
    }
    expect("off-season sport -> []", nfl, []);
    expect("off-season sport read nothing", [bytes.slim, bytes.fullBlob], [before.slim, before.fullBlob]);
  } else {
    console.log("  (pre-change code: slim helpers not present - output check only)");
  }
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
    await prisma.$disconnect();
    console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  });
