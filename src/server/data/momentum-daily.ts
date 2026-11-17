// 7D / 30D Momentum: net units per Eastern game day, ONE grouped query (at most 30 rows back).
// Same day rule as the Net Units tile and the rest of /picks: a pick belongs to the Eastern day of its
// gameTime, and the same WIN_UNITS / loss math as getPicksSummary, so a range's last point equals the
// sum of the tile's daily nets. Nothing here reads pick rows into the app.
//
// `unique`: the Unique Picks rule of the Today view (momentum.ts uniqueMomentumEvents), done in Postgres over the
// stored Pick.uniqueKey. Each key is one bet: the most common settled result wins (a tie, or a PUSH winner, moves
// nothing) and the bet moves the day by the AVERAGE units of its winning copies. A key starts with the game's exact
// gameTime, so it never spans two Eastern days (prod check 2026-11-17: 0 keys do) - the range's Unique net is the sum
// of each day's Today-Unique net. A row with no stored key counts as its own bet (prod has none; inserts stamp it).
// The answer is still <= 30 (day, net) rows. momentum-daily-unique-parity-acceptance-test.ts pins it to the TS rule.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { APP_TIME_ZONE, addDaysToDateKey, easternDateRange } from "@/lib/dates";
import { WIN_UNITS } from "@/server/data/capper-list-aggregates";
import { MOMENTUM_RANGE_DAYS, type DailyNet, type MomentumRange } from "@/lib/momentum-daily";

export type MomentumDailyFilters = { capperId?: string; sportId?: string; status?: string };

type Db = Prisma.TransactionClient | typeof prisma;

export async function getMomentumDaily(
  userId: string,
  range: MomentumRange,
  endKey: string,
  f: MomentumDailyFilters = {},
  opts: { unique?: boolean; db?: Db } = {}
): Promise<DailyNet[]> {
  const db = opts.db ?? prisma;
  const startKey = addDaysToDateKey(endKey, -(MOMENTUM_RANGE_DAYS[range] - 1));
  const { start, end } = easternDateRange(startKey, endKey);
  const day = Prisma.sql`to_char((p."gameTime" AT TIME ZONE 'UTC' AT TIME ZONE ${APP_TIME_ZONE})::date, 'YYYY-MM-DD')`;
  const filters = Prisma.sql`
      ${f.capperId ? Prisma.sql`AND p."capperId" = ${f.capperId}` : Prisma.empty}
      ${f.sportId ? Prisma.sql`AND p."sportId" = ${f.sportId}` : Prisma.empty}
      ${f.status ? Prisma.sql`AND p.status = ${f.status}::"PickStatus"` : Prisma.empty}`;

  if (opts.unique) {
    const rows = await db.$queryRaw<{ day: string; net: number }[]>(Prisma.sql`
      WITH by_result AS (
        SELECT
          ${day} AS day,
          COALESCE(p."uniqueKey", p.id) AS k,
          p.status,
          count(*)::float8 AS n,
          COALESCE(sum(CASE WHEN p.status = 'WIN' AND p.odds <> 0 THEN ${WIN_UNITS} WHEN p.status = 'LOSS' THEN -p.units ELSE 0 END), 0)::float8 AS s
        FROM picks p
        WHERE p."userId" = ${userId}
          AND p."gameTime" >= ${start} AND p."gameTime" < ${end}
          AND p.status IN ('WIN', 'LOSS', 'PUSH')
          ${filters}
        GROUP BY 1, 2, 3
      ), ranked AS (
        SELECT day, k, status, n, s, max(n) OVER (PARTITION BY k) AS top FROM by_result
      ), majority AS (
        SELECT day, status, s / n AS d, count(*) OVER (PARTITION BY k) AS tied FROM ranked WHERE n = top
      )
      SELECT day, COALESCE(sum(d) FILTER (WHERE tied = 1 AND status <> 'PUSH'), 0)::float8 AS net
      FROM majority
      GROUP BY 1
      ORDER BY 1
    `);
    return rows.map((r) => ({ day: r.day, net: r.net }));
  }

  const rows = await db.$queryRaw<{ day: string; net: number }[]>(Prisma.sql`
    SELECT
      ${day} AS day,
      (COALESCE(sum(${WIN_UNITS}) FILTER (WHERE p.status = 'WIN' AND p.odds <> 0), 0)
        - COALESCE(sum(p.units) FILTER (WHERE p.status = 'LOSS'), 0))::float8 AS net
    FROM picks p
    WHERE p."userId" = ${userId}
      AND p."gameTime" >= ${start} AND p."gameTime" < ${end}
      AND p.status IN ('WIN', 'LOSS')
      ${filters}
    GROUP BY 1
    ORDER BY 1
  `);
  return rows.map((r) => ({ day: r.day, net: r.net }));
}
