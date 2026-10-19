import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { cachedByTag } from "@/server/data/cached";
import { cacheKeys } from "@/lib/cache-keys";
import { ADMIN_STATUS_CACHE_SECONDS, DB_ROW_THRESHOLD_DEFAULT } from "@/lib/admin-thresholds";
import { checkFailedAlert, dbMonitorAlert } from "@/lib/admin-status";
import { buildMonitorView } from "@/lib/db-monitor";
import { CRON_JOBS, cronHealth, cronsAlert, type CronRunRow } from "@/lib/cron-runs";
import { loadDbMonitorSnapshot } from "@/server/data/db-monitor";
import { LATEST_CRON_RUNS_SQL } from "@/server/data/cron-runs";
import { oddsApiAlert, snapshotHealth, type LatestSnapshot, type LatestUsage } from "@/lib/odds-api-status";
import { LATEST_SNAPSHOTS_SQL, LATEST_USAGE_SQL, ODDS_SPORT_KEYS, parseLatestSnapshots, parseLatestUsage } from "@/server/data/odds-api-status";
import type { AdminTabAlerts, AdminTabKey } from "@/lib/admin-tabs";

// The ops console's red dots, for the admin layout, cached for
// ADMIN_STATUS_CACHE_SECONDS in one entry shared by the admins - so a page
// load costs nothing on a hit. On a miss it costs TWO statements:
//   1. the combined status statement below: one scalar subquery per tab
//      (each tab's PR adds its own), a few small rows in all;
//   2. the DB Monitor's own pg_stat_statements statement.
// The tab pages read their own data fresh, so a dot can trail its page by up
// to the cache TTL. A check that throws gets a dot saying so, and doesn't
// take the others down.

type StatusRow = {
  crons: (Omit<CronRunRow, "startedAt" | "endedAt"> & { startedAt: string; endedAt: string | null })[];
  oddsLatest: (Omit<LatestUsage, "pollTimestamp"> & { pollTimestamp: string }) | null;
  oddsSnapshots: (Omit<LatestSnapshot, "createdAt"> & { createdAt: string })[] | null;
};

async function loadStatusRow(): Promise<StatusRow> {
  const [row] = await prisma.$queryRaw<StatusRow[]>(Prisma.sql`
    SELECT
      (SELECT coalesce(json_agg(c), '[]'::json) FROM (${LATEST_CRON_RUNS_SQL}) c) AS crons,
      (SELECT row_to_json(u) FROM (${LATEST_USAGE_SQL}) u) AS "oddsLatest",
      (SELECT json_agg(s) FROM (${LATEST_SNAPSHOTS_SQL}) s) AS "oddsSnapshots"
  `);
  return row;
}

type StatusCheck = { tab: AdminTabKey; run: (status: () => Promise<StatusRow>) => Promise<string | null> };

const CHECKS: StatusCheck[] = [
  {
    // The same one statement the DB Monitor page runs, judged at the default
    // threshold.
    tab: "db-monitor",
    run: async () => {
      const result = await loadDbMonitorSnapshot();
      if (!result.ok) return `pg_stat_statements couldn't be read: ${result.reason}`;
      return dbMonitorAlert(buildMonitorView(result.snapshot, DB_ROW_THRESHOLD_DEFAULT, new Date()));
    },
  },
  {
    tab: "crons",
    run: async (status) => {
      const { crons } = await status();
      const now = new Date();
      return cronsAlert(
        CRON_JOBS.map((job) => {
          const r = crons.find((c) => c.name === job.name);
          const latest = r ? { ...r, startedAt: new Date(r.startedAt), endedAt: r.endedAt ? new Date(r.endedAt) : null } : null;
          return cronHealth(job, latest, now);
        })
      );
    },
  },
  {
    // Credits on the newest usage row; today's snapshot per in-season sport.
    tab: "odds-api",
    run: async (status) => {
      const { oddsLatest, oddsSnapshots } = await status();
      const now = new Date();
      return oddsApiAlert(parseLatestUsage(oddsLatest), snapshotHealth(ODDS_SPORT_KEYS, parseLatestSnapshots(oddsSnapshots), now), now);
    },
  },
];

export async function loadAdminStatus(): Promise<AdminTabAlerts> {
  let statusRow: Promise<StatusRow> | null = null;
  const status = () => (statusRow ??= loadStatusRow());
  const results = await Promise.all(
    CHECKS.map(async (c) => {
      try {
        return [c.tab, await c.run(status)] as const;
      } catch (err) {
        return [c.tab, checkFailedAlert(err)] as const;
      }
    })
  );
  const alerts: AdminTabAlerts = {};
  for (const [tab, reason] of results) if (reason) alerts[tab] = reason;
  return alerts;
}

export function getAdminStatus(): Promise<AdminTabAlerts> {
  return cachedByTag(cacheKeys.adminStatus(), ADMIN_STATUS_CACHE_SECONDS, loadAdminStatus);
}
