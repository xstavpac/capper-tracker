// Reads the cached NFL roster (QB/RB/WR/TE only) catalog-import recovery
// matches bare player-prop names against - see prisma/schema.prisma's
// NflRosterPlayer model and scripts/load-nfl-roster.ts, which is what
// actually populates this table (a one-time/manually-rerun ESPN fetch, never
// triggered by parsing). This file itself makes no network call and is safe
// to call on every recovery pass - it's a plain indexed table read.
import { prisma } from "@/lib/prisma";
import type { RosterPlayer } from "@/server/data/nfl-roster";
import { memoizeWithTtl } from "@/server/data/ttl-memo";
import { cachedByTag } from "@/server/data/cached";
import { cacheKeys } from "@/lib/cache-keys";

const ROSTER_MEMO_TTL_MS = 60_000;

// Memoized per process for ROSTER_MEMO_TTL_MS: prop grading calls this once per
// pick it cannot find in a box score, so a grade-picks run with N such picks
// used to read the whole table N times, every 15 minutes. One read now serves
// the run (and any page-load grade or import recovery on the same instance).
// The table only changes when scripts/load-nfl-roster.ts is rerun by hand, so
// a minute of staleness is invisible. The array is shared - read-only.
export function getCachedNflRoster(): Promise<RosterPlayer[]> {
  return memoizeWithTtl(
    "roster:nfl",
    async () => {
      const rows = await prisma.nflRosterPlayer.findMany();
      return rows.map((r) => ({
        playerName: r.fullName,
        firstName: r.firstName,
        lastName: r.lastName,
        team: r.team,
        position: r.position,
        externalPlayerId: r.espnPlayerId,
      }));
    },
    { ttlMs: ROSTER_MEMO_TTL_MS }
  );
}

// One hour - long enough for a table
// this slow-moving (a manual/one-time rerun, not a live feed). Wrapped with
// cachedByTag (Next's shared Data Cache, with the bare-script/tsx-test
// fallback that helper already provides) rather than getCachedNflRoster's
// own plain `prisma.findMany` above: this is fetched fresh on every
// bulk-import page load (see get-nfl-roster-names.ts's server action), a much
// higher-traffic path than getCachedNflRoster's own recovery-pass-only
// callers, so an uncached read here would be a real repeated-Postgres-egress
// cost for no benefit - the full name list changes only when
// scripts/load-nfl-roster.ts is manually rerun.
export async function getCachedNflRosterFullNames(): Promise<string[]> {
  return cachedByTag(cacheKeys.nflRosterFullNames(), 60 * 60, async () => {
    const rows = await prisma.nflRosterPlayer.findMany({ select: { fullName: true } });
    return rows.map((r) => r.fullName);
  });
}
