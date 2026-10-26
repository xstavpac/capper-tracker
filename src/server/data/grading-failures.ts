import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { GRADING_STUCK_NO_RESULT_HOURS } from "@/lib/admin-thresholds";

// Write side of pick_grade_failures (the ops console's Grading tab): why the
// grading pass last couldn't grade a still-PENDING pick. gradePickPool
// collects one entry per miss and hands them all here once per pool.
//
// One statement per call: an upsert over unnest()ed arrays, joined to picks
// so a pick deleted mid-run is skipped instead of tripping the foreign key.
// A repeat miss updates reason / match / lastSeenAt, counts the attempt and
// pushes nextAttemptAt out (the retry backoff below). Best-effort like the
// other ops logs: a failed write is logged, never thrown - grading must not
// stop over its own diagnostics.

export type GradeFailure = {
  pickId: string;
  reason: string;
  gameResultId: string | null;
  // The matched GameResult's createdAt: when the score feed first showed it final.
  finalSeenAt: Date | null;
};

const MAX_REASON_LENGTH = 300;

// ---- Retry backoff ----
// A pick that missed this run is not a candidate again until nextAttemptAt, so
// a pick that can't grade stops costing a read and a write on every 15-minute
// run. By failures recorded so far:
//   1..7   no wait: the next run retries (a box score or final that lands
//          minutes late grades on the very next pass)
//   8..19  1 hour: still plausibly transient (a late box score, a feed outage)
//   20..29 1 day: very unlikely to resolve on its own; keeps one look a day
//   30     stop: left for manual review (the Grading tab still lists it)
// 8 + 12 + 10 tries, about 10.5 days in all - inside the 14-day regrade
// lookback, so the cap is reached before the pick ages out anyway.
export const GRADE_RETRY_EVERY_RUN_UNTIL = 8;
export const GRADE_RETRY_HOURLY_UNTIL = 20;
export const GRADE_RETRY_MAX_ATTEMPTS = 30;
const GRADE_RETRY_HOUR_SECONDS = 3600;
const GRADE_RETRY_DAY_SECONDS = 86400;
// nextAttemptAt once retries have stopped. A date, not NULL, because NULL means
// "due" for every row written before this column existed.
export const GRADE_RETRY_STOPPED_AT = new Date("9999-12-31T00:00:00.000Z");

// Seconds to wait after the `attempts`-th recorded failure; null = stop. The
// upsert below computes the same table in SQL (grading-failures-backoff-
// acceptance-test.ts holds the two together).
export function gradeRetryDelaySeconds(attempts: number): number | null {
  if (attempts >= GRADE_RETRY_MAX_ATTEMPTS) return null;
  if (attempts < GRADE_RETRY_EVERY_RUN_UNTIL) return 0;
  if (attempts < GRADE_RETRY_HOURLY_UNTIL) return GRADE_RETRY_HOUR_SECONDS;
  return GRADE_RETRY_DAY_SECONDS;
}

// "No final game matched" is only a failure once the game has had time to
// finish and its score to land - the same cutoff the Grading tab uses for a
// pick with no result at all. Earlier than that the pick is simply waiting,
// and recording it would burn the every-run tier before a final can exist.
export const GRADE_NO_MATCH_AFTER_MS = GRADING_STUCK_NO_RESULT_HOURS * 3600000;

