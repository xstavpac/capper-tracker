import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Write side of pick_grade_failures (the ops console's Grading tab): why the
// grading pass last couldn't grade a still-PENDING pick. gradePickPool
// collects one entry per miss and hands them all here once per pool.
//
// One statement per call: an upsert over unnest()ed arrays, joined to picks
// so a pick deleted mid-run is skipped instead of tripping the foreign key.
// A repeat miss updates reason / match / lastSeenAt and counts the attempt.
// Best-effort like the other ops logs: a failed write is logged, never thrown
// - grading must not stop over its own diagnostics.

export type GradeFailure = {
  pickId: string;
  reason: string;
  gameResultId: string | null;
  // The matched GameResult's createdAt: when the score feed first showed it final.
  finalSeenAt: Date | null;
};

const MAX_REASON_LENGTH = 300;

export async function recordGradeFailures(failures: GradeFailure[]): Promise<void> {
  if (failures.length === 0) return;
  try {
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO pick_grade_failures ("pickId", reason, "gameResultId", "finalSeenAt", "firstSeenAt", "lastSeenAt", attempts)
      SELECT t.pick_id, t.reason, t.game_result_id, t.final_seen_at::timestamp(3), now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC', 1
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
        attempts = pick_grade_failures.attempts + 1
    `);
  } catch (err) {
    console.error("[grading-failures] couldn't record " + failures.length + " grading misses", err instanceof Error ? err.message : String(err));
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
