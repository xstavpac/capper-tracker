// Reads the cached NFL roster (QB/RB/WR/TE only) catalog-import recovery
// matches bare player-prop names against - see prisma/schema.prisma's
// NflRosterPlayer model and scripts/load-nfl-roster.ts, which is what
// actually populates this table (a one-time/manually-rerun ESPN fetch, never
// triggered by parsing). This file itself makes no network call and is safe
// to call on every recovery pass - it's a plain indexed table read.
import { prisma } from "@/lib/prisma";
import type { RosterPlayer } from "@/server/data/nfl-roster";

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
