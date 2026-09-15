// Proof that every OddsSnapshot write path actually ATTEMPTS cache
// invalidation (not just that its predicate function returns the right
// boolean in isolation - odds-cache-invalidation-acceptance-test.ts already
// covers that), and that a consumer reading AFTER all of a day's writes have
// settled sees the fully-enriched result.
//
// This file has no real Next.js request context (bare tsx), so every
// revalidateTag call throws unconditionally ("Invariant: static generation
// store missing") - caught by each write path's own try/catch and logged,
// never left to crash the write. That's not a workaround for this test: it's
// the actual proof mechanism. A write path that correctly gates + attempts
// invalidation logs exactly one "revalidateTag failed" line naming the exact
// cacheKeys.odds(sportKey, fetchDate) key it targeted; a write path that
// (correctly) decided NOT to invalidate - because its own status means
// nothing was written - logs none. Counting those log lines is a direct,
// faithful proxy for "was revalidateTag called, and with which key" -
// verified against a monkey-patched revalidateTag spy first (see this
// file's own header note below) and abandoned only because ES module
// namespace exports are read-only at runtime (Node throws "Cannot assign to
// read only property" on the attempt), not because this proxy is a weaker
// substitute chosen for convenience.
//
// Stubs global fetch (routing bulk-odds vs per-event-prop-odds calls by URL
// shape) and prisma.oddsSnapshot/oddsApiUsageLog - no real network, no real
// DB. Run with:
//   npx tsx src/server/data/odds-write-path-invalidation-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import { seedOddsSnapshot, backfillOddsForSport } from "@/server/data/odds";
import { seedNflPropOddsForToday, resolvePropOdds } from "@/server/data/nfl-prop-odds";
import { easternDateKey } from "@/lib/dates";
import type { OddsGame } from "@/server/data/odds";

let failures = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
}
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
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
// Routes both call shapes this file's functions under test make: the bulk
// "/sports/{key}/odds" listing (getOddsForSportUncached, via
// fetchMergedOddsListing) and the per-event "/events/{id}/odds" prop fetch
// (fetchAndMergeNflPropOdds). Any unrouted URL throws - same "never let an
// accidental real call silently no-op" guarantee the existing fetch stubs in
// this codebase already enforce.
function stubFetch(opts: { bulk?: unknown; events?: Record<string, unknown> }) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/events/")) {
      const id = Object.keys(opts.events ?? {}).find((eid) => url.includes("/events/" + eid + "/odds"));
      if (!id) throw new Error("unexpected per-event fetch: " + url);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "x-requests-remaining": "19000", "x-requests-used": "1000" }),
        json: async () => opts.events![id],
        text: async () => JSON.stringify(opts.events![id]),
      } as Response;
    }
    if (opts.bulk === undefined) throw new Error("unexpected bulk fetch: " + url);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "x-requests-remaining": "19000", "x-requests-used": "1000" }),
      json: async () => opts.bulk,
      text: async () => JSON.stringify(opts.bulk),
    } as Response;
  }) as typeof fetch;
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

function invalidationAttempts(lines: string[], fnTag: string, cacheKey: string): number {
  return lines.filter((l) => l.includes(`[${fnTag}] revalidateTag failed`) && l.includes(cacheKey)).length;
}

const NFL = "americanfootball_nfl";
const fetchDate = easternDateKey(new Date());
const nflOddsKey = `odds:${NFL}:${fetchDate}`;
// A future commenceTime relative to the real clock, not frozen time - none
// of these tests depend on a specific calendar day the way
// odds-usage-log-failure-acceptance-test.ts's backfill same-day filter does,
// so a plain future timestamp is enough and keeps this file simpler.
const laterToday = new Date(Date.now() + 2 * 3600000).toISOString();

