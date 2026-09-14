// Proof for the fetch/merge/orchestration half of nfl-prop-odds.ts
// (mergePropBookmakersIntoGame, fetchAndMergeNflPropOdds,
// seedNflPropOddsForToday) - the normalization half
// (normalizePlayerPropLines) has its own test file,
// nfl-prop-odds-acceptance-test.ts.
//
// Pure except that prisma.oddsSnapshot / prisma.oddsApiUsageLog and global
// fetch are stubbed throughout - no real network call, no real DB. NEVER
// remove the "unexpected fetch" throw in stubFetch below: this file exists
// specifically to prove the credit-gate stops calls before they happen, so
// an accidental real call here would spend real money silently.
//
// Listed in PURE_DESPITE_PRISMA_IMPORT in scripts/run-tests.mjs. Run with:
//   npx tsx src/server/data/nfl-prop-odds-fetch-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import { mergePropBookmakersIntoGame, fetchAndMergeNflPropOdds, seedNflPropOddsForToday } from "@/server/data/nfl-prop-odds";
import type { OddsGame } from "@/server/data/odds";

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
}

const realFetch = globalThis.fetch;
let fetchCalls: string[] = [];
// routes: eventId -> response. Any URL not matching a routed eventId throws,
// same "never let this silently no-op into a real call" guarantee as
// odds-preseason-merge-acceptance-test.ts's stubFetchByKey.
function stubEventOddsFetch(routes: Record<string, { ok: boolean; status?: number; body?: unknown; headers?: Record<string, string> }>) {
  fetchCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    fetchCalls.push(url.replace(/apiKey=[^&]+/, "apiKey=REDACTED"));
    const match = Object.keys(routes).find((id) => url.includes("/events/" + id + "/odds"));
    if (!match) throw new Error("unexpected fetch (would have spent real credits): " + url.replace(/apiKey=[^&]+/, "apiKey=REDACTED"));
    const r = routes[match];
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      statusText: r.ok ? "OK" : "ERR",
      headers: new Headers(r.headers ?? {}),
      json: async () => r.body ?? {},
      text: async () => JSON.stringify(r.body ?? {}),
    } as Response;
  }) as typeof fetch;
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}

function baseGame(id: string, commenceTime: string): OddsGame {
  return {
    id,
    sportKey: "americanfootball_nfl",
    homeTeam: "Kansas City Chiefs",
    awayTeam: "Denver Broncos",
    commenceTime,
    bookmakers: [
      { key: "draftkings", title: "DraftKings", markets: [{ key: "h2h", outcomes: [{ name: "Kansas City Chiefs", price: -150 }] }] },
    ],
  };
}

