// Reads the cached NBA roster - see prisma/schema.prisma's NbaRosterPlayer and
// scripts/load-nba-roster.ts, which is what populates it. No network call; a
// plain indexed table read. The NBA twin of nhl-roster-cache.ts.
import { prisma } from "@/lib/prisma";
import type { RosterPlayer } from "@/server/data/nfl-roster";
import { memoizeWithTtl } from "@/server/data/ttl-memo";

const ROSTER_MEMO_TTL_MS = 60_000;

// Memoized per process for ROSTER_MEMO_TTL_MS, same as getCachedNhlRoster: one
// read serves a whole grade-picks run or import recovery on the instance. The
// table only changes when scripts/load-nba-roster.ts is rerun by hand, so a
// minute of staleness is invisible. The array is shared - read-only.
export function getCachedNbaRoster(): Promise<RosterPlayer[]> {
  return memoizeWithTtl(
    "roster:nba",
    async () => {
      const rows = await prisma.nbaRosterPlayer.findMany();
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
