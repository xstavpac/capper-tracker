import { cachedByTag } from "@/server/data/cached";
import { cacheKeys } from "@/lib/cache-keys";
import { ADMIN_STATUS_CACHE_SECONDS, DB_ROW_THRESHOLD_DEFAULT } from "@/lib/admin-thresholds";
import { checkFailedAlert, dbMonitorAlert } from "@/lib/admin-status";
import { buildMonitorView } from "@/lib/db-monitor";
import { loadDbMonitorSnapshot } from "@/server/data/db-monitor";
import type { AdminTabAlerts, AdminTabKey } from "@/lib/admin-tabs";

// The ops console's red dots, for the admin layout. One small read per tab
// (each tab's PR adds its check here), run together and cached for
// ADMIN_STATUS_CACHE_SECONDS in one entry shared by the admins - so a page
// load costs nothing on a hit, and on a miss only the reads below. The tab
// pages read their own data fresh, so a dot can trail its page by up to the
// cache TTL.
//
// A check that throws gets a dot saying so, and doesn't take the others down.

type StatusCheck = { tab: AdminTabKey; run: () => Promise<string | null> };

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
];

export async function loadAdminStatus(): Promise<AdminTabAlerts> {
  const results = await Promise.all(
    CHECKS.map(async (c) => {
      try {
        return [c.tab, await c.run()] as const;
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
