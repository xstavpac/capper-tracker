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

// The active players' full names, for the bulk-import parser (get-nfl-roster-names.ts's
// server action, the catalog-import orchestrator). Served from the same memoized,
// day-cached roster read as the two views above - it used to be its own 1 h Data Cache
// entry over `findMany({ where: { active: true } })`, which re-read ~780 rows on every
// expiry (DB Monitor, 2026-11-24: 236 calls since 2026-10-26, the largest roster read).
// The rows change only through the daily refresh-rosters cron, which revalidates
// rosterRows("NFL"); a manual scripts/load-nfl-roster.ts run is picked up by the next
// cron or the 24 h TTL, as for grading.
export async function getCachedNflRosterFullNames(): Promise<string[]> {
  return (await readAll()).matching.map((p) => p.playerName);
}
