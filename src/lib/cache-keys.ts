// Centralized cache identifiers. Every cached read and every mutation that
// invalidates it reference the same key from here, so the two sides can
// never drift apart into a silent staleness bug. Used both as
// unstable_cache keys/tags (dashboard) and as process-local memo keys
// (odds, liveScores - see ttl-memo.ts).
export const cacheKeys = {
  dashboard: (userId: string) => `dashboard:${userId}`,
  odds: (sportKey: string) => `odds:${sportKey}`,
  liveScores: (sportKey: string) => `live-scores:${sportKey}`,
} as const;
