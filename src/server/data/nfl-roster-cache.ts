// Reads the cached NFL roster (QB/RB/WR/TE only) catalog-import recovery
// matches bare player-prop names against - see prisma/schema.prisma's
// NflRosterPlayer model and scripts/load-nfl-roster.ts, which is what
// actually populates this table (a one-time/manually-rerun ESPN fetch, never
// triggered by parsing). This file itself makes no network call and is safe
// to call on every recovery pass - it's a plain indexed table read.
import { prisma } from "@/lib/prisma";
import type { RosterPlayer } from "@/server/data/nfl-roster";
import { cachedByTag } from "@/server/data/cached";
import { cacheKeys } from "@/lib/cache-keys";

export async function getCachedNflRoster(): Promise<RosterPlayer[]> {
  const rows = await prisma.nflRosterPlayer.findMany();
  return rows.map((r) => ({
    playerName: r.fullName,
    firstName: r.firstName,
    lastName: r.lastName,
    team: r.team,
    position: r.position,
    espnPlayerId: r.espnPlayerId,
  }));
}

// One hour, same window as historical-input-cache.ts's
// HISTORICAL_INPUT_CACHE_TTL_SECONDS - the closest precedent for a table
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
