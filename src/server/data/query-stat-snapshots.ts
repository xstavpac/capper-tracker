import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  DAILY_RETENTION_DAYS,
  PREFILTER_PATTERN,
  TREND_DAYS,
  planSnapshot,
  type Baseline,
  type CurrentStat,
  type DailyRow,
  type SnapshotPlan,
} from "@/lib/query-stat-snapshots";

// Database half of the daily pg_stat_statements snapshot (cron db-stats-snapshot) and
// the trend read behind the DB Monitor page. The delta logic is in
// src/lib/query-stat-snapshots.ts.
//
// Supabase keeps pg_stat_statements in the `extensions` schema (see db-monitor.ts).
// Purely additive: it reads the statistics view and writes its own two tables.

type CurrentRow = { queryid: string; calls: number; rows: number; query: string | null };

// ONE statement: counters for every statement in this database that names a tracked
// table, with the statement text only for queryids that have no baseline yet (a few KB
// each, once per queryid ever). The snapshot's own statements are left out.
async function readCurrent(): Promise<CurrentStat[]> {
  const pattern = `\\m${PREFILTER_PATTERN}\\M`;
  return prisma.$queryRaw<CurrentRow[]>(Prisma.sql`
    SELECT s.queryid::text AS queryid,
           s.calls::float8 AS calls,
           s.rows::float8 AS rows,
           CASE WHEN b.queryid IS NULL THEN s.query END AS query
    FROM extensions.pg_stat_statements s
    LEFT JOIN query_stat_baselines b ON b.queryid = s.queryid::text
    WHERE s.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND s.queryid IS NOT NULL
      AND s.query ~ ${pattern}
      AND s.query NOT LIKE '%query_stat_baselines%'
      AND s.query NOT LIKE '%query_stat_daily%'
  `);
}

async function readBaselines(): Promise<Baseline[]> {
  return prisma.$queryRaw<Baseline[]>(Prisma.sql`
    SELECT queryid, label, calls::float8 AS calls, rows::float8 AS rows FROM query_stat_baselines
  `);
}

export type SnapshotSummary = {
  firstRun: boolean;
  statements: number;
  tracked: number;
  stale: number;
  dailyRows: number;
  resets: number;
};

export function summarizePlan(plan: SnapshotPlan): SnapshotSummary {
  return {
    firstRun: plan.firstRun,
    statements: plan.baselines.length,
    tracked: plan.baselines.filter((b) => b.label !== null).length,
    stale: plan.staleQueryids.length,
    dailyRows: plan.daily.length,
    resets: plan.daily.filter((d) => d.statsReset).length,
  };
}

// Read the counters, subtract the stored baselines, write the day's rows and the new
// baselines. A second run on the same UTC day adds its delta to that day's row.
export async function runQueryStatSnapshot(): Promise<SnapshotSummary> {
  const [current, baselines] = await Promise.all([readCurrent(), readBaselines()]);
  const plan = planSnapshot(current, baselines);

  const b = plan.baselines;
  const d = plan.daily;
  await prisma.$transaction([
    ...(b.length
      ? [
          prisma.$executeRaw`
            INSERT INTO query_stat_baselines (queryid, label, calls, rows, "updatedAt")
            SELECT * FROM unnest(${b.map((x) => x.queryid)}::text[], ${b.map((x) => x.label)}::text[], ${b.map((x) => x.calls)}::float8[]::bigint[], ${b.map((x) => x.rows)}::float8[]::bigint[], ${b.map(() => new Date())}::timestamp[])
            ON CONFLICT (queryid) DO UPDATE SET label = EXCLUDED.label, calls = EXCLUDED.calls, rows = EXCLUDED.rows, "updatedAt" = EXCLUDED."updatedAt"`,
        ]
      : []),
    ...(plan.staleQueryids.length ? [prisma.$executeRaw`DELETE FROM query_stat_baselines WHERE queryid = ANY(${plan.staleQueryids}::text[])`] : []),
    ...(d.length
      ? [
          prisma.$executeRaw`
            INSERT INTO query_stat_daily (id, date, label, calls, rows, "avgRows", "statsReset")
            SELECT gen_random_uuid()::text, (now() AT TIME ZONE 'utc')::date, t.label, t.calls, t.rows, 0, t.reset
            FROM unnest(${d.map((x) => x.label)}::text[], ${d.map((x) => x.calls)}::float8[]::bigint[], ${d.map((x) => x.rows)}::float8[]::bigint[], ${d.map((x) => x.statsReset)}::boolean[]) AS t(label, calls, rows, reset)
            ON CONFLICT (date, label) DO UPDATE SET
              calls = query_stat_daily.calls + EXCLUDED.calls,
              rows = query_stat_daily.rows + EXCLUDED.rows,
              "statsReset" = query_stat_daily."statsReset" OR EXCLUDED."statsReset"`,
          // avgRows follows the summed counters (also on the first insert of the day).
          prisma.$executeRaw`
            UPDATE query_stat_daily SET "avgRows" = CASE WHEN calls > 0 THEN rows::float8 / calls ELSE 0 END
            WHERE date = (now() AT TIME ZONE 'utc')::date`,
        ]
      : []),
    prisma.$executeRaw`DELETE FROM query_stat_daily WHERE date < ((now() AT TIME ZONE 'utc')::date - ${DAILY_RETENTION_DAYS}::int)`,
  ]);
  return summarizePlan(plan);
}

type TrendRow = { date: string; label: string; calls: number; rows: number; avgRows: number; statsReset: boolean };

// The admin page's trend: at most TREND_DAYS x (tracked queries) tiny rows. Returns
// null when the table can't be read (the migration isn't applied on this database).
export async function loadQueryStatTrend(): Promise<DailyRow[] | null> {
  try {
    return await prisma.$queryRaw<TrendRow[]>(Prisma.sql`
      SELECT to_char(date, 'YYYY-MM-DD') AS date, label, calls::float8 AS calls, rows::float8 AS rows, "avgRows", "statsReset"
      FROM query_stat_daily
      WHERE date >= ((now() AT TIME ZONE 'utc')::date - ${TREND_DAYS}::int)
      ORDER BY label, date
    `);
  } catch {
    return null;
  }
}
