// One roster table as roster-load.ts's RosterTable, over a Prisma delegate.
// The four tables have identical columns except the player-id column
// (espnPlayerId, or mlbPlayerId for MLB), so one adapter covers all four. No
// prisma import (roster-tables.ts passes the real delegates in), so the exact
// columns read and written are testable with a fake delegate.
import type { ExistingRosterRow, NewRosterRow, RosterRowData, RosterTable } from "@/server/data/roster-load";

export type RosterIdColumn = "espnPlayerId" | "mlbPlayerId";

type Row = RosterRowData & { id: string; active: boolean } & Record<string, unknown>;

// The calls the adapter makes, typed loosely enough that all four Prisma
// delegates fit (their generated signatures differ only in the id column).
export type RosterDelegate = {
  findMany(args: { select: Record<string, true> }): Promise<Row[]>;
  createMany(args: { data: Record<string, string>[]; skipDuplicates: boolean }): Promise<unknown>;
  update(args: { where: { id: string }; data: RosterRowData & { active: true; removedAt: null } }): Promise<unknown>;
  updateMany(args: { where: { id: { in: string[] } }; data: { active: false; removedAt: Date } }): Promise<unknown>;
};

export function makeRosterTable(delegate: RosterDelegate, idColumn: RosterIdColumn): RosterTable {
  return {
    // Only the columns the diff compares - never createdAt / updatedAt / removedAt.
    readForDiff: async (): Promise<ExistingRosterRow[]> => {
      const rows = await delegate.findMany({
        select: { id: true, [idColumn]: true, fullName: true, firstName: true, lastName: true, team: true, position: true, active: true },
      });
      return rows.map((r) => ({
        id: r.id,
        externalId: r[idColumn] as string,
        fullName: r.fullName,
        firstName: r.firstName,
        lastName: r.lastName,
        team: r.team,
        position: r.position,
        active: r.active,
      }));
    },
    createMany: (rows: NewRosterRow[]) =>
      delegate.createMany({
        data: rows.map(({ externalId, ...data }) => ({ [idColumn]: externalId, ...data })),
        skipDuplicates: true,
      }),
    updateRow: (id, data) => delegate.update({ where: { id }, data: { ...data, active: true, removedAt: null } }),
    // Scoped to exactly the row ids the plan found missing.
    deactivate: (ids, at) => delegate.updateMany({ where: { id: { in: ids } }, data: { active: false, removedAt: at } }),
  };
}
