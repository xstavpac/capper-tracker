// Write side of parlay_generator_runs (the Parlay Generator's run log, lib/parlay/run-trace.ts): the best-effort
// recorder and the retention pass refresh-scores runs. The intake rules for a browser trace (validator, rate
// limit) are lib/parlay/run-trace-validate.ts.
//
// Diagnostics only. Nothing here may change what a user sees: the recorder never throws, and the userId always
// comes from the session.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { RunTrace } from "@/lib/parlay/run-trace";

// Per-pick detail is kept this long, counts / reasons / errors the longer one.
export const DETAIL_RETAIN_MS = 30 * 24 * 3600_000;
export const ROW_RETAIN_MS = 180 * 24 * 3600_000;
// One retention pass touches at most this many rows of each kind.
export const PRUNE_BATCH = 200;

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------
const json = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue;
const jsonOrNull = (v: unknown, empty: boolean) => (empty ? Prisma.DbNull : json(v));

// One small insert after the parlay is built. Never throws: a failed write is logged
// and the user's parlay is unaffected.
export async function recordGeneratorRun(userId: string, trace: RunTrace): Promise<void> {
  try {
    const extras = trace.origin === "SERVER" && process.env.VERCEL_GIT_COMMIT_SHA ? { ...trace.extras, buildSha: process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 12) } : trace.extras;
    await prisma.parlayGeneratorRun.create({
      data: {
        userId,
        mode: trace.mode,
        trigger: trace.trigger,
        origin: trace.origin,
        scoringVersion: trace.scoringVersion,
        settings: json(trace.settings),
        stages: json(trace.stages),
        reasons: json(trace.reasons),
        errors: jsonOrNull(trace.errors, trace.errors.length === 0),
        extras: jsonOrNull(extras, Object.keys(extras).length === 0),
        detail: jsonOrNull(trace.detail, trace.detail === null),
        detailTruncated: trace.detailTruncated,
        traceFailed: trace.failed,
        durationMs: trace.durationMs,
      },
    });
  } catch (err) {
    console.error("[generator-runs] failed to record the run", err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Retention (refresh-scores). Two passes, each: read the ids that are due (by
// createdAt), then change those rows by id. Never an unscoped deleteMany.
// ---------------------------------------------------------------------------
export type PruneResult = { detailCleared: number; rowsDeleted: number };

export async function pruneGeneratorRuns(now: Date = new Date()): Promise<PruneResult> {
  const detailDue = await prisma.parlayGeneratorRun.findMany({
    where: { createdAt: { lt: new Date(now.getTime() - DETAIL_RETAIN_MS) }, NOT: { detail: { equals: Prisma.DbNull } } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: PRUNE_BATCH,
  });
  const cleared =
    detailDue.length > 0
      ? await prisma.parlayGeneratorRun.updateMany({ where: { id: { in: detailDue.map((r) => r.id) } }, data: { detail: Prisma.DbNull } })
      : { count: 0 };

  const rowsDue = await prisma.parlayGeneratorRun.findMany({
    where: { createdAt: { lt: new Date(now.getTime() - ROW_RETAIN_MS) } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: PRUNE_BATCH,
  });
  const deleted = rowsDue.length > 0 ? await prisma.parlayGeneratorRun.deleteMany({ where: { id: { in: rowsDue.map((r) => r.id) } } }) : { count: 0 };
  return { detailCleared: cleared.count, rowsDeleted: deleted.count };
}
