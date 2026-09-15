// Centralized cache identifiers. Every cached read and every mutation that
// invalidates it reference the same key from here, so the two sides can
// never drift apart into a silent staleness bug. Used both as
// unstable_cache keys/tags (dashboard) and as process-local memo keys
// (odds, liveScores - see ttl-memo.ts).
export const cacheKeys = {
  dashboard: (userId: string) => `dashboard:${userId}`,
  // Dated: the underlying OddsSnapshot row is itself (sportKey, fetchDate)-
  // scoped (its own Prisma unique constraint), so the cache key matches that
  // grain exactly - a day rollover naturally produces a fresh, never-yet-
  // cached key instead of relying on the TTL to notice the old day's entry
  // is stale. Every write path (odds.ts's seedOddsSnapshot/
  // backfillOddsForSport, nfl-prop-odds.ts's seedNflPropOddsForToday) must
  // pass the SAME fetchDate value it used for its own DB write, not a
  // separately-computed one - see each write path's own comment.
  odds: (sportKey: string, fetchDate: string) => `odds:${sportKey}:${fetchDate}`,
  liveScores: (sportKey: string) => `live-scores:${sportKey}`,
  // Per-GAME live state (win probability, current base/out, current pitcher -
  // see live-game-state.ts), distinct from liveScores above which is one
  // batch call per sport. Keyed by sport + the sport's own game id (MLB:
  // gamePk) so concurrent games never collide in the cache or the ttl-memo.
  liveGameState: (sportKey: string, gameId: string) => `live-game-state:${sportKey}:${gameId}`,
} as const;
