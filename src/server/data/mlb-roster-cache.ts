// Reads the cached MLB 40-man roster - see prisma/schema.prisma's MlbRosterPlayer;
// the daily /api/cron/refresh-rosters job (and scripts/load-mlb-roster.ts by
// hand) populates it. No network call; a plain indexed table read, safe on every
// recovery pass and every MLB prop grade.
import { prisma } from "@/lib/prisma";
import type { RosterPlayer } from "@/server/data/nfl-roster";
import { memoizeWithTtl } from "@/server/data/ttl-memo";
import { buildRosterViews, ROSTER_CACHE_SELECT } from "@/server/data/roster-cache-rows";

const ROSTER_MEMO_TTL_MS = 60_000;

// Memoized per process for ROSTER_MEMO_TTL_MS: prop grading calls this once per
// pick it cannot find in a box score, so a grade-picks run with N such picks
// used to read the whole table N times, every 15 minutes. One read now serves
// the run (and any page-load grade or import recovery on the same instance).
// The table changes at most once a day (the refresh), so a minute of
// staleness is invisible. Both views below come from this one read and are
// the same arrays on every call inside the TTL - read-only.
const readAll = () =>
  memoizeWithTtl(
    "roster:mlb",
    async () => {
      const rows = await prisma.mlbRosterPlayer.findMany({ select: { ...ROSTER_CACHE_SELECT, mlbPlayerId: true } });
      return buildRosterViews(rows, (r) => r.mlbPlayerId);
    },
    { ttlMs: ROSTER_MEMO_TTL_MS }
  );

// Active players only - for import name matching (see roster-cache-rows.ts).
export async function getCachedMlbRoster(): Promise<RosterPlayer[]> {
  return (await readAll()).matching;
}

// Every row, including players a refresh has since marked inactive - for grading.
export async function getCachedMlbGradingRoster(): Promise<RosterPlayer[]> {
  return (await readAll()).grading;
}
