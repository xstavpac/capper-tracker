import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { easternDateKey } from "@/lib/dates";
import { cachedByTag } from "@/server/data/cached";
import { cacheKeys } from "@/lib/cache-keys";
import { ADMIN_STATUS_CACHE_SECONDS } from "@/lib/admin-thresholds";
import {
  FEED_HEALTH_LEAGUES,
  emptyLeague,
  feedHealth,
  type FeedName,
  type FeedSyncRow,
  type LeagueFeedData,
  type LeagueFeedHealth,
} from "@/lib/feed-health";

// Read side of the ops console's Feed health tab. ONE statement per load,
// aggregated in Postgres; only counts and a few timestamps come back:
//   played   - game_results grouped by league over the last 14 days
//              ((sportKey, gameDate) index), preseason rows excluded
//   posted   - per league, the newest odds snapshot from today or yesterday
//              (ET), its games' commence times counted inside Postgres; the
//              snapshot blob itself never leaves the database
//   syncs    - feed_syncs, at most 14 small rows
// About 2-3 KB back per view. No polling: the tab reads on page load, and the
// header badge / tab dot read the cached count (getFeedHealthCheckCount).

type Played = { sportKey: string; past7: number; past14: number; lastGameAt: string | null };
type Posted = { sportKey: string; fetchDate: string; next7: number; nextGameAt: string | null };
type Sync = { feed: FeedName; sportKey: string; lastSuccessAt: string | null; lastErrorAt: string | null; lastError: string | null };

const LEAGUE_KEYS = FEED_HEALTH_LEAGUES.map((l) => l.key);
const DAY = 86_400_000;

// The statement, exported for the DB-backed test. Every time bound is a
// parameter (now is the caller's), so it is deterministic under test.
export function feedHealthSql(now: Date): Prisma.Sql {
  // game_results.gameDate is timestamp(3) holding UTC: compare against UTC
  // wall times, not timestamptz (the session zone must not matter).
  const wall = (d: Date) => d.toISOString().replace("Z", "");
  const nowIso = now.toISOString();
  const yesterdayKey = easternDateKey(new Date(now.getTime() - DAY));
  const keys = Prisma.join(LEAGUE_KEYS);
  return Prisma.sql`
    SELECT
      (SELECT coalesce(json_agg(p), '[]'::json) FROM (
         SELECT "sportKey",
                count(*) FILTER (WHERE "gameDate" >= ${wall(new Date(now.getTime() - 7 * DAY))}::timestamp)::int AS past7,
                count(*)::int AS past14,
                max("gameDate") AS "lastGameAt"
         FROM game_results
         WHERE "sportKey" IN (${keys})
           AND "gameDate" >= ${wall(new Date(now.getTime() - 14 * DAY))}::timestamp
           AND "gameDate" <= ${wall(now)}::timestamp
           AND NOT "isPreseason"
         GROUP BY "sportKey"
       ) p) AS played,
      (SELECT coalesce(json_agg(u), '[]'::json) FROM (
         SELECT s."sportKey", s."fetchDate",
                count(*) FILTER (WHERE g.ct > ${nowIso}::timestamptz AND g.ct <= ${nowIso}::timestamptz + interval '7 days')::int AS next7,
                min(g.ct) FILTER (WHERE g.ct > ${nowIso}::timestamptz) AS "nextGameAt"
         FROM (
           SELECT DISTINCT ON ("sportKey") "sportKey", "fetchDate", data
           FROM odds_snapshots
           WHERE "sportKey" IN (${keys}) AND "fetchDate" >= ${yesterdayKey}
           ORDER BY "sportKey", "fetchDate" DESC
         ) s
         LEFT JOIN LATERAL (
           SELECT (e->>'commenceTime')::timestamptz AS ct
           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.data) = 'array' THEN s.data ELSE '[]'::jsonb END) e
         ) g ON true
         GROUP BY s."sportKey", s."fetchDate"
       ) u) AS posted,
      (SELECT coalesce(json_agg(f), '[]'::json) FROM (
         SELECT feed, "sportKey", "lastSuccessAt", "lastErrorAt", "lastError" FROM feed_syncs WHERE "sportKey" IN (${keys})
       ) f) AS syncs
  `;
}

// json_agg renders timestamp(3) without a zone; those hold UTC.
const utc = (s: string | null) => (s === null ? null : new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + "Z"));

export function parseFeedHealthRow(row: { played: Played[]; posted: Posted[]; syncs: Sync[] }): LeagueFeedData[] {
  return LEAGUE_KEYS.map((sportKey) => {
    const d = emptyLeague(sportKey);
    const p = row.played.find((x) => x.sportKey === sportKey);
    if (p) Object.assign(d, { past7: p.past7, past14: p.past14, lastGameAt: utc(p.lastGameAt) });
    const u = row.posted.find((x) => x.sportKey === sportKey);
    if (u) Object.assign(d, { next7: u.next7, nextGameAt: utc(u.nextGameAt), postedFetchDate: u.fetchDate });
    for (const s of row.syncs.filter((x) => x.sportKey === sportKey)) {
      const sync: FeedSyncRow = { feed: s.feed, sportKey, lastSuccessAt: utc(s.lastSuccessAt), lastErrorAt: utc(s.lastErrorAt), lastError: s.lastError };
      d.syncs[s.feed] = sync;
    }
    return d;
  });
}

export async function loadFeedHealth(now = new Date()): Promise<LeagueFeedHealth[]> {
  const [row] = await prisma.$queryRaw<{ played: Played[]; posted: Posted[]; syncs: Sync[] }[]>(feedHealthSql(now));
  return feedHealth(parseFeedHealthRow(row), now);
}

// The ⚠ Check feed count and the one-line reason, cached for the admin
// layout's tab dot and the header's Admin badge (one entry shared by every
// admin, ADMIN_STATUS_CACHE_SECONDS) - a page load on a hit costs nothing.
export type FeedHealthSummary = { checkCount: number; leagues: string[]; firstReason: string | null };

export async function loadFeedHealthSummary(): Promise<FeedHealthSummary> {
  const bad = (await loadFeedHealth()).filter((h) => h.status === "check_feed");
  return { checkCount: bad.length, leagues: bad.map((h) => h.label), firstReason: bad[0]?.reasons[0] ?? null };
}

export function getFeedHealthSummary(): Promise<FeedHealthSummary> {
  return cachedByTag(cacheKeys.feedHealth(), ADMIN_STATUS_CACHE_SECONDS, loadFeedHealthSummary);
}
