import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { revalidateTag } from "next/cache";
import { prisma } from "@/lib/prisma";
import { easternDateKey } from "@/lib/dates";
import { cacheKeys } from "@/lib/cache-keys";
import { cachedByTag } from "@/server/data/cached";
import { recordFeedSyncs, type FeedSyncOutcome } from "@/server/data/feed-syncs";
import {
  SCHEDULE_LEAGUES,
  dedupeById,
  espnEventsToStored,
  espnScheduleUrl,
  mlbScheduleToStored,
  mlbScheduleUrl,
  plannedScheduleDates,
  scheduleSyncOutcome,
  storedToScheduleGames,
  type LeagueSchedulePull,
  type ScheduleFeedGame,
  type ScheduleSource,
  type StoredScheduleGame,
} from "@/lib/schedule-store";

// The 7-day schedule store (schedule_days): once a day, from the refresh-scores
// cron, each in-season league's next 7 Eastern dates (today included) are pulled
// - the ESPN scoreboard one date at a time (its YYYYMMDD-YYYYMMDD range form is
// HTTP 400), the MLB Stats API in one start-end call - and upserted as one compact
// row per (league, date). Days before today are pruned by id in the same run.
//
// Failure is never "no games": a date whose request failed keeps whatever row it
// had, and the league's feed_syncs "schedule" record gets the error (Feed health
// shows it). A date that came back empty is stored empty - that is a real answer.
//
// Reads (getStoredSchedule) go through the shared Data Cache, keyed by league and
// Eastern day and tagged per league; the pull revalidates the tag. About one
// database read per league per day. No polling, no Odds API calls.

// Throws on a network error or a non-OK response (the caller records it).
export type ScheduleFetchJson = (url: string) => Promise<unknown>;

