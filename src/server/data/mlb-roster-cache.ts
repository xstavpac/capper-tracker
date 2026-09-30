// Reads the cached MLB 40-man roster - see prisma/schema.prisma's MlbRosterPlayer and
// scripts/load-mlb-roster.ts, which is what populates it. No network call; a plain indexed
// table read, safe on every recovery pass and every MLB prop grade.
import { prisma } from "@/lib/prisma";
import type { RosterPlayer } from "@/server/data/nfl-roster";

export async function getCachedMlbRoster(): Promise<RosterPlayer[]> {
  const rows = await prisma.mlbRosterPlayer.findMany();
  return rows.map((r) => ({
    playerName: r.fullName,
    firstName: r.firstName,
    lastName: r.lastName,
    team: r.team,
    position: r.position,
    externalPlayerId: r.mlbPlayerId,
  }));
}
