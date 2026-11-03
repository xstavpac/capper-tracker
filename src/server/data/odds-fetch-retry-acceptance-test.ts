// Proof for the transient-failure retry in fetchMergedOddsListing (odds.ts) - run with:
//   npx tsx src/server/data/odds-fetch-retry-acceptance-test.ts
//
// DB-free: stubs global fetch and captures console.warn/error. The backoff is
// passed as 0 through the function's test seam so the suite does not sleep.
//   - 502 then 200            -> success, exactly 1 retry logged, 2 fetch calls
//   - 502 x3                  -> primaryFailed (outage stays loud), 2 retries logged, 3 calls
//   - 401 / 429 (4xx)         -> primaryFailed, NO retry, 1 call
//   - thrown network error x2 then 200 -> success, 2 retries logged
//   - secondary (preseason) key 502 -> never retried, primary slate kept
//   - default backoff is the documented 1500ms / 2 retries
import { fetchMergedOddsListing, ODDS_FETCH_MAX_RETRIES, ODDS_FETCH_RETRY_BACKOFF_MS } from "./odds";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

const CTX = { fetchDate: "2026-11-02" };
const NO_WAIT = { retryBackoffMs: 0 };

type Step = { status: number } | "throw";
const game = (id: string, key: string) => ({ id, sport_key: key, home_team: "H", away_team: "A", commence_time: "2026-11-03T01:00:00Z", bookmakers: [] });

// Serves each sport key's steps in order; the last step repeats.
function stubFetch(script: Record<string, Step[]>, calls: string[]) {
  const idx: Record<string, number> = {};
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = Object.keys(script).find((k) => url.includes("/sports/" + k + "/odds"));
    if (!key) throw new Error("unexpected fetch");
    calls.push(key);
    const i = idx[key] ?? 0;
    idx[key] = i + 1;
    const step = script[key][Math.min(i, script[key].length - 1)];
    if (step === "throw") throw new Error("simulated network failure");
    const ok = step.status >= 200 && step.status < 300;
    return {
      ok,
      status: step.status,
      statusText: ok ? "OK" : "ERR",
      headers: new Headers({}),
      json: async () => (ok ? [game("g1", key)] : []),
      text: async () => "Internal Server Error",
    } as Response;
  }) as typeof fetch;
}

