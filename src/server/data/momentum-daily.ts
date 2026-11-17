// 7D / 30D Momentum: net units per Eastern game day, ONE grouped query (at most 30 rows back).
// Same day rule as the Net Units tile and the rest of /picks: a pick belongs to the Eastern day of its
// gameTime, and the same WIN_UNITS / loss math as getPicksSummary, so a range's last point equals the
// sum of the tile's daily nets. Nothing here reads pick rows into the app.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { APP_TIME_ZONE, addDaysToDateKey, easternDateRange } from "@/lib/dates";
import { WIN_UNITS } from "@/server/data/capper-list-aggregates";
import { MOMENTUM_RANGE_DAYS, type DailyNet, type MomentumRange } from "@/lib/momentum-daily";

export type MomentumDailyFilters = { capperId?: string; sportId?: string; status?: string };

export async function getMomentumDaily(
  userId: string,
  range: MomentumRange,
  endKey: string,
  f: MomentumDailyFilters = {}
): Promise<DailyNet[]> {
  const startKey = addDaysToDateKey(endKey, -(MOMENTUM_RANGE_DAYS[range] - 1));
  const { start, end } = easternDateRange(startKey, endKey);
  const rows = await prisma.$queryRaw<{ day: string; net: number }[]>(Prisma.sql`
    SELECT
      to_char((p."gameTime" AT TIME ZONE 'UTC' AT TIME ZONE ${APP_TIME_ZONE})::date, 'YYYY-MM-DD') AS day,
      (COALESCE(sum(${WIN_UNITS}) FILTER (WHERE p.status = 'WIN' AND p.odds <> 0), 0)
        - COALESCE(sum(p.units) FILTER (WHERE p.status = 'LOSS'), 0))::float8 AS net
    FROM picks p
    WHERE p."userId" = ${userId}
      AND p."gameTime" >= ${start} AND p."gameTime" < ${end}
      AND p.status IN ('WIN', 'LOSS')
      ${f.capperId ? Prisma.sql`AND p."capperId" = ${f.capperId}` : Prisma.empty}
      ${f.sportId ? Prisma.sql`AND p."sportId" = ${f.sportId}` : Prisma.empty}
      ${f.status ? Prisma.sql`AND p.status = ${f.status}::"PickStatus"` : Prisma.empty}
    GROUP BY 1
    ORDER BY 1
  `);
  return rows.map((r) => ({ day: r.day, net: r.net }));
}