export async function recordGradeFailures(failures: GradeFailure[]): Promise<void> {
  if (failures.length === 0) return;
  try {
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO pick_grade_failures ("pickId", reason, "gameResultId", "finalSeenAt", "firstSeenAt", "lastSeenAt", attempts, "nextAttemptAt")
      SELECT t.pick_id, t.reason, t.game_result_id, t.final_seen_at::timestamp(3), now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC', 1, now() AT TIME ZONE 'UTC'
      FROM unnest(
        ${failures.map((f) => f.pickId)}::text[],
        ${failures.map((f) => f.reason.slice(0, MAX_REASON_LENGTH))}::text[],
        ${failures.map((f) => f.gameResultId)}::text[],
        ${failures.map((f) => (f.finalSeenAt ? f.finalSeenAt.toISOString() : null))}::text[]
      ) AS t(pick_id, reason, game_result_id, final_seen_at)
      JOIN picks p ON p.id = t.pick_id
      ON CONFLICT ("pickId") DO UPDATE SET
        reason = EXCLUDED.reason,
        "gameResultId" = EXCLUDED."gameResultId",
        "finalSeenAt" = EXCLUDED."finalSeenAt",
        "lastSeenAt" = EXCLUDED."lastSeenAt",
        attempts = pick_grade_failures.attempts + 1,
        "nextAttemptAt" = CASE
          WHEN pick_grade_failures.attempts + 1 >= ${GRADE_RETRY_MAX_ATTEMPTS}::int THEN ${GRADE_RETRY_STOPPED_AT.toISOString()}::timestamp
          ELSE (now() AT TIME ZONE 'UTC') + make_interval(secs => (CASE
            WHEN pick_grade_failures.attempts + 1 < ${GRADE_RETRY_EVERY_RUN_UNTIL}::int THEN 0
            WHEN pick_grade_failures.attempts + 1 < ${GRADE_RETRY_HOURLY_UNTIL}::int THEN ${GRADE_RETRY_HOUR_SECONDS}::int
            ELSE ${GRADE_RETRY_DAY_SECONDS}::int
          END)::float8)
        END
    `);
  } catch (err) {
    console.error("[grading-failures] couldn't record " + failures.length + " grading misses", err instanceof Error ? err.message : String(err));
  }
}

// A pick that graded (or was graded by hand) has nothing left to explain: drop
// its row. By pick id only, one statement per call. Best-effort.
export async function clearGradeFailures(pickIds: string[]): Promise<void> {
  if (pickIds.length === 0) return;
  try {
    await prisma.$executeRaw(Prisma.sql`DELETE FROM pick_grade_failures WHERE "pickId" = ANY(${pickIds}::text[])`);
  } catch (err) {
    console.error("[grading-failures] couldn't clear " + pickIds.length + " grading misses", err instanceof Error ? err.message : String(err));
  }
}

// Fresh data for a game is a reason to look again, so it ends the backoff
// (deletes the rows - the next miss starts over at attempt 1) for:
//   - picks last matched to a game whose row was just backfilled or corrected
//     (gameResultId), and
//   - picks that matched nothing, when a final is newly created for their
//     sport within the +-2 days the matcher searches (`newGameDates`).
// The rows are chosen by pick id from pick_grade_failures itself and deleted
// by pickId. Best-effort.
export async function resetGradeFailuresForGames(args: {
  sportId: string | null;
  gameResultIds: string[];
  newGameDates: Date[];
}): Promise<void> {
  const { sportId, gameResultIds, newGameDates } = args;
  const noMatchWindow = sportId !== null && newGameDates.length > 0;
  if (gameResultIds.length === 0 && !noMatchWindow) return;
  const times = newGameDates.map((d) => d.getTime());
  const from = new Date((noMatchWindow ? Math.min(...times) : 0) - 2 * 86400000).toISOString();
  const to = new Date((noMatchWindow ? Math.max(...times) : 0) + 2 * 86400000).toISOString();
  try {
    await prisma.$executeRaw(Prisma.sql`
      DELETE FROM pick_grade_failures WHERE "pickId" IN (
        SELECT f."pickId" FROM pick_grade_failures f
        LEFT JOIN picks p ON p.id = f."pickId"
        WHERE f."gameResultId" = ANY(${gameResultIds}::text[])
           OR (${noMatchWindow}::boolean AND f."gameResultId" IS NULL AND p."sportId" = ${sportId}
               AND p."gameTime" >= ${from}::timestamp AND p."gameTime" < ${to}::timestamp)
      )
    `);
  } catch (err) {
    console.error("[grading-failures] couldn't reset grading misses for new game data", err instanceof Error ? err.message : String(err));
  }
}

// The reason for a pick whose game DID match but couldn't be graded from it.
export function ungradeableReason(pick: { betType: string; period: string }): string {
  const what = pick.period === "FULL_GAME" ? pick.betType : `${pick.betType} ${pick.period}`;
  return `matched a final game but couldn't grade this ${what} from it (e.g. which side it's on is ambiguous, or that period's score is missing)`;
}

// finalsInWindow is counted per pick: finals inside THIS pick's own +-2-day
// window, not the run's whole candidate pool.
export function noMatchReason(finalsInWindow: number): string {
  return `no final game matched (${finalsInWindow} finals for this sport within +-2 days of the pick's game time)`;
}
