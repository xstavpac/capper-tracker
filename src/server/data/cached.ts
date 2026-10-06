import { unstable_cache } from "next/cache";

// unstable_cache keyed + tagged by one string, with a graceful fallback for
// contexts that have no Next incremental cache (bare scripts, the tsx
// acceptance tests) - there it rejects with an "incrementalCache missing"
// invariant, so we just run `fn` directly. Real traffic (Server Component
// renders, Route Handlers) always has the context and gets the cache.
//
// Invalidate with revalidateTag(key) from the mutation paths; `revalidate`
// is only a backstop.
//
// `key` is the cache identity (Next keys on the callback's source text plus
// this string, and a callback closing over different variables has identical
// source text, so anything that varies the result must be in `key`). `tags`
// defaults to [key]; pass it when several differently-keyed entries must be
// invalidated by one existing tag.
//
// Single-flight: concurrent calls for the same `key` on one instance share one
// in-flight promise. unstable_cache does not collapse concurrent misses on its
// own - N callers that all find the entry cold each run `fn`, i.e. N identical
// DB reads (a 175-line catalog import read one OddsSnapshot row 137 times this
// way). The entry is dropped the moment the promise settles, fulfilled or
// rejected, so this adds no TTL of its own: errors are never cached, and a read
// that starts after a revalidateTag still goes to the (now invalidated) Data
// Cache. Per instance only - two instances missing at once still read twice.
//
// Two consequences for callers: joiners get the SAME object the first caller
// gets (treat every result as read-only - see cached-single-flight-acceptance-
// test.ts), and a joiner's own `fn` does not run (page-grading.ts's window claim
// relies on exactly that: only the caller whose callback ran has the claim).
const inFlight = new Map<string, Promise<unknown>>();

export function cachedByTag<T>(key: string, revalidateSeconds: number, fn: () => Promise<T>, tags: string[] = [key]): Promise<T> {
  const pending = inFlight.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  const run = unstable_cache(fn, [key], { tags, revalidate: revalidateSeconds });
  const promise = run()
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("incrementalCache")) return fn();
      throw err;
    })
    .finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}
