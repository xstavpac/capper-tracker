import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { TOP_STATEMENT_LIMIT, type RawSnapshot } from "@/lib/db-monitor";

// Read side of the admin DB Monitor. ONE statement per page load, uncached
// (the stats are the point - a cached copy would be someone else's minute),
// no polling. The interpretation (labels, flags, estimate) is all in
// src/lib/db-monitor.ts.
//
// Supabase installs pg_stat_statements in the `extensions` schema; the app's
// role (postgres, through the transaction pooler) has SELECT on the view and
// EXECUTE on the reset function (grants read from the 2026-09-15 prod dump).
//
// Scope:
//   - this database only (pg_stat_statements is cluster-wide);
//   - "touching public tables" = the text names a public table as a whole
//     word, bare or "public."-qualified, but not as another schema's
//     (auth.users / "auth"."users" are not public.users). One alternation
//     built from pg_tables, so one regex per statement;
//   - totals are over every statement in this database, the list over the
//     public-table ones, top TOP_STATEMENT_LIMIT by rows.
// Returns at most TOP_STATEMENT_LIMIT statement texts - a few KB each.

export type DbMonitorSnapshotResult = { ok: true; snapshot: RawSnapshot } | { ok: false; reason: string };

type Row = {
  statsReset: Date | null;
  dealloc: number | null;
  totalRows: number;
  statementCount: number;
  top: { queryid: string; query: string; calls: number; rows: number; totalExecMs: number }[] | null;
};

export async function loadDbMonitorSnapshot(): Promise<DbMonitorSnapshotResult> {
  try {
    const [row] = await prisma.$queryRaw<Row[]>(Prisma.sql`
      WITH s AS (
        SELECT queryid, query, calls, rows, total_exec_time
        FROM extensions.pg_stat_statements
        WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
      ),
      re AS (
        SELECT '(^|[^.\\w"]|"?public"?\\.)"?(' || string_agg(tablename, '|') || ')"?($|[^\\w"])' AS pattern
        FROM pg_tables WHERE schemaname = 'public'
      ),
      top AS (
        SELECT s.* FROM s, re
        WHERE s.query ~ re.pattern
        ORDER BY s.rows DESC
        LIMIT ${TOP_STATEMENT_LIMIT}
      )
      SELECT
        (SELECT stats_reset FROM extensions.pg_stat_statements_info) AS "statsReset",
        (SELECT dealloc FROM extensions.pg_stat_statements_info)::float8 AS "dealloc",
        (SELECT coalesce(sum(rows), 0) FROM s)::float8 AS "totalRows",
        (SELECT count(*) FROM s)::int AS "statementCount",
        (SELECT jsonb_agg(jsonb_build_object(
            'queryid', queryid::text,
            'query', query,
            'calls', calls::float8,
            'rows', rows::float8,
            'totalExecMs', round(total_exec_time::numeric, 1)::float8
          ) ORDER BY rows DESC) FROM top) AS "top"
    `);
    return {
      ok: true,
      snapshot: {
        statsReset: row.statsReset,
        dealloc: row.dealloc ?? 0,
        totalRows: row.totalRows,
        statementCount: row.statementCount,
        top: row.top ?? [],
      },
    };
  } catch (err) {
    // A database without the extension (local dev, CI) or without the grant:
    // say so on the page instead of a 500.
    return { ok: false, reason: (err instanceof Error ? err.message : String(err)).split("\n").filter(Boolean).pop() ?? "unknown error" };
  }
}

// Every statement's counters, cluster-wide (the function's defaults: all
// users, all databases, all queries) - the same thing Supabase's own Query
// Performance "reset" does. Cast to text because the function returns void
// before extension 1.11 and the reset timestamp from 1.11 on.
export async function resetPgStatStatements(): Promise<void> {
  await prisma.$queryRaw`SELECT extensions.pg_stat_statements_reset()::text AS "resetAt"`;
}
