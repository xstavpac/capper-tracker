// Centralized cache identifiers. Every cached read and every mutation that
// invalidates it reference the same key from here, so the two sides can
// never drift apart into a silent staleness bug. Used both as
// unstable_cache keys/tags (dashboard) and as process-local memo keys
// (odds, liveScores - see ttl-memo.ts).
export const cacheKeys = {
  dashboard: (userId: string) => `dashboard:${userId}`,
  // One /cappers panel at one window for one user (the dropdown fetch, api/cappers/panel).
  cappersPanel: (userId: string, panel: string, window: string) => `cappers-panel:${userId}:${panel}:${window}`,
  // Dated: the underlying OddsSnapshot row is itself (sportKey, fetchDate)-
  // scoped (its own Prisma unique constraint), so the cache key matches that
  // grain exactly - a day rollover naturally produces a fresh, never-yet-
  // cached key instead of relying on the TTL to notice the old day's entry
  // is stale. Every write path (odds.ts's seedOddsSnapshot/
  // backfillOddsForSport, nfl-prop-odds.ts's seedNflPropOddsForToday) must
  // pass the SAME fetchDate value it used for its own DB write, not a
  // separately-computed one - see each write path's own comment.
  odds: (sportKey: string, fetchDate: string) => `odds:${sportKey}:${fetchDate}`,
  // The ticker's slim view of the same (sportKey, fetchDate) snapshot - only
  // id/teams/commenceTime per game, never the bookmaker blob. Its OWN key (so
  // it can't collide with the full-blob entry above) but it is TAGGED with
  // odds(sportKey, fetchDate), which is what every OddsSnapshot write path
  // revalidates - see tickerOddsCacheParams (odds.ts).
  tickerOdds: (sportKey: string, fetchDate: string) => `ticker-odds:${sportKey}:${fetchDate}`,
  // /live's carried-over yesterday board (getYesterdayOddsForSport): the projected
  // games of the (sportKey, fetchDate) snapshot, fetchDate being the ET date BEFORE
  // today. Its own key (it must not collide with the full-blob or ticker entries) but
  // TAGGED with odds(sportKey, fetchDate) - see yesterdayOddsCacheParams (odds.ts).
  yesterdayOdds: (sportKey: string, fetchDate: string) => `yesterday-odds:${sportKey}:${fetchDate}`,
  liveScores: (sportKey: string) => `live-scores:${sportKey}`,
  // Page-load persistFinalScores throttle (see page-grading.ts): the memo key
  // per sport, and - with a time bucket appended - the window-claim entry.
  pageGradingPersist: (sportKey: string) => `page-grading-persist:${sportKey}`,
  // Per-GAME live state (win probability, current base/out, current pitcher -
  // see live-game-state.ts), distinct from liveScores above which is one
  // batch call per sport. Keyed by sport + the sport's own game id (MLB:
  // gamePk) so concurrent games never collide in the cache or the ttl-memo.
  liveGameState: (sportKey: string, gameId: string) => `live-game-state:${sportKey}:${gameId}`,
  // The NflRosterPlayer table's full names only (no team/position/espnId) -
  // what the client-side bulk-import parser fetches to give parseCatalog's
  // findAmbiguousNickname player-prop guard roster data without shipping the
  // whole roster's other columns over the wire. No mutation path writes this
  // table at request time (see scripts/load-nfl-roster.ts's own comment - a
  // manual/one-time rerun, never triggered by parsing), so there's no
  // revalidateTag call for this key; it relies on the TTL alone.
  nflRosterFullNames: () => "nfl-roster-full-names",
} as const;
