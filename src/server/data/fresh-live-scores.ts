// A score feed read the Parlay Generator may act on: never older than
// LIVE_STATE_MAX_AGE_MS.
//
// Why: getLiveScoresForSport sits on unstable_cache, which (Next 14.2) returns an
// expired entry as is and refreshes it in the background. A refresh that fails is
// swallowed, and a Data Cache write that fails is silent, so a region's entry can
// stay hours old. On 2026-11-24 the 03:09Z generator run read every game of the
// evening as pre-game / early in play although several had been final for 40+ min,
// and kept them in the pool.
//
// Rule: read the shared cache as before. If its rows were read upstream within the
// max age, use them. Otherwise read the feed directly (one bounded request set per
// league, memoized per instance for the max age). If that times out or fails, the
// league's state is UNAVAILABLE: callers then go by time since the scheduled start
// only (game-progress.ts backstops), never by the old rows.
//
// Free feeds only (ESPN / MLB Stats API). No database read, no Odds API call.
import { fetchLiveScoresUncached, getLiveScoresForSport, type ScoreGame } from "@/server/data/odds";
import { memoizeWithTtl } from "@/server/data/ttl-memo";

export const LIVE_STATE_MAX_AGE_MS = 45_000;
export const LIVE_STATE_FETCH_TIMEOUT_MS = 4_000;

// Leagues whose score feed costs nothing to read again (CFL's spends Odds API credits).
export const FREE_SCORE_FEEDS = new Set([
  "americanfootball_nfl",
  "americanfootball_ncaaf",
  "basketball_nba",
  "basketball_wnba",
  "basketball_ncaab",
  "icehockey_nhl",
  "baseball_mlb",
]);

export type LiveFeedRead =
  | { kind: "CACHED"; scores: ScoreGame[] } // the shared cache, read upstream within the max age
  | { kind: "REFETCHED"; scores: ScoreGame[] } // the cache was too old; read again directly
  | { kind: "UNAVAILABLE" }; // too old and the direct read failed or timed out

export type FreshLiveScoreDeps = {
  readCached: (sportKey: string) => Promise<ScoreGame[]>;
  fetchUncached: (sportKey: string) => Promise<ScoreGame[]>;
  maxAgeMs: number;
  timeoutMs: number;
};

const productionDeps: FreshLiveScoreDeps = {
  readCached: getLiveScoresForSport,
  // Memoized for the max age so one build (and its 2-minute reloads across users on this instance)
  // reads a league at most once per window.
  fetchUncached: (sportKey) => memoizeWithTtl("fresh-live-scores:" + sportKey, () => fetchLiveScoresUncached(sportKey), { ttlMs: LIVE_STATE_MAX_AGE_MS }),
  maxAgeMs: LIVE_STATE_MAX_AGE_MS,
  timeoutMs: LIVE_STATE_FETCH_TIMEOUT_MS,
};

// The oldest row's read time, or null when any row has none (an unstamped entry from before this
// change, or no rows at all): unknown age counts as too old.
export function scoresReadAt(scores: ScoreGame[]): number | null {
  if (scores.length === 0) return null;
  let oldest = Infinity;
  for (const s of scores) {
    const t = s.fetchedAt ? Date.parse(s.fetchedAt) : NaN;
    if (!Number.isFinite(t)) return null;
    if (t < oldest) oldest = t;
  }
  return oldest;
}

export function isFreshEnough(scores: ScoreGame[], now: Date, maxAgeMs: number): boolean {
  const at = scoresReadAt(scores);
  return at !== null && now.getTime() - at <= maxAgeMs;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout after " + ms + "ms")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

export async function readFreshLiveScores(sportKey: string, now: Date, deps: FreshLiveScoreDeps = productionDeps): Promise<LiveFeedRead> {
  const cached = await withTimeout(deps.readCached(sportKey), deps.timeoutMs).catch(() => null);
  if (cached && isFreshEnough(cached, now, deps.maxAgeMs)) return { kind: "CACHED", scores: cached };
  if (!FREE_SCORE_FEEDS.has(sportKey)) return { kind: "UNAVAILABLE" };
  // An empty cached list for an out-of-season league costs nothing to re-read (the dispatcher returns [] with no request).
  try {
    const scores = await withTimeout(deps.fetchUncached(sportKey), deps.timeoutMs);
    return { kind: "REFETCHED", scores };
  } catch {
    return { kind: "UNAVAILABLE" };
  }
}
