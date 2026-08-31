import { unstable_cache } from "next/cache";

// unstable_cache keyed + tagged by one string, with a graceful fallback for
// contexts that have no Next incremental cache (bare scripts, the tsx
// acceptance tests) - there it rejects with an "incrementalCache missing"
// invariant, so we just run `fn` directly. Real traffic (Server Component
// renders, Route Handlers) always has the context and gets the cache.
//
// Invalidate with revalidateTag(key) from the mutation paths; `revalidate`
// is only a backstop.
export function cachedByTag<T>(key: string, revalidateSeconds: number, fn: () => Promise<T>): Promise<T> {
  const run = unstable_cache(fn, [key], { tags: [key], revalidate: revalidateSeconds });
  return run().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("incrementalCache")) return fn();
    throw err;
  });
}
