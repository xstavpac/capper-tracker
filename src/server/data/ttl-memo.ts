// A tiny process-local promise cache with a per-key TTL. Two consumers today:
//
//   - getLiveScoresForSport (odds.ts): the INNER layer under an unstable_cache
//     (shared Next.js Data Cache) wrapper. It collapses a burst of same-sport
//     polls hitting one warm instance into a single upstream call, shaves the
//     Data Cache round-trip off repeat hits, and keeps that path working in
//     contexts where unstable_cache throws (bare scripts, the tsx acceptance
//     tests, which have no incremental-cache context).
//
//   - getOddsForSport (odds.ts): the ONLY layer. The odds blob already lives
//     in one indexed OddsSnapshot row, so cross-instance sharing buys little;
//     the cost this removes is re-parsing a 100KB-1MB JSON blob (and the DB
//     round-trip) on every /live render.
//
// unstable_cache itself cannot be unit-tested (it needs a Next request
// context), so this layer is what ttl-memo-acceptance-test.ts exercises.
//
// Worst-case staleness is ~2xTTL for the layered live-scores path (a request
// landing just before the inner entry expires, holding a value the outer
// layer was already about to revalidate); for odds it is just TTL. Both are
// fine for their data and well under the client poll interval.

type Entry<T> = { at: number; value: Promise<T> };
const memo = new Map<string, Entry<unknown>>();

/**
 * Return a cached in-flight/settled promise for `key` if one was started
 * within `ttlMs`, otherwise call `fetcher()`, cache that promise, and return
 * it. A rejected promise is evicted so the next call retries instead of
 * serving a cached failure for the rest of the window.
 *
 * `ttlMs` is required (each caller owns its own window); `now` is injectable
 * so the acceptance test can advance time deterministically.
 */
export function memoizeWithTtl<T>(
  key: string,
  fetcher: () => Promise<T>,
  opts: { ttlMs: number; now?: () => number }
): Promise<T> {
  const { ttlMs } = opts;
  const now = opts.now ?? Date.now;

  const hit = memo.get(key) as Entry<T> | undefined;
  if (hit && now() - hit.at < ttlMs) return hit.value;

  const value = fetcher();
  const entry: Entry<T> = { at: now(), value };
  memo.set(key, entry);
  value.catch(() => {
    if (memo.get(key) === entry) memo.delete(key);
  });
  return value;
}

/**
 * Clamp an env-supplied TTL (seconds) to a sane range, falling back to
 * `fallback` for anything missing or malformed. Shared by the live-scores
 * and odds cache windows.
 */
export function resolveTtlSeconds(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(300, Math.max(1, Math.floor(n)));
}

/** Test-only: drop everything so suites don't leak state into each other. */
export function __clearTtlMemo(): void {
  memo.clear();
}
