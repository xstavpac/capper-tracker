import { prisma } from "@/lib/prisma";
import { cacheKeys } from "@/lib/cache-keys";
import { cachedByTag } from "@/server/data/cached";
import { memoizeWithTtl, resolveTtlSeconds } from "@/server/data/ttl-memo";
import { persistFinalScores, gradePendingPicks, MAX_GAME_TIME_DRIFT_MS } from "@/server/data/grading";
import { LIVE_SPORTS, RESOLVABLE_SPORT_KEYS } from "@/server/data/odds";

// Page-load grading for /picks and /live/[gameId].
//
// The grade-picks cron (every 15 min) is what grades everyone's picks; this is
// the opportunistic fast path that lets a viewer see a pick graded within
// seconds of its game going final. It used to run unconditionally on every
// view: persistFinalScores upserted every final game in the yesterday..tomorrow
// window for all six sports, then a pending-pick read and a regrade read per
// sport - dozens of serial round trips (the DB connection limit is 1) even for
// a viewer with nothing to grade. Two things bound it now:
//
//   1. Demand gate - a sport is only touched when the viewer has a PENDING
//      pick in it whose game has started (gameTime <= now + the grading
//      matcher's own drift tolerance). One query decides for every sport.
//   2. Persist throttle - persistFinalScores runs at most about once per
//      PAGE_PERSIST_THROTTLE_SECONDS per sport across the whole fleet, no
//      matter how many viewers pass the gate. The viewer's own pending picks
//      are still graded on every gated view, against whatever GameResult rows
//      exist (the throttled persist's, or the cron's).
//
// The cron routes deliberately do NOT use any of this: they keep calling the
// raw persistFinalScores every run. Fuzzy-match regrade is cron-only now - it
// is a correction pass, not time-sensitive (see REGRADE_LOOKBACK_DAYS).

export const PAGE_PERSIST_THROTTLE_SECONDS = resolveTtlSeconds(process.env.PAGE_GRADING_PERSIST_TTL_SECONDS, 45);

export type PageGradingDeps = {
  now: () => number;
  // Cross-instance "who persists this window" claim. Resolves true for the one
  // caller that should run the persist for (sportKey, bucket), false for
  // everyone else in that window.
  claimWindow: (sportKey: string, bucket: number, windowSeconds: number) => Promise<boolean>;
  persist: (sportKey: string) => Promise<unknown>;
  grade: (userId: string, sportName: string, sportKey: string) => Promise<unknown>;
  dueSportNames: (userId: string, now: Date) => Promise<Set<string>>;
};

// Names of the sports in which `userId` has a PENDING pick whose game has
// started, or starts within MAX_GAME_TIME_DRIFT_MS (the tolerance the grading
// matcher itself applies, so a pick whose stored time is a few hours early or
// late still qualifies). One query: the relation filter compiles to a single
// SELECT with an EXISTS subquery, served by the (userId, status) index.
export async function sportNamesWithDuePendingPicks(userId: string, now: Date): Promise<Set<string>> {
  const sports = await prisma.sport.findMany({
    where: {
      picks: {
        some: { userId, status: "PENDING", gameTime: { lte: new Date(now.getTime() + MAX_GAME_TIME_DRIFT_MS) } },
      },
    },
    select: { name: true },
  });
  return new Set(sports.map((s) => s.name));
}

// The window claim is a cached token in the shared Next Data Cache, keyed by
// time bucket - NOT the persist itself wrapped in unstable_cache. Two reasons:
// (1) an expired unstable_cache entry is served stale while its callback
// re-runs in the background, so the persist would land after the grade that
// needed it; a fresh per-bucket key is always a miss, so the claimer awaits
// inline. (2) code inside an unstable_cache callback bypasses the Data Cache
// for everything it calls (the live-scores cache included), so the persist
// would hit the upstream score APIs cold every window. Here the persist runs
// outside the callback, with normal caching.
//
// Costs, accepted: two instances that both miss at the same instant both
// persist (bounded, idempotent); and a persist that fails after claiming
// leaves the window claimed for other instances until it rolls over (the
// claiming instance itself retries - see persistFailedHere below).
// Outside a Next request context (scripts, tsx tests) cachedByTag just runs
// the callback, so every call "wins" and the process-local layer alone throttles.
async function claimWindowViaDataCache(sportKey: string, bucket: number, windowSeconds: number): Promise<boolean> {
  let claimed = false;
  await cachedByTag(
    `${cacheKeys.pageGradingPersist(sportKey)}:${bucket}`,
    windowSeconds,
    async () => {
      claimed = true;
      return true;
    },
    [cacheKeys.pageGradingPersist(sportKey)]
  );
  return claimed;
}

const defaultDeps: PageGradingDeps = {
  now: Date.now,
  claimWindow: claimWindowViaDataCache,
  persist: persistFinalScores,
  grade: gradePendingPicks,
  dueSportNames: sportNamesWithDuePendingPicks,
};

// Sports whose last persist on THIS instance failed after winning the window
// claim. The claim token is already in the shared cache, so a plain retry would
// see "someone else has it" and skip - the owner retries directly instead.
const persistFailedHere = new Set<string>();

// At most ~one persistFinalScores per sport per window, fleet-wide. Layered
// like getLiveScoresForSport: the Data Cache claim (cross-instance) behind a
// process-local memo keyed by sport only (so it stays bounded, and collapses
// concurrent viewers on one instance into one in-flight persist). A rejected
// persist evicts the memo entry and marks the sport for a direct retry, so the
// same instance runs it again on the next view. Worst case between persists is
// just under 2x the window (the memo and the bucket boundary are not aligned).
export function throttledPersistFinalScores(
  sportKey: string,
  deps: PageGradingDeps = defaultDeps,
  windowSeconds: number = PAGE_PERSIST_THROTTLE_SECONDS
): Promise<void> {
  return memoizeWithTtl(
    cacheKeys.pageGradingPersist(sportKey),
    async () => {
      const bucket = Math.floor(deps.now() / (windowSeconds * 1000));
      const retrying = persistFailedHere.delete(sportKey);
      if (retrying || (await deps.claimWindow(sportKey, bucket, windowSeconds))) {
        try {
          await deps.persist(sportKey);
        } catch (err) {
          persistFailedHere.add(sportKey);
          throw err;
        }
      }
    },
    { ttlMs: windowSeconds * 1000, now: deps.now }
  );
}

// Grades the viewer's own due pending picks. Only sports the viewer has a due
// pending pick in do any work; persist and grade are separate best-effort
// steps, so a persist failure (score source down, one bad upsert rejecting the
// batch) never skips grading against GameResult rows that already exist.
export async function gradeUserPagePicks(
  userId: string,
  sportKeys: readonly string[] = RESOLVABLE_SPORT_KEYS,
  deps: PageGradingDeps = defaultDeps,
  windowSeconds: number = PAGE_PERSIST_THROTTLE_SECONDS
): Promise<void> {
  let due: Set<string>;
  try {
    due = await deps.dueSportNames(userId, new Date(deps.now()));
  } catch {
    return; // Best-effort, same as before - don't block the page.
  }
  if (due.size === 0) return;

  await Promise.all(
    sportKeys.map(async (sportKey) => {
      const sportName = LIVE_SPORTS.find((s) => s.key === sportKey)?.label;
      if (!sportName || !due.has(sportName)) return;
      try {
        await throttledPersistFinalScores(sportKey, deps, windowSeconds);
      } catch {
        // Live score sources are best-effort - fall through and grade against what's persisted.
      }
      try {
        await deps.grade(userId, sportName, sportKey);
      } catch {
        // Best-effort.
      }
    })
  );
}
