import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { easternDateKey, easternDayStart } from "@/lib/dates";
import { LIVE_SPORTS } from "@/server/data/odds";
import { snapshotHealth, type CallsToday, type LatestSnapshot, type LatestUsage, type OddsApiView } from "@/lib/odds-api-status";

// Read side of the ops console's Odds API tab. Never touches
// odds_snapshots.data (the bookmaker blob): only sportKey / fetchDate /
// createdAt.

// The newest usage row: account-wide credits as of the latest call.
// pollTimestamp index, one row.
export const LATEST_USAGE_SQL = Prisma.sql`
  SELECT "sportKey", "pollTimestamp", "creditsUsed", "creditsRemaining", "httpStatus", caller
  FROM odds_api_usage_log
  ORDER BY "pollTimestamp" DESC
  LIMIT 1
`;

// The newest snapshot per sport, off the (sportKey, fetchDate) unique index.
export const LATEST_SNAPSHOTS_SQL = Prisma.sql`
  SELECT DISTINCT ON ("sportKey") "sportKey", "fetchDate", "createdAt"
  FROM odds_snapshots
  ORDER BY "sportKey", "fetchDate" DESC
`;

export const ODDS_SPORT_KEYS = LIVE_SPORTS.map((s) => s.key);

type JsonDate<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] };

export function parseLatestUsage(u: JsonDate<LatestUsage> | null): LatestUsage | null {
  return u ? { ...u, pollTimestamp: new Date(u.pollTimestamp) } : null;
}
export function parseLatestSnapshots(rows: JsonDate<LatestSnapshot>[] | null): LatestSnapshot[] {
  return (rows ?? []).map((r) => ({ ...r, createdAt: new Date(r.createdAt) }));
}

// The page: one statement - latest usage row, today's calls grouped by sport x
// caller x status (ET day, pollTimestamp index), this month's count, and the
// latest snapshot per sport. A few dozen small rows.
export async function loadOddsApiView(now = new Date()): Promise<OddsApiView> {
  const todayKey = easternDateKey(now);
  const todayStart = easternDayStart(todayKey);
  const monthStart = easternDayStart(todayKey.slice(0, 7) + "-01");
  const [row] = await prisma.$queryRaw<
    { latest: JsonDate<LatestUsage> | null; today: CallsToday[] | null; month: number; snapshots: JsonDate<LatestSnapshot>[] | null }[]
  >(Prisma.sql`
    SELECT
      (SELECT row_to_json(u) FROM (${LATEST_USAGE_SQL}) u) AS latest,
      (SELECT json_agg(t ORDER BY t."sportKey", t.caller, t."httpStatus") FROM (
         SELECT "sportKey", caller, "httpStatus", count(*)::int AS calls
         FROM odds_api_usage_log
         WHERE "pollTimestamp" >= ${todayStart}
         GROUP BY "sportKey", caller, "httpStatus"
       ) t) AS today,
      (SELECT count(*)::int FROM odds_api_usage_log WHERE "pollTimestamp" >= ${monthStart}) AS month,
      (SELECT json_agg(s) FROM (${LATEST_SNAPSHOTS_SQL}) s) AS snapshots
  `);
  return {
    now,
    latest: parseLatestUsage(row.latest),
    callsToday: row.today ?? [],
    callsMonth: row.month,
    snapshots: snapshotHealth(ODDS_SPORT_KEYS, parseLatestSnapshots(row.snapshots), now),
  };
}
