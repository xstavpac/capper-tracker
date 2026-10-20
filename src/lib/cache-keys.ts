// Centralized cache identifiers. Every cached read and every mutation that
// invalidates it reference the same key from here, so the two sides can
// never drift apart into a silent staleness bug. Used both as
// unstable_cache keys/tags (dashboard) and as process-local memo keys
// (odds, liveScores - see ttl-memo.ts).
export const cacheKeys = {
  dashboard: (userId: string) => `dashboard:${userId}`,
  // Per-user reads that are invalidated by exactly the mutations the dashboard
  // is (any change to the user's picks or cappers), so they carry their own key
  // and the dashboard(userId) TAG - see docs/cache-invalidation-contract.md.
  // `params` is every input that changes the result, already serialized.
  cappersPage: (userId: string, params: string) => `cappers-page:${userId}:${params}`,
  capperPage: (userId: string, capperId: string, params: string) => `capper-page:${userId}:${capperId}:${params}`,
  cappersWithPickCounts: (userId: string) => `cappers-with-pick-counts:${userId}`,
  // Every feature flag with the users it is switched on for - one entry shared
  // by all users (see feature-flags.ts). Nothing writes flags at request time
  // (they are flipped in SQL), so there is no revalidateTag for it: TTL only.
  featureFlags: () => "feature-flags:all",
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
  // Today's projected board (getBoardOddsForSport, odds.ts) - same projection as
  // yesterdayOdds, its own key, TAGGED with odds(sportKey, fetchDate).
  boardOdds: (sportKey: string, fetchDate: string) => `board-odds:${sportKey}:${fetchDate}`,
  // The "who fetches from the Odds API when today's row is missing" claim (see
  // odds-seed-claim.ts) - with a time bucket appended, the claim entry itself.
  oddsSeedClaim: (sportKey: string, fetchDate: string) => `odds-seed-claim:${sportKey}:${fetchDate}`,
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
  // whole roster's other columns over the wire. Only the roster loader writes
  // the table: the daily refresh-rosters cron revalidates this tag after every
  // committed NFL load, 0 rows written included (rosterCacheTagsToRevalidate,
  // refresh-rosters.ts), which also picks up a manual scripts/load-nfl-roster.ts
  // --commit; until that run, the TTL.
  nflRosterFullNames: () => "nfl-roster-full-names",
  // One league's roster rows (nfl/nhl/nba/mlb-roster-cache.ts readAll), behind
  // both the import name matching and the prop-grading views. Same writers and
  // invalidation as nflRosterFullNames: the cron revalidates a league's tag
  // after every committed load of that league.
  rosterRows: (league: string) => `roster-rows:${league.toLowerCase()}`,
  // Process-local memo key for a sport's id by name (sport-ids.ts). No tag:
  // sports rows are never renamed or deleted, and a miss is never cached.
  sportIdByName: (name: string) => `sport-id:${name}`,
  // The /admin ops console's red-dot summary (server/data/admin-status.ts): one
  // entry shared by the admins, no user data in it. TTL only - the tab pages
  // read fresh, so a dot can trail its page by up to the TTL.
  adminStatus: () => "admin-status",
} as const;
