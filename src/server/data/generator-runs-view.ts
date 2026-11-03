// Read side of parlay_generator_runs for the admin Generator tab (written by
// server/data/generator-runs.ts). Two reads, both admin-only and uncached:
//   - the list: the newest runs WITHOUT their per-pick detail, their Hedge / Contrarian
//     per-leg traces or the per-game intake list (the heavy parts of `extras`), so a page
//     load reads a few KB a run - Supabase egress;
//   - one run in full (detail included), only when the admin opens it.
// Read by id or by createdAt only; nothing here writes.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { RunRow } from "@/lib/parlay/run-view";
import type { RunTrace } from "@/lib/parlay/run-trace";

export const RUN_LIST_LIMIT = 30;

type Mode = RunRow["mode"];

// The list leaves out the per-leg arrays (swaps, scoring.legs, selection.legs / .hedge): the run page reads them.
const LIST_EXTRAS = Prisma.sql`CASE WHEN extras ? 'snapshot'
  THEN jsonb_set((extras - 'swaps') #- '{scoring,legs}' #- '{selection,legs}' #- '{selection,hedge}', '{snapshot}', (extras -> 'snapshot') - 'games')
  ELSE (extras - 'swaps') #- '{scoring,legs}' #- '{selection,legs}' #- '{selection,hedge}' END`;

export async function loadRecentRuns(opts: { mode?: Mode; limit?: number } = {}): Promise<RunRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? RUN_LIST_LIMIT, 1), 100);
  const where = opts.mode ? Prisma.sql`WHERE mode = ${opts.mode}::"ParlayRunMode"` : Prisma.empty;
  return prisma.$queryRaw<RunRow[]>(Prisma.sql`
    SELECT id, "createdAt", mode::text AS mode, trigger::text AS trigger, origin, "scoringVersion", settings, stages, reasons, errors,
           ${LIST_EXTRAS} AS extras, "detailTruncated", "traceFailed", "durationMs"
    FROM parlay_generator_runs
    ${where}
    ORDER BY "createdAt" DESC
    LIMIT ${limit}`);
}

export type RunInFull = RunRow & { detail: RunTrace["detail"] };

export async function loadRun(id: string): Promise<RunInFull | null> {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return null;
  const row = await prisma.parlayGeneratorRun.findUnique({ where: { id } });
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.createdAt,
    mode: row.mode,
    trigger: row.trigger,
    origin: row.origin,
    scoringVersion: row.scoringVersion,
    settings: row.settings as RunRow["settings"],
    stages: row.stages as RunRow["stages"],
    reasons: row.reasons as RunRow["reasons"],
    errors: row.errors as RunRow["errors"],
    extras: row.extras as RunRow["extras"],
    detailTruncated: row.detailTruncated,
    traceFailed: row.traceFailed,
    durationMs: row.durationMs,
    detail: row.detail as RunTrace["detail"],
  };
}
