// Proof for fetchMergedOddsListing (odds.ts) - run with:
//   npx tsx src/server/data/odds-preseason-merge-acceptance-test.ts
//
// No test framework in this repo (see nhl-live-scores-acceptance-test.ts).
// Stubs global fetch and asserts the multi-key merge that bridges the NFL
// preseason -> regular-season handoff:
//   - one key: plain parse, primaryFailed=false (the ~11-months common path)
//   - two keys, disjoint slates: merged
//   - two keys, overlapping event id: deduped, first key wins
//   - primary (element 0) key fails -> primaryFailed=true (caller must not cache)
//   - a SECONDARY (preseason) key failing alone -> primaryFailed=false, the
//     primary slate is kept (best-effort supplement)
//   - the real bug scenario: regular key has Week 1 games, preseason key is
//     empty -> merged result IS the Week 1 games (before the fix this window
//     fetched only the empty preseason key)
import { fetchMergedOddsListing } from "./odds";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

type OddsApiGame = { id: string; sport_key: string; home_team: string; away_team: string; commence_time: string; bookmakers?: unknown[] };
const game = (id: string, home: string, away: string, key = "americanfootball_nfl"): OddsApiGame => ({
  id,
  sport_key: key,
  home_team: home,
  away_team: away,
  commence_time: "2026-09-13T17:00:00Z",
  bookmakers: [],
});

// Route each stubbed request by the sport key in its URL path.
function stubFetchByKey(routes: Record<string, { ok: boolean; status?: number; body?: unknown; throwErr?: boolean }>) {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes("/sports/" + k + "/odds"));
    const r = key ? routes[key] : undefined;
    if (!r) throw new Error("unexpected fetch: " + url.replace(/apiKey=[^&]+/, "apiKey=REDACTED"));
    if (r.throwErr) throw new Error("simulated network failure");
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      statusText: r.ok ? "OK" : "ERR",
      json: async () => r.body ?? [],
      text: async () => JSON.stringify(r.body ?? {}),
    } as Response;
  }) as typeof fetch;
}

async function main() {
  const realFetch = globalThis.fetch;
  const CTX = { fetchDate: "2026-09-05" };

  try {
    // 1. Single key, success.
    globalThis.fetch = stubFetchByKey({
      americanfootball_nfl: { ok: true, body: [game("a", "Bills", "Jets"), game("b", "Chiefs", "Chargers")] },
    });
    let out = await fetchMergedOddsListing("americanfootball_nfl", ["americanfootball_nfl"], "k", CTX);
    check("single key: parses games", out.games.map((g) => g.id).sort(), ["a", "b"]);
    check("single key: not primaryFailed", out.primaryFailed, false);
    check("single key: OddsGame shape mapped from snake_case", { home: out.games[0].homeTeam, away: out.games[0].awayTeam, sk: out.games[0].sportKey }, { home: "Bills", away: "Jets", sk: "americanfootball_nfl" });

    // 2. Two keys, disjoint slates -> merged.
    globalThis.fetch = stubFetchByKey({
      americanfootball_nfl: { ok: true, body: [game("w1a", "Bills", "Jets")] },
      americanfootball_nfl_preseason: { ok: true, body: [game("psa", "Rams", "Raiders", "americanfootball_nfl_preseason")] },
    });
    out = await fetchMergedOddsListing("americanfootball_nfl", ["americanfootball_nfl", "americanfootball_nfl_preseason"], "k", CTX);
    check("two keys disjoint: both slates merged", out.games.map((g) => g.id).sort(), ["psa", "w1a"]);
    check("two keys disjoint: not primaryFailed", out.primaryFailed, false);

    // 3. Two keys, overlapping id -> deduped, first (primary) wins.
    globalThis.fetch = stubFetchByKey({
      americanfootball_nfl: { ok: true, body: [game("dup", "Bills", "Jets")] },
      americanfootball_nfl_preseason: { ok: true, body: [game("dup", "WRONG", "WRONG", "americanfootball_nfl_preseason")] },
    });
    out = await fetchMergedOddsListing("americanfootball_nfl", ["americanfootball_nfl", "americanfootball_nfl_preseason"], "k", CTX);
    check("overlapping id: deduped to one", out.games.length, 1);
    check("overlapping id: primary key's copy wins", { home: out.games[0].homeTeam }, { home: "Bills" });

    // 4. Primary key fails -> primaryFailed true (caller aborts, no cache).
    globalThis.fetch = stubFetchByKey({
      americanfootball_nfl: { ok: false, status: 429, body: { message: "OUT_OF_USAGE_CREDITS" } },
      americanfootball_nfl_preseason: { ok: true, body: [game("psa", "Rams", "Raiders", "americanfootball_nfl_preseason")] },
    });
    out = await fetchMergedOddsListing("americanfootball_nfl", ["americanfootball_nfl", "americanfootball_nfl_preseason"], "k", CTX);
    check("primary key fails: primaryFailed=true", out.primaryFailed, true);

    // 5. Secondary (preseason) key fails alone -> primary slate kept, not primaryFailed.
    globalThis.fetch = stubFetchByKey({
      americanfootball_nfl: { ok: true, body: [game("w1a", "Bills", "Jets"), game("w1b", "Chiefs", "Chargers")] },
      americanfootball_nfl_preseason: { ok: false, status: 429, body: { message: "rate limit" } },
    });
    out = await fetchMergedOddsListing("americanfootball_nfl", ["americanfootball_nfl", "americanfootball_nfl_preseason"], "k", CTX);
    check("secondary key fails alone: primary slate still returned", out.games.map((g) => g.id).sort(), ["w1a", "w1b"]);
    check("secondary key fails alone: NOT primaryFailed (best-effort supplement)", out.primaryFailed, false);

    // 6. Primary key throws (network-level) -> primaryFailed true.
    globalThis.fetch = stubFetchByKey({
      americanfootball_nfl: { ok: true, throwErr: true },
    });
    out = await fetchMergedOddsListing("americanfootball_nfl", ["americanfootball_nfl"], "k", CTX);
    check("primary key throws: primaryFailed=true, no games", { failed: out.primaryFailed, n: out.games.length }, { failed: true, n: 0 });

    // 7. THE BUG SCENARIO: early September - regular key has Week 1 games,
    // preseason key is empty. Pre-fix, this window fetched only the empty
    // preseason key and the NFL board went blank. Now the merged result is
    // exactly the Week 1 slate.
    globalThis.fetch = stubFetchByKey({
      americanfootball_nfl: { ok: true, body: [game("wk1-1", "Cowboys", "Eagles"), game("wk1-2", "Ravens", "Bengals")] },
      americanfootball_nfl_preseason: { ok: true, body: [] },
    });
    out = await fetchMergedOddsListing("americanfootball_nfl", ["americanfootball_nfl", "americanfootball_nfl_preseason"], "k", CTX);
    check("preseason-gap: Week 1 games come through the regular key", out.games.map((g) => g.id).sort(), ["wk1-1", "wk1-2"]);
    check("preseason-gap: not primaryFailed", out.primaryFailed, false);
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
