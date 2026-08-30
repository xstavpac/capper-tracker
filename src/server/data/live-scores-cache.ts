// Two-layer caching for live scores, sitting in front of the ESPN / MLB Stats
// score fetches (see getLiveScoresForSport in odds.ts). The point is upstream
// protection: those endpoints are polled every LIVE_POLL_INTERVAL_MS by every
// open /live tab, and the request rate scales with concurrent users. Without
// a cache, 50k users hammering /live would send tens of requests per second
// to ESPN and get the app IP-blocked. With it, upstream is hit at most once
// per sport per TTL regardless of how many users are watching.
//
//   outer layer (in odds.ts) - unstable_cache, backed by the Next.js Data
//     Cache. On Vercel that cache is shared across every serverless instance
//     and region, so one fetch serves all instances for the TTL window.
//
//   inner layer (memoizeWithTtl, here) - a process-local promise cache. It
//     collapses a burst of same-sport polls hitting one warm instance into a
//     single call, shaves the Data Cache round-trip off repeat hits, and -
//     importantly - keeps this module working in contexts where
//     unstable_cache throws (bare scripts, the tsx acceptance tests, which
//     have no incremental-cache context). It is also the layer that is
//     directly unit-tested, since unstable_cache cannot be.
//
// Worst case a value is served ~2xTTL stale (a request landing just before
// the inner entry expires, holding a value the outer layer was already about
// to revalidate). At the 15s default that's a ~30s ceiling against a 15s
// steady state - fine for a glanced-at scoreboard, and the client re-polls
// every 25s regardless.

export const LIVE_SCORES_TTL_SECONDS = clampTtl(Number(process.env.LIVE_SCORES_TTL_SECONDS));

function clampTtl(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 15;
  // Keep it sane - never longer than a minute, never sub-second.
  return Math.min(60, Math.max(1, Math.floor(raw)));
}

type Entry<T> = { at: number; value: Promise<T> };
const memo = new Map<string, Entry<unknown>>();

/**
 * Return a cached in-flight/settled promise for `key` if one was started
 * within `ttlMs`, otherwise call `fetcher()`, cache that promise, and return
 * it. A rejected promise is evicted so the next call retries instead of
 * serving a cached failure for the rest of the window.
 *
 * `now` is injectable so the acceptance test can advance time deterministically.
 */
export function memoizeWithTtl<T>(
  key: string,
  fetcher: () => Promise<T>,
  opts: { ttlMs?: number; now?: () => number } = {}
): Promise<T> {
  const ttlMs = opts.ttlMs ?? LIVE_SCORES_TTL_SECONDS * 1000;
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

/** Test-only: drop everything so suites don't leak state into each other. */
export function __clearLiveScoresMemo(): void {
  memo.clear();
}
