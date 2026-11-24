import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { FeedName } from "@/lib/feed-health";
import type { BackfillStatus, OddsFetchStatus } from "@/lib/odds-cron-status";

// Write side of feed_syncs (the Feed health tab's "last sync" columns): one
// upsert statement per cron run, covering every league the run touched. A
// success only moves lastSuccessAt; an error only moves lastErrorAt/lastError,
// so the row keeps both the last good run and the last failure.
//
// Best-effort like cron_runs logging: a failed write is logged and swallowed,
// never allowed to fail the cron that called it.

export type FeedSyncOutcome = { sportKey: string; ok: true } | { sportKey: string; ok: false; error: string };

const MAX_ERROR_LENGTH = 300;

export function feedSyncUpsertSql(feed: FeedName, outcomes: FeedSyncOutcome[], atDate: Date): Prisma.Sql {
  // ::timestamp params: the column is timestamp(3) holding UTC; pass the UTC
  // wall time explicitly so the session time zone can't shift it.
  const at = utcWall(atDate);
  const rows = outcomes.map((o) =>
    o.ok
      ? Prisma.sql`(${feed}, ${o.sportKey}, ${at}::timestamp, NULL::timestamp, NULL::text, ${at}::timestamp)`
      : Prisma.sql`(${feed}, ${o.sportKey}, NULL::timestamp, ${at}::timestamp, ${o.error.slice(0, MAX_ERROR_LENGTH)}, ${at}::timestamp)`
  );
  return Prisma.sql`
    INSERT INTO feed_syncs (feed, "sportKey", "lastSuccessAt", "lastErrorAt", "lastError", "updatedAt")
    VALUES ${Prisma.join(rows)}
    ON CONFLICT (feed, "sportKey") DO UPDATE SET
      "lastSuccessAt" = COALESCE(EXCLUDED."lastSuccessAt", feed_syncs."lastSuccessAt"),
      "lastErrorAt" = COALESCE(EXCLUDED."lastErrorAt", feed_syncs."lastErrorAt"),
      "lastError" = CASE WHEN EXCLUDED."lastErrorAt" IS NOT NULL THEN EXCLUDED."lastError" ELSE feed_syncs."lastError" END,
      "updatedAt" = EXCLUDED."updatedAt"
  `;
}

export async function recordFeedSyncs(feed: FeedName, outcomes: FeedSyncOutcome[], at = new Date()): Promise<void> {
  if (outcomes.length === 0) return;
  try {
    await prisma.$executeRaw(feedSyncUpsertSql(feed, outcomes, at));
  } catch (err) {
    console.error("[feed-syncs] couldn't record " + feed + " syncs", err instanceof Error ? err.message : String(err));
  }
}

// Runs a cron's per-league work and records whatever outcomes it collected in
// one statement afterwards - also when the work throws (one sport's throw
// rejects the cron's Promise.all; the leagues already done are still
// recorded, and the throw carries on unchanged).
export async function withFeedSyncs<T>(feed: FeedName, run: (outcomes: FeedSyncOutcome[]) => Promise<T>): Promise<T> {
  const outcomes: FeedSyncOutcome[] = [];
  try {
    return await run(outcomes);
  } finally {
    await recordFeedSyncs(feed, outcomes);
  }
}

// One league's score-feed pull (persistFinalScores), tracked: success when it
// returns, an error (then rethrown) when it throws. A season-gated league
// that fetched nothing (scoreFeedFetches false) records nothing.
export async function trackScoreSync<T>(sportKey: string, outcomes: FeedSyncOutcome[], fetches: boolean, fn: () => Promise<T>): Promise<T> {
  try {
    const value = await fn();
    if (fetches) outcomes.push({ sportKey, ok: true });
    return value;
  } catch (err) {
    if (fetches) outcomes.push({ sportKey, ok: false, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

// A Date whose ISO string is the UTC wall time with no zone - what a
// `timestamp` (without time zone) column of UTC values expects.
function utcWall(d: Date): string {
  return d.toISOString().replace("Z", "");
}

// What one sport's odds seed / backfill means for the odds feed's record.
// Only a real answer from the Odds API counts as a success: off_season,
// all_started and no_base_row made no call (nothing recorded); cached means
// today's snapshot already exists (the API answered earlier today).
export function oddsSyncOutcome(sportKey: string, status: OddsFetchStatus | BackfillStatus): FeedSyncOutcome | null {
  switch (status) {
    case "seeded":
    case "cached":
    case "nothing_missing":
    case "added":
      return { sportKey, ok: true };
    case "fetch_failed":
      return { sportKey, ok: false, error: "Odds API request failed (fetch_failed)" };
    case "no_api_key":
      return { sportKey, ok: false, error: "ODDS_API_KEY not configured (no_api_key)" };
    default:
      return null;
  }
}
