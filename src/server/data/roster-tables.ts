// The four roster cache tables as roster-load.ts's RosterTable (see
// roster-table-adapter.ts for the columns read and written).
import { prisma } from "@/lib/prisma";
import type { RosterLeague, RosterTable } from "@/server/data/roster-load";
import { makeRosterTable, type RosterDelegate } from "@/server/data/roster-table-adapter";

export function rosterTableFor(league: RosterLeague): RosterTable {
  switch (league) {
    case "NFL":
      return makeRosterTable(prisma.nflRosterPlayer as unknown as RosterDelegate, "espnPlayerId");
    case "NHL":
      return makeRosterTable(prisma.nhlRosterPlayer as unknown as RosterDelegate, "espnPlayerId");
    case "NBA":
      return makeRosterTable(prisma.nbaRosterPlayer as unknown as RosterDelegate, "espnPlayerId");
    case "MLB":
      return makeRosterTable(prisma.mlbRosterPlayer as unknown as RosterDelegate, "mlbPlayerId");
  }
}