async function main() {
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  const realError = console.error;
  let warns: string[] = [];
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
  console.error = () => undefined; // the failure logs are expected noise here
  const retryLogs = () => warns.filter((w) => w.includes("upstream fetch retry"));

  try {
    // 1. 502 then 200 -> success with exactly one retry logged.
    let calls: string[] = [];
    warns = [];
    globalThis.fetch = stubFetch({ icehockey_nhl: [{ status: 502 }, { status: 200 }] }, calls);
    let out = await fetchMergedOddsListing("icehockey_nhl", ["icehockey_nhl"], "k", CTX, NO_WAIT);
    check("502 then 200: success (not primaryFailed)", out.primaryFailed, false);
    check("502 then 200: games returned", out.games.map((g) => g.id), ["g1"]);
    check("502 then 200: 2 fetch calls", calls.length, 2);
    check("502 then 200: exactly 1 retry logged", retryLogs().length, 1);
    check("502 then 200: retry log carries sportKey + status", [retryLogs()[0].includes('"sportKey":"icehockey_nhl"'), retryLogs()[0].includes('"status":502')], [true, true]);
    check("502 then 200: httpStatus is the successful response's", out.httpStatus, 200);

    // 2. 502 x3 -> fetch_failed path (primaryFailed), 2 retries, 3 calls.
    calls = [];
    warns = [];
    globalThis.fetch = stubFetch({ icehockey_nhl: [{ status: 502 }] }, calls);
    out = await fetchMergedOddsListing("icehockey_nhl", ["icehockey_nhl"], "k", CTX, NO_WAIT);
    check("502 x3: primaryFailed (outage stays loud)", out.primaryFailed, true);
    check("502 x3: no games", out.games.length, 0);
    check("502 x3: 3 fetch calls (1 + 2 retries)", calls.length, 1 + ODDS_FETCH_MAX_RETRIES);
    check("502 x3: 2 retries logged", retryLogs().length, 2);
    check("502 x3: httpStatus reports the final 502", out.httpStatus, 502);

    // 3. 401 -> no retry.
    calls = [];
    warns = [];
    globalThis.fetch = stubFetch({ icehockey_nhl: [{ status: 401 }] }, calls);
    out = await fetchMergedOddsListing("icehockey_nhl", ["icehockey_nhl"], "k", CTX, NO_WAIT);
    check("401: primaryFailed", out.primaryFailed, true);
    check("401: exactly 1 fetch call, no retry", { calls: calls.length, retries: retryLogs().length }, { calls: 1, retries: 0 });

    // 3b. 429 (rate limit) is also a 4xx -> no retry.
    calls = [];
    warns = [];
    globalThis.fetch = stubFetch({ icehockey_nhl: [{ status: 429 }] }, calls);
    out = await fetchMergedOddsListing("icehockey_nhl", ["icehockey_nhl"], "k", CTX, NO_WAIT);
    check("429: no retry", { failed: out.primaryFailed, calls: calls.length, retries: retryLogs().length }, { failed: true, calls: 1, retries: 0 });

    // 4. Thrown network errors twice, then success.
    calls = [];
    warns = [];
    globalThis.fetch = stubFetch({ basketball_wnba: ["throw", "throw", { status: 200 }] }, calls);
    out = await fetchMergedOddsListing("basketball_wnba", ["basketball_wnba"], "k", CTX, NO_WAIT);
    check("throw x2 then 200: success", { failed: out.primaryFailed, n: out.games.length }, { failed: false, n: 1 });
    check("throw x2 then 200: 2 retries logged with status=threw", { retries: retryLogs().length, threw: retryLogs().every((w) => w.includes('"status":"threw"')) }, { retries: 2, threw: true });

    // 4b. Thrown on every attempt -> primaryFailed.
    calls = [];
    warns = [];
    globalThis.fetch = stubFetch({ basketball_wnba: ["throw"] }, calls);
    out = await fetchMergedOddsListing("basketball_wnba", ["basketball_wnba"], "k", CTX, NO_WAIT);
    check("throw x3: primaryFailed, 3 calls", { failed: out.primaryFailed, calls: calls.length }, { failed: true, calls: 3 });

    // 5. Secondary (preseason) key 502s: never retried, primary slate kept.
    calls = [];
    warns = [];
    globalThis.fetch = stubFetch({ americanfootball_nfl: [{ status: 200 }], americanfootball_nfl_preseason: [{ status: 502 }] }, calls);
    out = await fetchMergedOddsListing("americanfootball_nfl", ["americanfootball_nfl", "americanfootball_nfl_preseason"], "k", CTX, NO_WAIT);
    check("secondary 502: primary slate kept, not primaryFailed", { failed: out.primaryFailed, n: out.games.length }, { failed: false, n: 1 });
    check("secondary 502: preseason key fetched exactly once (no retry)", calls.filter((c) => c === "americanfootball_nfl_preseason").length, 1);
    check("secondary 502: no retry logged", retryLogs().length, 0);

    // 6. Primary 502 then 200 with the secondary key present: retry applies to the primary only.
    calls = [];
    warns = [];
    globalThis.fetch = stubFetch({ americanfootball_nfl: [{ status: 502 }, { status: 200 }], americanfootball_nfl_preseason: [{ status: 200 }] }, calls);
    out = await fetchMergedOddsListing("americanfootball_nfl", ["americanfootball_nfl", "americanfootball_nfl_preseason"], "k", CTX, NO_WAIT);
    check("two keys, primary 502 then 200: success, 1 retry, preseason fetched once", { failed: out.primaryFailed, retries: retryLogs().length, pre: calls.filter((c) => c === "americanfootball_nfl_preseason").length }, { failed: false, retries: 1, pre: 1 });

    // 7. Healthy path is unchanged: one call, no retry logs.
    calls = [];
    warns = [];
    globalThis.fetch = stubFetch({ baseball_mlb: [{ status: 200 }] }, calls);
    out = await fetchMergedOddsListing("baseball_mlb", ["baseball_mlb"], "k", CTX, NO_WAIT);
    check("healthy: 1 call, 0 retries", { calls: calls.length, retries: retryLogs().length }, { calls: 1, retries: 0 });

    // 8. Documented defaults (what refresh-odds / backfill-odds / fresh-odds get).
    check("defaults: 2 retries, 1500ms backoff", { retries: ODDS_FETCH_MAX_RETRIES, backoffMs: ODDS_FETCH_RETRY_BACKOFF_MS }, { retries: 2, backoffMs: 1500 });
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
    console.error = realError;
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