async function main() {
  // =====================================================================
  // 1. mergePropBookmakersIntoGame - pure, no stubbing
  // =====================================================================
  const g1 = baseGame("evt1", "2026-09-21T17:00:00Z");
  const merged1 = mergePropBookmakersIntoGame(g1, [
    { key: "draftkings", title: "DraftKings", markets: [{ key: "player_anytime_td", outcomes: [{ name: "Yes", description: "Patrick Mahomes", price: 700 }] }] },
    { key: "fanduel", title: "FanDuel", markets: [{ key: "player_anytime_td", outcomes: [{ name: "Yes", description: "Travis Kelce", price: 200 }] }] },
  ]);
  expect("merge: existing bookmaker (draftkings) keeps its h2h market AND gains the prop market", merged1.bookmakers.find((b) => b.key === "draftkings")?.markets.map((m) => m.key), ["h2h", "player_anytime_td"]);
  ok("merge: a book absent from the original game (fanduel) is added as a new bookmaker", !!merged1.bookmakers.find((b) => b.key === "fanduel"));
  expect("merge: original game object is not mutated (new bookmakers array)", g1.bookmakers.length, 1);

  const merged2 = mergePropBookmakersIntoGame(merged1, [
    { key: "draftkings", title: "DraftKings", markets: [{ key: "player_anytime_td", outcomes: [{ name: "Yes", description: "UPDATED", price: 999 }] }] },
  ]);
  const dkMarket = merged2.bookmakers.find((b) => b.key === "draftkings")?.markets.find((m) => m.key === "player_anytime_td");
  expect("merge: re-merging the SAME market key replaces rather than duplicates", dkMarket?.outcomes, [{ name: "Yes", description: "UPDATED", price: 999 }]);

  // =====================================================================
  // 2. fetchAndMergeNflPropOdds - credit gate + per-event fetch/merge
  // =====================================================================
  // 2a. Usage already at/over 95% -> every event skipped, ZERO fetch calls.
  patch("oddsApiUsageLog.findFirst", async () => ({ creditsUsed: 19500, creditsRemaining: 500 })); // 97.5%
  stubEventOddsFetch({}); // no routes - ANY call throws
  const gated = await fetchAndMergeNflPropOdds([baseGame("evtA", "2026-09-21T17:00:00Z")], "test-key");
  expect("credit gate: usage >=95% skips the event entirely", { fetched: gated.eventsFetched, skipped: gated.eventsSkippedCreditGate }, { fetched: 0, skipped: 1 });
  expect("credit gate: zero fetch calls made when gated", fetchCalls.length, 0);
  restoreFetch();

  // 2b. Healthy usage -> fetches, merges, and persists usage.
  patch("oddsApiUsageLog.findFirst", async () => ({ creditsUsed: 1000, creditsRemaining: 19000 })); // 5%
  let usageWrites: any[] = [];
  patch("oddsApiUsageLog.count", async () => 0);
  patch("oddsApiUsageLog.create", async ({ data }: { data: any }) => {
    usageWrites.push(data);
    return { id: "row", ...data };
  });
  stubEventOddsFetch({
    evtB: {
      ok: true,
      headers: { "x-requests-remaining": "18995", "x-requests-used": "1005" },
      body: {
        id: "evtB",
        bookmakers: [{ key: "draftkings", title: "DraftKings", markets: [{ key: "player_anytime_td", outcomes: [{ name: "Yes", description: "Patrick Mahomes", price: 700 }] }] }],
      },
    },
  });
  const healthy = await fetchAndMergeNflPropOdds([baseGame("evtB", "2026-09-21T17:00:00Z")], "test-key");
  expect("healthy: one event fetched and merged", { fetched: healthy.eventsFetched, skipped: healthy.eventsSkippedCreditGate, failed: healthy.eventsFailed }, { fetched: 1, skipped: 0, failed: 0 });
  expect("healthy: the merged game now has the player_anytime_td market", healthy.games[0].bookmakers.find((b) => b.key === "draftkings")?.markets.map((m) => m.key), ["h2h", "player_anytime_td"]);
  expect("healthy: usage was persisted for this call", usageWrites.length, 1);
  expect("healthy: exactly one fetch call, bundling all 5 markets (not 5 separate calls)", fetchCalls.length, 1);
  ok(
    "healthy: that one call's markets param lists all 5 gradeable markets",
    fetchCalls[0].includes("markets=player_pass_tds,player_pass_yds,player_pass_attempts,player_pass_completions,player_anytime_td"),
    fetchCalls[0]
  );
  restoreFetch();

  // 2c. A mid-batch threshold crossing stops the REST of the batch.
  patch("oddsApiUsageLog.findFirst", async () => ({ creditsUsed: 1000, creditsRemaining: 19000 })); // starts healthy (5%)
  usageWrites = [];
  patch("oddsApiUsageLog.create", async ({ data }: { data: any }) => {
    usageWrites.push(data);
    return { id: "row", ...data };
  });
  stubEventOddsFetch({
    evtC: {
      ok: true,
      headers: { "x-requests-remaining": "500", "x-requests-used": "19500" }, // 97.5% - crosses the line on THIS call
      body: { id: "evtC", bookmakers: [{ key: "draftkings", title: "DraftKings", markets: [{ key: "player_anytime_td", outcomes: [{ name: "Yes", description: "P1", price: 100 }] }] }] },
    },
    // evtD deliberately has no route - if the loop wrongly tries to fetch it
    // after evtC pushed usage over 95%, this test throws.
  });
  const midBatch = await fetchAndMergeNflPropOdds(
    [baseGame("evtC", "2026-09-21T17:00:00Z"), baseGame("evtD", "2026-09-21T18:00:00Z")],
    "test-key"
  );
  expect("mid-batch: first event fetched (usage was healthy at the time)", midBatch.eventsFetched, 1);
  expect("mid-batch: second event skipped (this call's own response pushed usage over 95%)", midBatch.eventsSkippedCreditGate, 1);
  expect("mid-batch: exactly one fetch call made - the loop stopped, not just logged a warning", fetchCalls.length, 1);
  restoreFetch();
  restorePrisma();

  // =====================================================================
  // 3. seedNflPropOddsForToday - status paths
  // =====================================================================
  const realApiKey = process.env.ODDS_API_KEY;

  // 3a. No API key configured -> no_api_key, no DB read, no fetch.
  delete process.env.ODDS_API_KEY;
  stubEventOddsFetch({});
  patch("oddsSnapshot.findUnique", async () => {
    throw new Error("should not read the snapshot when there's no API key");
  });
  const noKey = await seedNflPropOddsForToday();
  expect("seedNflPropOddsForToday: no ODDS_API_KEY -> no_api_key, no games touched", { status: noKey.status, fetched: noKey.eventsFetched }, { status: "no_api_key", fetched: 0 });
  restorePrisma();
  restoreFetch();
  if (realApiKey !== undefined) process.env.ODDS_API_KEY = realApiKey;

  // 3b. No snapshot row for today yet (bulk seed hasn't run / failed) -> no_snapshot.
  patch("oddsSnapshot.findUnique", async () => null);
  stubEventOddsFetch({});
  const noSnap = await seedNflPropOddsForToday();
  expect("seedNflPropOddsForToday: no snapshot row today -> no_snapshot", noSnap.status, "no_snapshot");
  restorePrisma();
  restoreFetch();

  // 3c. Snapshot exists but every game already started -> no_games_to_fetch.
  const pastGame = baseGame("pastEvt", "2020-01-01T00:00:00Z");
  patch("oddsSnapshot.findUnique", async () => ({ data: [pastGame] }));
  stubEventOddsFetch({});
  const allStarted = await seedNflPropOddsForToday();
  expect("seedNflPropOddsForToday: all games already started -> no_games_to_fetch", allStarted.status, "no_games_to_fetch");
  restorePrisma();
  restoreFetch();

  // 3d. Happy path: one not-started game gets props merged and re-persisted;
  //     an already-started game in the same snapshot is left untouched.
  const future = baseGame("futureEvt", "2099-01-01T00:00:00Z");
  const started = baseGame("startedEvt", "2020-01-01T00:00:00Z");
  patch("oddsSnapshot.findUnique", async () => ({ data: [future, started] }));
  patch("oddsApiUsageLog.findFirst", async () => ({ creditsUsed: 1000, creditsRemaining: 19000 }));
  patch("oddsApiUsageLog.count", async () => 0);
  patch("oddsApiUsageLog.create", async ({ data }: { data: any }) => ({ id: "row", ...data }));
  let updatedData: OddsGame[] | null = null;
  patch("oddsSnapshot.update", async ({ data }: { data: { data: OddsGame[] } }) => {
    updatedData = data.data;
    return {};
  });
  stubEventOddsFetch({
    futureEvt: {
      ok: true,
      headers: { "x-requests-remaining": "18999", "x-requests-used": "1001" },
      body: { id: "futureEvt", bookmakers: [{ key: "draftkings", title: "DraftKings", markets: [{ key: "player_anytime_td", outcomes: [{ name: "Yes", description: "Patrick Mahomes", price: 700 }] }] }] },
    },
  });
  const happy = await seedNflPropOddsForToday();
  expect("seedNflPropOddsForToday: happy path status", happy.status, "seeded");
  expect("seedNflPropOddsForToday: only the not-started event was fetched", happy.eventsFetched, 1);
  const persisted = updatedData as OddsGame[] | null;
  ok("seedNflPropOddsForToday: re-persisted data includes both games", persisted !== null && persisted.length === 2, persisted);
  const persistedFuture = (persisted as OddsGame[]).find((g) => g.id === "futureEvt");
  const persistedStarted = (persisted as OddsGame[]).find((g) => g.id === "startedEvt");
  ok("seedNflPropOddsForToday: the future game gained the prop market", !!persistedFuture?.bookmakers.find((b) => b.markets.some((m) => m.key === "player_anytime_td")));
  expect("seedNflPropOddsForToday: the already-started game is byte-for-byte untouched", persistedStarted, started);

  restorePrisma();
  restoreFetch();

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
