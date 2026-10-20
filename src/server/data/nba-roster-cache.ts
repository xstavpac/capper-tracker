// Reads the cached NBA roster - see prisma/schema.prisma's NbaRosterPlayer; the
// daily /api/cron/refresh-rosters job (and scripts/load-nba-roster.ts by hand)
// populates it. No network call; a plain indexed table read. The NBA twin of
// nhl-roster-cache.ts.
import { prisma } from "@/lib/prisma";
import type { RosterPlayer } from "@/server/data/nfl-roster";
import { memoizeWithTtl } from "@/server/data/ttl-memo";
import { cachedByTag } from "@/server/data/cached";
import { cacheKeys } from "@/lib/cache-keys";
import { buildRosterViews, ROSTER_CACHE_SELECT } from "@/server/data/roster-cache-rows";

const ROSTER_MEMO_TTL_MS = 60_000;
const ROSTER_ROWS_REVALIDATE_SECONDS = 24 * 60 * 60;

// Memoized per process for ROSTER_MEMO_TTL_MS, same as nhl-roster-cache.ts: one
// read serves a whole grade-picks run or import recovery on the instance. The
// table changes at most once a day (the refresh), so a minute of staleness is
// invisible. Both views below come from this one read and are the same arrays
// on every call inside the TTL - read-only.
// Under the memo, the rows sit in the shared Data Cache for a day - see
// nfl-roster-cache.ts; the cron revalidates the tag after every committed NBA load.
const readAll = () =>
  memoizeWithTtl(
    "roster:nba",
    async () => {
      const rows = await cachedByTag(cacheKeys.rosterRows("NBA"), ROSTER_ROWS_REVALIDATE_SECONDS, () =>
        prisma.nbaRosterPlayer.findMany({ select: { ...ROSTER_CACHE_SELECT, espnPlayerId: true } })
      );
      return buildRosterViews(rows, (r) => r.espnPlayerId);
    },
    { ttlMs: ROSTER_MEMO_TTL_MS }
  );

// Active players only - for import name matching (see roster-cache-rows.ts).
export async function getCachedNbaRoster(): Promise<RosterPlayer[]> {
  return (await readAll()).matching;
}

// Every row, including players a refresh has since marked inactive - for grading.
export async function getCachedNbaGradingRoster(): Promise<RosterPlayer[]> {
  return (await readAll()).grading;
}
