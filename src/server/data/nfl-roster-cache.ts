// Reads the cached NFL roster (QB/RB/WR/TE only) catalog-import recovery
// matches bare player-prop names against - see prisma/schema.prisma's
// NflRosterPlayer model. The daily /api/cron/refresh-rosters job (and
// scripts/load-nfl-roster.ts by hand) populates it; parsing never triggers a
// fetch. This file itself makes no network call and is safe to call on every
// recovery pass - it's a plain indexed table read.
import { prisma } from "@/lib/prisma";
import type { RosterPlayer } from "@/server/data/nfl-roster";
import { memoizeWithTtl } from "@/server/data/ttl-memo";
import { cachedByTag } from "@/server/data/cached";
import { cacheKeys } from "@/lib/cache-keys";
import { buildRosterViews, ROSTER_CACHE_SELECT } from "@/server/data/roster-cache-rows";

const ROSTER_MEMO_TTL_MS = 60_000;
const ROSTER_ROWS_REVALIDATE_SECONDS = 24 * 60 * 60;

// Memoized per process for ROSTER_MEMO_TTL_MS: prop grading calls this once per
// pick it cannot find in a box score, so a grade-picks run with N such picks
// used to read the whole table N times, every 15 minutes. One read now serves
// the run (and any page-load grade or import recovery on the same instance).
// The table changes at most once a day (the refresh), so a minute of
// staleness is invisible. Both views below come from this one read and are
// the same arrays on every call inside the TTL - read-only.
//
// Under the memo, the rows themselves sit in the shared Data Cache for a day:
// most grade runs land on a cold or different instance, where the memo alone
// meant one whole-table read per run. The refresh-rosters cron revalidates the
// tag after every committed NFL load (rosterCacheTagsToRevalidate, refresh-rosters.ts).
const readAll = () =>
  memoizeWithTtl(
    "roster:nfl",
    async () => {
      const rows = await cachedByTag(cacheKeys.rosterRows("NFL"), ROSTER_ROWS_REVALIDATE_SECONDS, () =>
        prisma.nflRosterPlayer.findMany({ select: { ...ROSTER_CACHE_SELECT, espnPlayerId: true } })
      );
      return buildRosterViews(rows, (r) => r.espnPlayerId);
    },
    { ttlMs: ROSTER_MEMO_TTL_MS }
  );

// Active players only - for import name matching (see roster-cache-rows.ts).
export async function getCachedNflRoster(): Promise<RosterPlayer[]> {
  return (await readAll()).matching;
}

// Every row, including players a refresh has since marked inactive - for grading.
export async function getCachedNflGradingRoster(): Promise<RosterPlayer[]> {
  return (await readAll()).grading;
}

// One hour - long enough for a table this slow-moving. Wrapped with
// cachedByTag (Next's shared Data Cache, with the bare-script/tsx-test
// fallback that helper already provides) rather than the memoized read above:
// this is fetched fresh on every bulk-import page load (see
// get-nfl-roster-names.ts's server action), a much higher-traffic path than
// the recovery and grading callers, so an uncached read here would be a real
// repeated-Postgres-egress cost for no benefit. Active players only - it feeds
// import name matching. The refresh cron revalidates this tag after every
// committed NFL load; a manual scripts/load-nfl-roster.ts run is picked up by
// the next of that run or the one-hour TTL.
export async function getCachedNflRosterFullNames(): Promise<string[]> {
  return cachedByTag(cacheKeys.nflRosterFullNames(), 60 * 60, async () => {
    const rows = await prisma.nflRosterPlayer.findMany({ where: { active: true }, select: { fullName: true } });
    return rows.map((r) => r.fullName);
  });
}