async function main() {
  const realApiKey = process.env.ODDS_API_KEY;
  process.env.ODDS_API_KEY = "test-key";

  // =====================================================================
  // 1. Test A - seedOddsSnapshot then seedNflPropOddsForToday, same
  //    sequence /api/cron/refresh-odds actually runs. Each write must
  //    independently attempt invalidation for the exact same dated NFL key
  //    - proving the second write's invalidation isn't skipped just because
  //    the first one already fired (the gap this round's design closed).
  // =====================================================================
  patch("oddsSnapshot.findUnique", async () => null); // cache miss -> seedOddsSnapshot does a real fetch+upsert
  patch("oddsSnapshot.upsert", async () => ({}));
  patch("oddsApiUsageLog.count", async () => 0);
  patch("oddsApiUsageLog.create", async () => ({}));
  stubFetch({
    bulk: [{ id: "g1", sport_key: NFL, home_team: "Kansas City Chiefs", away_team: "Denver Broncos", commence_time: laterToday, bookmakers: [] }],
  });
  let lines = captureConsoleError();
  const seedResult = await seedOddsSnapshot(NFL);
  restoreConsoleError();
  restoreFetch();
  restorePrisma();

  expect("Test A step 1: seedOddsSnapshot reports 'seeded' (a real write happened)", seedResult.status, "seeded");
  expect(
    "Test A step 1: seedOddsSnapshot attempted invalidation exactly once, for today's NFL key",
    invalidationAttempts(lines, "seedOddsSnapshot", nflOddsKey),
    1
  );

  // Now the NFL row "exists" (as seedOddsSnapshot just wrote it) with one
  // not-yet-started game - seedNflPropOddsForToday reads it back and
  // enriches it with a prop market.
  const preEnrichment: OddsGame = {
    id: "g1",
    sportKey: NFL,
    homeTeam: "Kansas City Chiefs",
    awayTeam: "Denver Broncos",
    commenceTime: laterToday,
    bookmakers: [{ key: "draftkings", title: "DraftKings", markets: [{ key: "h2h", outcomes: [{ name: "Kansas City Chiefs", price: -150 }] }] }],
  };
  patch("oddsSnapshot.findUnique", async () => ({ data: [preEnrichment] }));
  patch("oddsApiUsageLog.findFirst", async () => ({ creditsUsed: 1000, creditsRemaining: 19000 }));
  patch("oddsApiUsageLog.count", async () => 0);
  patch("oddsApiUsageLog.create", async () => ({}));
  let enrichedWrite: unknown = null;
  patch("oddsSnapshot.update", async ({ data }: { data: { data: OddsGame[] } }) => {
    enrichedWrite = data.data;
    return {};
  });
  stubFetch({
    events: {
      g1: {
        id: "g1",
        bookmakers: [
          { key: "draftkings", title: "DraftKings", markets: [{ key: "player_pass_yds", outcomes: [{ name: "Over", description: "Patrick Mahomes", point: 275.5, price: -115 }] }] },
        ],
      },
    },
  });
  lines = captureConsoleError();
  const propResult = await seedNflPropOddsForToday();
  restoreConsoleError();
  restoreFetch();
  restorePrisma();

  expect("Test A step 2: seedNflPropOddsForToday reports 'seeded' (a real write happened)", propResult.status, "seeded");
  expect(
    "Test A step 2: seedNflPropOddsForToday attempted invalidation exactly once, for the SAME NFL key seedOddsSnapshot used",
    invalidationAttempts(lines, "seedNflPropOddsForToday", nflOddsKey),
    1
  );
  const enrichedGames = enrichedWrite as OddsGame[] | null;
  ok(
    "Test A step 2: the enrichment write actually landed (prop market present in the persisted data)",
    !!enrichedGames?.[0]?.bookmakers.find((b) => b.key === "draftkings")?.markets.some((m) => m.key === "player_pass_yds")
  );

  // =====================================================================
  // 2. Non-writing / no-op paths -> zero invalidation attempts.
  // =====================================================================
  patch("oddsSnapshot.findUnique", async () => ({ data: [] })); // existing row -> "cached", no write
  lines = captureConsoleError();
  const cachedResult = await seedOddsSnapshot(NFL);
  restoreConsoleError();
  restorePrisma();
  expect("No-op: seedOddsSnapshot with an existing row reports 'cached'", cachedResult.status, "cached");
  expect(
    "No-op: seedOddsSnapshot attempts ZERO invalidations when nothing was written",
    invalidationAttempts(lines, "seedOddsSnapshot", nflOddsKey),
    0
  );

  // every cached game already started -> no_games_to_fetch, nothing written
  const pastGame: OddsGame = { ...preEnrichment, id: "gPast", commenceTime: new Date(Date.now() - 3600000).toISOString() };
  patch("oddsSnapshot.findUnique", async () => ({ data: [pastGame] }));
  lines = captureConsoleError();
  const noGamesResult = await seedNflPropOddsForToday();
  restoreConsoleError();
  restorePrisma();
  expect("No-op: seedNflPropOddsForToday with only started games reports 'no_games_to_fetch'", noGamesResult.status, "no_games_to_fetch");
  expect(
    "No-op: seedNflPropOddsForToday attempts ZERO invalidations when nothing was written",
    invalidationAttempts(lines, "seedNflPropOddsForToday", nflOddsKey),
    0
  );

  // =====================================================================
  // 3. backfillOddsForSport - confirms the invalidation added this round is
  //    actually wired into the real function, not just correct in
  //    isolation as a predicate.
  // =====================================================================
  patch("oddsSnapshot.findUnique", async () => ({ data: [] })); // existing base row, currently empty
  patch("oddsApiUsageLog.count", async () => 0);
  patch("oddsApiUsageLog.create", async () => ({}));
  patch("oddsSnapshot.update", async () => ({}));
  stubFetch({
    bulk: [{ id: "gBackfill", sport_key: NFL, home_team: "Kansas City Chiefs", away_team: "Denver Broncos", commence_time: laterToday, bookmakers: [] }],
  });
  lines = captureConsoleError();
  const backfillResult = await backfillOddsForSport(NFL);
  restoreConsoleError();
  restoreFetch();
  restorePrisma();

  expect("backfillOddsForSport reports 'added' (a real write happened)", backfillResult.status, "added");
  expect(
    "backfillOddsForSport attempted invalidation exactly once, for the same dated NFL key",
    invalidationAttempts(lines, "backfillOddsForSport", nflOddsKey),
    1
  );

  // =====================================================================
  // 4. Test B - a consumer reading AFTER all writes have settled sees the
  //    fully-enriched result. Constructs the enriched fixture directly
  //    (no need to run the fetch/enrichment flow to produce it) so this
  //    test stays independent of Test A's sequencing/internals, per the
  //    approved design.
  // =====================================================================
  const enrichedGame: OddsGame = {
    id: "g1",
    sportKey: NFL,
    homeTeam: "Kansas City Chiefs",
    awayTeam: "Denver Broncos",
    commenceTime: laterToday,
    bookmakers: [
      { key: "draftkings", title: "DraftKings", markets: [{ key: "h2h", outcomes: [{ name: "Kansas City Chiefs", price: -150 }] }] },
      { key: "fanduel", title: "FanDuel", markets: [{ key: "player_pass_yds", outcomes: [{ name: "Over", description: "Patrick Mahomes", point: 275.5, price: -115 }] }] },
    ],
  };
  patch("oddsSnapshot.findUnique", async () => ({ data: [enrichedGame] }));
  const resolved = await resolvePropOdds(
    NFL,
    { homeTeam: "Kansas City Chiefs", awayTeam: "Denver Broncos", commenceTime: laterToday },
    { playerName: "Patrick Mahomes", propMarket: "PASS_YDS", side: "Over", point: 275.5 }
  );
  restorePrisma();

  expect("Test B: resolvePropOdds resolves the real price from data that only exists in the enriched snapshot", resolved, -115);

  if (realApiKey === undefined) delete process.env.ODDS_API_KEY;
  else process.env.ODDS_API_KEY = realApiKey;

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
