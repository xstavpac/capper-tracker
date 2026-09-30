// Reads the cached NHL roster (C/LW/RW/D/G) - see prisma/schema.prisma's
// NhlRosterPlayer and scripts/load-nhl-roster.ts, which is what populates it.
// No network call; a plain indexed table read, safe on every recovery pass and
// every NHL prop grade.
import { prisma } from "@/lib/prisma";
import type { RosterPlayer } from "@/server/data/nfl-roster";

export async function getCachedNhlRoster(): Promise<RosterPlayer[]> {
  const rows = await prisma.nhlRosterPlayer.findMany();
  return rows.map((r) => ({
    playerName: r.fullName,
    firstName: r.firstName,
    lastName: r.lastName,
    team: r.team,
    position: r.position,
    espnPlayerId: r.espnPlayerId,
  }));
}
