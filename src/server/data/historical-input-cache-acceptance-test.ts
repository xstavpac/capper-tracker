// Proof for historical-input-cache.ts's two-layer cache, and a direct
// regression guard against the exact bug that took down /api/live/momentum
// and /api/live/pace in production: a Date value silently losing its type
// (becoming a plain string) the moment it crosses an unstable_cache cache
// HIT, because unstable_cache persists cache entries as JSON. Every real
// consumer's `.toISOString()` call on the resulting string then threw
// "fetchedAt.toISOString is not a function" on every request after the
// first cold cache-MISS - confirmed live against production logs.
//
// This file exercises the REAL `unstable_cache` (via next/cache), not the
// "incrementalCache missing" fallback path other acceptance tests are stuck
// with outside a Next request context (see ttl-memo-acceptance-test.ts's own
// header) - a minimal fake `globalThis.__incrementalCache` stands in for
// Next's Data Cache, which is enough to make unstable_cache take its real
// get/set/JSON.stringify-JSON.parse code path instead of throwing. Next's
// own AsyncLocalStorage bootstrap is polyfilled the same way, purely for
// this test process - production code needs neither of these, since Next's
// own runtime already provides both before any app code runs.
//
// Pure: no @/lib/prisma import, no network, no database. Run with:
//   npx tsx src/server/data/historical-input-cache-acceptance-test.ts
import { AsyncLocalStorage } from "node:async_hooks";
(globalThis as unknown as { AsyncLocalStorage: unknown }).AsyncLocalStorage = AsyncLocalStorage;

import type { MlbLiveGameState } from "@/server/data/live-game-state";
import type { NflLiveGameState } from "@/server/data/nfl-live-game-state";

// Compile-time regression guard: if fetchedAt on either live-state contract
// ever reverts to `Date` (the shape that caused the original crash), this
// file fails to typecheck - `tsc --noEmit` is part of this repo's own
// verification step, so that would be caught before this test's own
// assertions even run.
function typeGuardMlbFetchedAtIsString(s: MlbLiveGameState): string {
  return s.fetchedAt;
}
function typeGuardNflFetchedAtIsString(s: NflLiveGameState): string {
  return s.fetchedAt;
}
void typeGuardMlbFetchedAtIsString;
void typeGuardNflFetchedAtIsString;

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

// A minimal stand-in for Next's real incrementalCache - just enough of the
// shape unstable-cache.js actually calls (fetchCacheKey/get/set,
// isOnDemandRevalidate) to make it take its real get-then-set,
// JSON.stringify/JSON.parse code path. Traced directly against
// node_modules/next/dist/server/web/spec-extension/unstable-cache.js
// (Next 14.2.35) to confirm this is the full interface it needs outside a
// Next request context (the `else` branch, "Pages Router or outside render").
function makeFakeIncrementalCache() {
  const store = new Map<string, unknown>();
  return {
    isOnDemandRevalidate: false,
    async fetchCacheKey(key: string) {
      return key;
    },
    async get(key: string) {
      const entry = store.get(key);
      return entry ? { value: entry, isStale: false } : undefined;
    },
    async set(key: string, data: unknown) {
      store.set(key, data);
    },
  };
}

