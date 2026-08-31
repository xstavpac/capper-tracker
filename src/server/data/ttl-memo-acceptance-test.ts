// Proof for memoizeWithTtl (ttl-memo.ts) - the process-local layer behind
// getLiveScoresForSport and getOddsForSport that stops every /live poll from
// re-hitting an upstream API or re-parsing the odds blob. Run with:
//   npx tsx src/server/data/ttl-memo-acceptance-test.ts
// Exits non-zero if any assertion fails.
//
// unstable_cache (the cross-instance layer over live scores) can't be
// exercised here - it throws "incrementalCache missing" outside a Next
// request context - so this covers the layer that is testable.
import { memoizeWithTtl, resolveTtlSeconds, __clearTtlMemo } from "./ttl-memo";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

// A controllable clock and a fetcher that counts its own calls.
function makeFetcher(prefix = "v") {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    fn: async () => {
      calls += 1;
      return { tag: `${prefix}${calls}` };
    },
  };
}

async function main() {
  const TTL = 1000;

  // ---- repeated calls within the TTL hit the fetcher exactly once ----
  {
    __clearTtlMemo();
    let t = 10_000;
    const now = () => t;
    const f = makeFetcher();

    const a = await memoizeWithTtl("k", f.fn, { ttlMs: TTL, now });
    t += 200;
    const b = await memoizeWithTtl("k", f.fn, { ttlMs: TTL, now });
    t += 700; // still < TTL since first call
    const c = await memoizeWithTtl("k", f.fn, { ttlMs: TTL, now });

    expect("3 calls within TTL -> fetcher invoked once", f.calls, 1);
    expect("all three callers get the same value", [a, b, c], [{ tag: "v1" }, { tag: "v1" }, { tag: "v1" }]);
  }

  // ---- once the TTL elapses, the next call refetches ----
  {
    __clearTtlMemo();
    let t = 0;
    const now = () => t;
    const f = makeFetcher();

    await memoizeWithTtl("k", f.fn, { ttlMs: TTL, now });
    t += TTL - 1;
    await memoizeWithTtl("k", f.fn, { ttlMs: TTL, now });
    expect("just before expiry -> still one call", f.calls, 1);

    t += 2; // now past the TTL
    const fresh = await memoizeWithTtl("k", f.fn, { ttlMs: TTL, now });
    expect("after expiry -> fetcher invoked again", f.calls, 2);
    expect("post-expiry caller gets the new value", fresh, { tag: "v2" });
  }

  // ---- distinct keys (sports) never share an entry ----
  {
    __clearTtlMemo();
    const now = () => 0;
    const mlb = makeFetcher("mlb");
    const nfl = makeFetcher("nfl");

    const a = await memoizeWithTtl("live-scores:baseball_mlb", mlb.fn, { ttlMs: TTL, now });
    const b = await memoizeWithTtl("live-scores:americanfootball_nfl", nfl.fn, { ttlMs: TTL, now });

    expect("mlb fetched once", mlb.calls, 1);
    expect("nfl fetched once", nfl.calls, 1);
    expect("keys don't collide", [a, b], [{ tag: "mlb1" }, { tag: "nfl1" }]);
  }

  // ---- a rejected fetch is evicted, so the next call retries ----
  {
    __clearTtlMemo();
    const now = () => 0;
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls === 1) throw new Error("upstream 503");
      return { tag: "recovered" };
    };

    let threw = false;
    try {
      await memoizeWithTtl("k", flaky, { ttlMs: TTL, now });
    } catch {
      threw = true;
    }
    expect("first call rejects", threw, true);

    const second = await memoizeWithTtl("k", flaky, { ttlMs: TTL, now });
    expect("failure was not cached - second call retried", calls, 2);
    expect("second call succeeds", second, { tag: "recovered" });
  }

  // ---- resolveTtlSeconds: falls back, clamps, and floors ----
  expect("resolveTtlSeconds: missing -> fallback", resolveTtlSeconds(undefined, 15), 15);
  expect("resolveTtlSeconds: garbage -> fallback", resolveTtlSeconds("abc", 60), 60);
  expect("resolveTtlSeconds: zero/negative -> fallback", resolveTtlSeconds("0", 15), 15);
  expect("resolveTtlSeconds: valid -> floored int", resolveTtlSeconds("42.9", 15), 42);
  expect("resolveTtlSeconds: clamped to 300", resolveTtlSeconds("99999", 15), 300);

  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
  if (failures > 0) process.exit(1);
}

main();