export const defaultScheduleFetchJson: ScheduleFetchJson = async (url) => {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// One league's pull. ESPN: one request per (date, group), a date counts only when
// every group for it came back. MLB: one request for the whole planned range; if
// it fails, every planned date fails.
export async function pullLeagueSchedule(
  sportKey: string,
  source: ScheduleSource,
  now: Date,
  fetchJson: ScheduleFetchJson = defaultScheduleFetchJson,
  planned: string[] = plannedScheduleDates(sportKey, now)
): Promise<LeagueSchedulePull> {
  const pull: LeagueSchedulePull = { sportKey, planned, days: new Map(), failed: [] };
  if (planned.length === 0) return pull;

  if (source.kind === "mlb") {
    try {
      const byDate = mlbScheduleToStored(await fetchJson(mlbScheduleUrl(planned[0], planned[planned.length - 1])), now);
      for (const d of planned) pull.days.set(d, byDate.get(d) ?? []);
    } catch (err) {
      for (const d of planned) pull.failed.push({ date: d, error: "MLB Stats API: " + message(err) });
    }
    return pull;
  }

  const groups = source.groups ?? [undefined];
  await Promise.all(
    planned.map(async (date) => {
      try {
        const lists = await Promise.all(groups.map(async (g) => espnEventsToStored(await fetchJson(espnScheduleUrl(source.path, date, g)), now)));
        pull.days.set(date, dedupeById(lists.flat()));
      } catch (err) {
        pull.failed.push({ date, error: "ESPN: " + message(err) });
      }
    })
  );
  pull.failed.sort((a, b) => a.date.localeCompare(b.date));
  return pull;
}

// timestamp(3) holds UTC: pass the UTC wall time explicitly so the session time
// zone (America/Chicago locally) can't shift it.
const utcWall = (d: Date) => d.toISOString().replace("Z", "");

// One statement per league: every date that came back, upserted.
export function scheduleUpsertSql(sportKey: string, days: Map<string, StoredScheduleGame[]>, fetchedAt: Date): Prisma.Sql | null {
  if (days.size === 0) return null;
  const at = utcWall(fetchedAt);
  const rows = [...days].map(
    ([gameDate, games]) => Prisma.sql`(${randomUUID()}, ${sportKey}, ${gameDate}, ${JSON.stringify(games)}::jsonb, ${at}::timestamp)`
  );
  return Prisma.sql`
    INSERT INTO schedule_days (id, "sportKey", "gameDate", games, "fetchedAt")
    VALUES ${Prisma.join(rows)}
    ON CONFLICT ("sportKey", "gameDate") DO UPDATE SET games = EXCLUDED.games, "fetchedAt" = EXCLUDED."fetchedAt"
  `;
}

// Days before today (Eastern), any league: ids first, then a delete by id only.
export async function pruneScheduleDays(todayKey: string): Promise<number> {
  const old = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM schedule_days WHERE "gameDate" < ${todayKey}`;
  if (old.length === 0) return 0;
  const ids = old.map((r) => r.id);
  return prisma.$executeRaw`DELETE FROM schedule_days WHERE id = ANY(${ids}::text[])`;
}

export type ScheduleRefreshSummary = {
  leagues: { sport: string; planned: number; stored: number; games: number; failed: string[] }[];
  pruned: number;
};

// Test seams; the cron passes none.
export type ScheduleRefreshDeps = {
  fetchJson?: ScheduleFetchJson;
  leagues?: typeof SCHEDULE_LEAGUES;
  planDates?: (sportKey: string, now: Date) => string[];
  invalidate?: (tag: string) => void;
  recordSyncs?: typeof recordFeedSyncs;
};

function safeRevalidate(tag: string) {
  try {
    revalidateTag(tag);
  } catch (err) {
    // No request context (tsx tests, scripts): the TTL backstop covers it.
    console.error("[schedule-store] revalidateTag failed - rows written, cache will catch up on its TTL", JSON.stringify({ tag, error: message(err) }));
  }
}

// The daily step: pull every league, upsert what came back, prune old days,
// invalidate each written league's cache, record feed_syncs "schedule".
export async function refreshScheduleStore(now = new Date(), deps: ScheduleRefreshDeps = {}): Promise<ScheduleRefreshSummary> {
  const fetchJson = deps.fetchJson ?? defaultScheduleFetchJson;
  const invalidate = deps.invalidate ?? safeRevalidate;
  const planDates = deps.planDates ?? plannedScheduleDates;
  const pulls = await Promise.all(
    (deps.leagues ?? SCHEDULE_LEAGUES).map((l) => pullLeagueSchedule(l.sportKey, l.source, now, fetchJson, planDates(l.sportKey, now)))
  );

  const outcomes: FeedSyncOutcome[] = [];
  const leagues: ScheduleRefreshSummary["leagues"] = [];
  for (const pull of pulls) {
    let outcome = scheduleSyncOutcome(pull);
    const sql = scheduleUpsertSql(pull.sportKey, pull.days, now);
    if (sql) {
      try {
        await prisma.$executeRaw(sql);
        invalidate(cacheKeys.scheduleTag(pull.sportKey));
      } catch (err) {
        outcome = { sportKey: pull.sportKey, ok: false, error: "schedule store write failed: " + message(err) };
      }
    }
    if (outcome) outcomes.push(outcome);
    leagues.push({
      sport: pull.sportKey,
      planned: pull.planned.length,
      stored: pull.days.size,
      games: [...pull.days.values()].reduce((n, g) => n + g.length, 0),
      failed: pull.failed.map((f) => f.date),
    });
  }
  const pruned = await pruneScheduleDays(easternDateKey(now));
  await (deps.recordSyncs ?? recordFeedSyncs)("schedule", outcomes, now);
  return { leagues, pruned };
}

// Reads ------------------------------------------------------------------------

export type StoredScheduleRow = { gameDate: string; games: StoredScheduleGame[] };

// TTL is only the backstop (the pull revalidates the league's tag); the key
// carries the Eastern day, so a new day is a new entry. A day's entry is read at
// most twice: once before the 06:55 UTC pull, once after its revalidateTag.
export const SCHEDULE_CACHE_TTL_SECONDS = 24 * 3600;

export async function loadStoredSchedule(sportKey: string, todayKey: string): Promise<StoredScheduleRow[]> {
  return prisma.$queryRaw<StoredScheduleRow[]>`
    SELECT "gameDate", games FROM schedule_days
    WHERE "sportKey" = ${sportKey} AND "gameDate" >= ${todayKey}
    ORDER BY "gameDate"`;
}

// Today..today+6 for one league, as stored. One shared Data Cache entry per
// (league, Eastern day): every caller on every instance shares the read.
// `load` is a test seam.
export function getStoredSchedule(sportKey: string, now = new Date(), load = loadStoredSchedule): Promise<StoredScheduleRow[]> {
  const todayKey = easternDateKey(now);
  return cachedByTag(cacheKeys.schedule(sportKey, todayKey), SCHEDULE_CACHE_TTL_SECONDS, () => load(sportKey, todayKey), [
    cacheKeys.scheduleTag(sportKey),
  ]);
}

// The stored games past the score feed's window (today+2..today+6), as
// schedule-only previews for the import / tiebreaker / token-day resolvers.
export async function getUpcomingScheduleGames(sportKey: string, now = new Date()): Promise<ScheduleFeedGame[]> {
  return storedToScheduleGames(await getStoredSchedule(sportKey, now), now);
}