async function main() {
  // Deferred (dynamic) imports, not static ones: next/cache reads
  // globalThis.AsyncLocalStorage at MODULE EVALUATION time, and ES module
  // imports are all resolved before this file's own top-level statements
  // run - so a static `import { unstable_cache } from "next/cache"` above
  // would evaluate next/cache before the polyfill on line 20 ever runs.
  // Deferring via `await import(...)` inside main() guarantees the polyfill
  // is in place first. Verified empirically before writing this file - the
  // static-import ordering does throw "AsyncLocalStorage accessed in
  // runtime where it is not available" otherwise.
  const { unstable_cache } = await import("next/cache");
  const { cachedHistoricalInput } = await import("./historical-input-cache");
  const { __clearTtlMemo } = await import("./ttl-memo");

  // ---- 1. The bug's exact mechanism, reproduced against the real unstable_cache ----
  {
    (globalThis as { __incrementalCache?: unknown }).__incrementalCache = makeFakeIncrementalCache();
    const cached = unstable_cache(async () => ({ fetchedAt: new Date() }), ["regression-date-key"], { revalidate: 3600 });
    const first = await cached();
    const second = await cached();
    check("cache MISS returns a real Date", first.fetchedAt instanceof Date);
    // Cast to unknown before inspecting: the static type says `Date` (that's
    // the whole point being tested - the runtime value silently disagrees
    // with it after a cache hit), so TS's own control-flow narrowing on a
    // `typeof ... === "string"` check against a statically-Date-typed value
    // needs sidestepping to even express the assertion.
    const secondFetchedAt: unknown = second.fetchedAt;
    const secondIsString = typeof secondFetchedAt === "string";
    const secondIsDate = secondFetchedAt instanceof Date;
    check(
      "cache HIT silently turns that Date into a plain string - the exact mechanism that crashed /api/live/momentum and /api/live/pace (fetchedAt.toISOString is not a function) on every request after the first",
      secondIsString && !secondIsDate
    );
  }

  // ---- 2. The fix holds: MlbLiveGameState/NflLiveGameState's actual contract (a string) survives the same round trip unchanged ----
  {
    (globalThis as { __incrementalCache?: unknown }).__incrementalCache = makeFakeIncrementalCache();
    const isoNow = new Date().toISOString();
    const cached = unstable_cache(async () => ({ fetchedAt: isoNow }), ["regression-string-key"], { revalidate: 3600 });
    const first = await cached();
    const second = await cached();
    check("a string-shaped fetchedAt survives a cache MISS unchanged", first.fetchedAt === isoNow);
    check("...and survives a cache HIT unchanged too - no .toISOString() crash is possible on this shape", second.fetchedAt === isoNow);
  }

  // ---- 3. Two-layer dedup: same-instance concurrency, then durable reuse after the process-local layer goes cold ----
  {
    (globalThis as { __incrementalCache?: unknown }).__incrementalCache = makeFakeIncrementalCache();
    __clearTtlMemo();
    let calls = 0;
    // Reused as the SAME function reference across (a) and (b) below, on
    // purpose: unstable_cache derives its cache key partly from the
    // function's own source text (cb.toString()), so a different function
    // literal - even with identical behavior - would compute a different
    // key and defeat this test's premise of reusing (a)'s settled entry.
    const fn = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
      return { v: calls };
    };

    // (a) SAME-INSTANCE concurrent requests for the same uncached key:
    // provable within a single process via memoizeWithTtl's in-flight
    // promise sharing.
    const [a, b, c] = await Promise.all([
      cachedHistoricalInput("dedup-key", fn),
      cachedHistoricalInput("dedup-key", fn),
      cachedHistoricalInput("dedup-key", fn),
    ]);
    check("(a) 3 concurrent same-instance calls for an uncached key -> exactly 1 underlying query execution", calls === 1, `calls=${calls}`);
    check(
      "(a) all 3 concurrent callers receive the same settled value",
      JSON.stringify([a, b, c]) === JSON.stringify([{ v: 1 }, { v: 1 }, { v: 1 }])
    );

    // (b) SUBSEQUENT request after the cache has already settled: clearing
    // ONLY the process-local memo (memoizeWithTtl) simulates a fresh warm
    // instance with no in-flight promise to share, while leaving the fake
    // incrementalCache from (a) in place to stand in for the durable,
    // cross-instance-shared cachedByTag/unstable_cache layer. If this call
    // triggered a new `fn` execution, `calls` would become 2.
    __clearTtlMemo();
    const result = await cachedHistoricalInput("dedup-key", fn);
    check(
      "(b) after the process-local memo is cleared, the same key still reuses the durable cachedByTag/unstable_cache result rather than re-querying",
      calls === 1 && JSON.stringify(result) === JSON.stringify({ v: 1 }),
      `calls=${calls}`
    );
  }

  // (c) SIMULTANEOUS misses across DIFFERENT Vercel instances is deliberately
  // NOT claimed or tested here: memoizeWithTtl is process-local (a
  // module-level Map, per ttl-memo.ts) and this test runs in one process, so
  // it cannot prove or disprove true cross-instance stampede behavior.
  // Traced directly against Next 14.2.35's unstable-cache.js (see
  // historical-input-cache.ts's own header): a cache MISS has no in-flight
  // coordination of its own, so two different, concurrently-cold instances
  // each independently execute the wrapped function. That case is bounded to
  // a burst at cache-miss/expiry moments, not eliminated by anything in this
  // codebase.
  console.log(
    "\nNOTE: (a) and (b) above are proven. Simultaneous cache misses across different Vercel instances remain " +
      "an unproven, bounded-to-a-burst case - see this file's own comment and historical-input-cache.ts's header."
  );

  console.log("\n" + "=".repeat(60));
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("TEST CRASHED:", e);
  process.exit(1);
});
