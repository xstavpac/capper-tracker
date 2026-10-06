// Reads the cached NHL roster (C/LW/RW/D/G) - see prisma/schema.prisma's
// NhlRosterPlayer and scripts/load-nhl-roster.ts, which is what populates it.
// No network call; a plain indexed table read, safe on every recovery pass and
// every NHL prop grade.
import { prisma } from "@/lib/prisma";
import type { RosterPlayer } from "@/server/data/nfl-roster";
import { memoizeWithTtl } from "@/server/data/ttl-memo";

const ROSTER_MEMO_TTL_MS = 60_000;

// Memoized per process for ROSTER_MEMO_TTL_MS: prop grading calls this once per
// pick it cannot find in a box score, so a grade-picks run with N such picks
// used to read the whole table N times, every 15 minutes. One read now serves
// the run (and any page-load grade or import recovery on the same instance).
// The table only changes when scripts/load-nhl-roster.ts is rerun by hand, so
// a minute of staleness is invisible. The array is shared - read-only.
export function getCachedNhlRoster(): Promise<RosterPlayer[]> {
  return memoizeWithTtl(
    "roster:nhl",
    async () => {
      const rows = await prisma.nhlRosterPlayer.findMany();
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
