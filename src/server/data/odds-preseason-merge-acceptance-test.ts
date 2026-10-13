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
//   - the Odds API usage headers (x-requests-remaining / -used / -last) are
//     parsed off the response - including an error response - and returned
//     for the refresh-odds cron to surface as an early-warning signal
import { fetchMergedOddsListing } from "./odds";
import { oddsApiRequestKeys } from "@/lib/sport-seasons";

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

type Route = { ok: boolean; status?: number; body?: unknown; throwErr?: boolean; headers?: Record<string, string> };

// Route each stubbed request by the sport key in its URL path.
function stubFetchByKey(routes: Record<string, Route>) {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes("/sports/" + k + "/odds"));
    const r = key ? routes[key] : undefined;
    if (!r) throw new Error("unexpected fetch: " + url.replace(/apiKey=[^&]+/, "apiKey=REDACTED"));
    if (r.throwErr) throw new Error("simulated network failure");
    const headers = new Headers(r.headers ?? {});
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      statusText: r.ok ? "OK" : "ERR",
      headers,
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

    // 3b. Same two-key merge, but NHL's keys - proves fetchMergedOddsListing
    // has no NFL-specific hardcoding; it merges under "icehockey_nhl" and
    // "icehockey_nhl_preseason" exactly the same way it does for NFL's pair.
    globalThis.fetch = stubFetchByKey({
      icehockey_nhl: { ok: true, body: [game("nhl-reg", "Maple Leafs", "Canadiens", "icehockey_nhl")] },
      icehockey_nhl_preseason: { ok: true, body: [game("nhl-pre", "Rangers", "Islanders", "icehockey_nhl_preseason")] },
    });
    out = await fetchMergedOddsListing("icehockey_nhl", ["icehockey_nhl", "icehockey_nhl_preseason"], "k", CTX);
    check("NHL two keys disjoint: both slates merged", out.games.map((g) => g.id).sort(), ["nhl-pre", "nhl-reg"]);
    check("NHL two keys disjoint: not primaryFailed", out.primaryFailed, false);

    // 3c. NBA across the 10-19 / 10-20 boundary. The request keys are the ones
    // oddsApiRequestKeys really returns for 2026-10-13 (not a hand-written
    // list), and the two slates are shaped like the live ones read that day:
    // the preseason key carries games through 10-19, the regular key already
    // lists opening night (10-20) onward. One event id is on BOTH listings (a
    // game the provider moved between keys) - it must come back once, as the
    // regular key's copy.
    const nbaKeys = oddsApiRequestKeys("basketball_nba", new Date("2026-10-13T16:00:00Z"));
    check("NBA 2026-10-13: request keys are [regular, preseason]", nbaKeys, ["basketball_nba", "basketball_nba_preseason"]);
    const at = (g: OddsApiGame, commence_time: string): OddsApiGame => ({ ...g, commence_time });
    const requested: string[] = [];
    const nbaStub = stubFetchByKey({
      // Listed first: the "/sports/basketball_nba/odds" route must not also
      // claim the preseason URL (it doesn't - the key is followed by "/odds").
      basketball_nba_preseason: {
        ok: true,
        body: [
          at(game("pre-1013", "Orlando Magic", "Cleveland Cavaliers", "basketball_nba_preseason"), "2026-10-13T23:00:00Z"),
          at(game("pre-1019", "Los Angeles Lakers", "Golden State Warriors", "basketball_nba_preseason"), "2026-10-20T02:00:00Z"),
          at(game("moved", "WRONG", "WRONG", "basketball_nba_preseason"), "2026-10-20T19:00:00Z"),
        ],
      },
      basketball_nba: {
        ok: true,
        body: [
          at(game("moved", "Detroit Pistons", "Boston Celtics", "basketball_nba"), "2026-10-20T19:00:00Z"),
          at(game("reg-1020", "New York Knicks", "Philadelphia 76ers", "basketball_nba"), "2026-10-20T23:00:00Z"),
          at(game("reg-1021", "Orlando Magic", "Atlanta Hawks", "basketball_nba"), "2026-10-21T23:10:00Z"),
        ],
      },
    });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(String(input).match(/\/sports\/([^/]+)\/odds/)?.[1] ?? "?");
      return nbaStub(input);
    }) as typeof fetch;
    out = await fetchMergedOddsListing("basketball_nba", nbaKeys, "k", { fetchDate: "2026-10-13" });
    check("NBA boundary: both keys were requested, regular key first", requested, ["basketball_nba", "basketball_nba_preseason"]);
    check("NBA boundary: preseason (through 10-19) and regular (10-20 on) slates merged", out.games.map((g) => g.id).sort(), ["moved", "pre-1013", "pre-1019", "reg-1020", "reg-1021"]);
    check("NBA boundary: no event id appears twice", new Set(out.games.map((g) => g.id)).size, out.games.length);
    check("NBA boundary: the event on both listings is the regular key's copy", out.games.find((g) => g.id === "moved")?.homeTeam, "Detroit Pistons");
    check("NBA boundary: each game keeps the key its listing came from", out.games.map((g) => g.id + ":" + g.sportKey).sort(), [
      "moved:basketball_nba",
      "pre-1013:basketball_nba_preseason",
      "pre-1019:basketball_nba_preseason",
      "reg-1020:basketball_nba",
      "reg-1021:basketball_nba",
    ]);
    check("NBA boundary: not primaryFailed", out.primaryFailed, false);
    // Opening night itself: one key, the regular one.
    check("NBA 2026-10-20: preseason key no longer requested", oddsApiRequestKeys("basketball_nba", new Date("2026-10-20T16:00:00Z")), ["basketball_nba"]);

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

    // 8. Odds API usage headers are parsed off the response and returned for
    // the refresh-odds cron to surface. Freshest (last) response wins.
    globalThis.fetch = stubFetchByKey({
      americanfootball_nfl: {
        ok: true,
        body: [game("a", "Bills", "Jets")],
        headers: { "x-requests-remaining": "41234.5", "x-requests-used": "58765.5", "x-requests-last": "3" },
      },
    });
    out = await fetchMergedOddsListing("americanfootball_nfl", ["americanfootball_nfl"], "k", CTX);
    check("credits: usage headers parsed to numbers", out.credits, { remaining: 41234.5, used: 58765.5, lastCost: 3 });

    // 9. Usage headers are read off an ERROR response too - a plan-exhausted
    // 401 reports remaining: 0, which is exactly what the cron should echo.
    globalThis.fetch = stubFetchByKey({
      americanfootball_nfl: {
        ok: false,
        status: 401,
        body: { message: "OUT_OF_USAGE_CREDITS" },
        headers: { "x-requests-remaining": "0", "x-requests-used": "100000" },
      },
    });
    out = await fetchMergedOddsListing("americanfootball_nfl", ["americanfootball_nfl"], "k", CTX);
    check("credits: read from a 401 error response", { remaining: out.credits?.remaining, failed: out.primaryFailed }, { remaining: 0, failed: true });

    // 10. Missing usage headers -> nulls, never a crash.
    globalThis.fetch = stubFetchByKey({ americanfootball_nfl: { ok: true, body: [] } });
    out = await fetchMergedOddsListing("americanfootball_nfl", ["americanfootball_nfl"], "k", CTX);
    check("credits: absent headers -> all null", out.credits, { remaining: null, used: null, lastCost: null });
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
