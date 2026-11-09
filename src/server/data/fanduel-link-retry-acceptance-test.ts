// Send to FanDuel's Odds API calls (server/data/fanduel-link.ts): at most fanDuelFetchTuning.maxConcurrent in
// flight per instance, and ONE retry of a call that threw, got a 429 or got a 5xx. A 12-event slip used to fire all
// 12 at once, which is the shape that drew 429s in prod. Upstream is a stubbed fetch; no DB. Run with:
//   node --require ./scripts/server-only-stub.cjs --import tsx src/server/data/fanduel-link-retry-acceptance-test.ts
export {};
process.env.ODDS_API_KEY = "test-key";
// Never write the usage-log rows this exercises to a real database.
delete process.env.DATABASE_URL;

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const good = () => json({ bookmakers: [{ key: "fanduel", markets: [{ key: "h2h", outcomes: [] }] }] });

let script: (call: number, url: string) => Promise<Response> | Response = () => good();
let calls = 0;
let live = 0;
let peak = 0;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const n = ++calls;
  live++;
  peak = Math.max(peak, live);
  try {
    return await script(n, String(input));
  } finally {
    live--;
  }
}) as typeof fetch;
console.log = ((orig) => (...a: unknown[]) => {
  const line = a.map(String).join(" ");
  if (/^(PASS|FAIL|all checks|\d+ check)/.test(line)) orig(line);
})(console.log);
console.warn = () => {};
console.error = () => {};

const reset = () => {
  calls = 0;
  live = 0;
  peak = 0;
};

async function main() {
  const { oddsApiDeps, fanDuelFetchTuning } = await import("@/server/data/fanduel-link");
  fanDuelFetchTuning.retryDelayMs = 0;
  const now = new Date("2026-11-09T12:00:00Z");
  // A fresh event id per case: a good answer is cached for 60 s.
  let id = 0;
  const get = () => oddsApiDeps(now).getEventMarkets("basketball_nba", "ev" + ++id, ["h2h"]);

  reset();
  script = (n) => (n === 1 ? json({}, 429) : good());
  check("429 then 200: recovers", (await get())?.map((m) => m.key), ["h2h"]);
  check("...with exactly one retry", calls, 2);

  reset();
  script = () => json({}, 429);
  check("429 twice: gives up with null (the leg reads Unavailable)", await get(), null);
  check("...after 2 calls, not 3", calls, 2);

  reset();
  script = (n) => (n === 1 ? json({}, 503) : good());
  check("5xx then 200: recovers", (await get())?.length, 1);

  reset();
  script = (n) => {
    if (n === 1) throw new TypeError("fetch failed");
    return good();
  };
  check("a thrown fetch then 200: recovers", (await get())?.length, 1);

  reset();
  script = () => json({}, 404);
  check("404 is not retried", [await get(), calls], [null, 1]);

  reset();
  script = () => good();
  await get();
  check("a clean call is one call", calls, 1);

  // ---- concurrency: a 12-event slip ----
  reset();
  script = async () => {
    await new Promise((r) => setTimeout(r, 15));
    return good();
  };
  const deps = oddsApiDeps(now);
  const all = await Promise.all(Array.from({ length: 12 }, (_, i) => deps.getEventMarkets("basketball_nba", "slip" + i, ["h2h"])));
  check("12 events: every one is answered", all.every((m) => m?.length === 1), true);
  check("...12 calls", calls, 12);
  check("...never more than 4 in flight", peak <= fanDuelFetchTuning.maxConcurrent && peak === 4, true);

  // A 429 on some of them: retries ride inside the same cap, and the others are unaffected.
  reset();
  const seen = new Set<string>();
  script = async (_n, url) => {
    await new Promise((r) => setTimeout(r, 10));
    const first = !seen.has(url);
    seen.add(url);
    return first && /slip2\d?\/odds/.test(url) ? json({}, 429) : good();
  };
  const d2 = oddsApiDeps(now);
  const mixed = await Promise.all(Array.from({ length: 12 }, (_, i) => d2.getEventMarkets("basketball_nba", "mix" + i, ["h2h"])));
  check("12 events, some 429 once: all still answered", mixed.every((m) => m?.length === 1), true);
  check("...never more than 4 in flight", peak <= 4, true);

  if (failures > 0) {
    console.log(failures + " check(s) failed");
    process.exit(1);
  }
  console.log("all checks passed");
  process.exit(0);
}
main();
