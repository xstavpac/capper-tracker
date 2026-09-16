// Two-layer cache for Momentum/Pace's historical inputs (team form, recent
// scoring, starting-pitcher/ERA, season baselines - see mlb-momentum-data.ts,
// mlb-pace-data.ts, nfl-momentum-data.ts, nfl-pace-data.ts, and
// mlb-pitcher-history.ts's getHistoricalStartingMatchup). Every one of these
// is resolved against a fixed calendar-day cutoff derived from the game's own
// frozen commenceTime (dayBefore/startOfEasternDay), never from live game
// state - so it cannot change for the entire life of a game, yet was being
// re-derived from Postgres on every ~25s client poll, by every viewer,
// independently (confirmed: ~20MB of byte-identical payload per viewer per
// 3-hour game from Momentum's historical block alone).
//
// Same two-layer shape live-game-state.ts / nfl-live-game-state.ts already
// use for the live win-probability fetch, and for the same reason neither
// layer alone is sufficient:
//   - cachedByTag (unstable_cache) is durable and shared across the whole
//     Vercel deployment - not per-instance memory - so it's what makes a
//     settled result reusable across every server instance and every
//     viewer. But traced directly against Next 14.2.35's own
//     unstable-cache.js: a cache MISS has no in-flight coordination at all -
//     every concurrent caller that observes a miss independently invokes the
//     wrapped function and independently writes its own result. Reproduced
//     live (not just read from source): three concurrent calls through a
//     bare unstable_cache on a cold key each ran the underlying function -
//     it does not collapse a stampede on its own.
//   - memoizeWithTtl is what closes that gap: it shares one in-flight
//     promise across concurrent callers on the SAME warm instance, so a
//     burst of same-key requests landing together (a cache TTL expiring
//     while several viewers are polling, or the first several viewers of a
//     newly-started game) collapses to one query execution instead of N -
//     but it is process-local (a plain module-level Map), so it cannot
//     prove or guarantee dedup across different, concurrently-cold Vercel
//     instances. That case is bounded to a burst at expiry/cold-start
//     moments, not eliminated - there is no mechanism in this codebase (or
//     in unstable_cache itself) that closes it further.
import { memoizeWithTtl } from "@/server/data/ttl-memo";
import { cachedByTag } from "@/server/data/cached";

// One hour: a conservative starting default, not a calibrated value - flag
// for a product decision if a different number is wanted. Every input this
// wraps is fixed for the ENTIRE life of a game (its cutoff is the game's own
// frozen commenceTime, resolved once per game-day, never touched again while
// that game is live), so correctness has no floor shorter than "the rest of
// the game" - an hour only bounds how long a stale read could persist if a
// team's underlying snapshot data were ever corrected retroactively.
export const HISTORICAL_INPUT_CACHE_TTL_SECONDS = 60 * 60;

// `fn` must return the small, already-derived value the caller actually
// needs (e.g. TeamFormInput, PaceBaseline) - never a wide/raw Prisma row set -
// so what sits in the shared Data Cache stays compact. See each call site's
// own comment for why its particular return shape already satisfies this.
export function cachedHistoricalInput<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return memoizeWithTtl(key, () => cachedByTag(key, HISTORICAL_INPUT_CACHE_TTL_SECONDS, fn), {
    ttlMs: HISTORICAL_INPUT_CACHE_TTL_SECONDS * 1000,
  });
}
