import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { outcomeFromResponse, type CronName, type CronRunRow } from "@/lib/cron-runs";

// Write and read side of cron_runs (the ops console's Crons tab).
//
// runCronLogged wraps a cron route's work AFTER its CRON_SECRET check: one
// insert when the run starts (status RUNNING), one update by id when it ends.
// Logging must never break a cron, so every write here is best-effort: a
// failed insert just means the run isn't logged.

const MAX_ERROR_LENGTH = 300;

export async function runCronLogged(name: CronName, run: () => Promise<Response>): Promise<Response> {
  const startedAt = new Date();
  let id: string | null = null;
  try {
    ({ id } = await prisma.cronRun.create({ data: { name, startedAt }, select: { id: true } }));
  } catch (err) {
    console.error("[cron-runs] couldn't log the start of " + name, err instanceof Error ? err.message : String(err));
  }

  const finish = async (data: Prisma.CronRunUpdateInput) => {
    if (!id) return;
    const endedAt = new Date();
    try {
      await prisma.cronRun.update({ where: { id }, data: { ...data, endedAt, durationMs: endedAt.getTime() - startedAt.getTime() } });
    } catch (err) {
      console.error("[cron-runs] couldn't log the end of " + name, err instanceof Error ? err.message : String(err));
    }
  };

  let res: Response;
  try {
    res = await run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finish({ status: "ERROR", error: msg.slice(0, MAX_ERROR_LENGTH) });
    throw err;
  }

  let body: unknown = null;
  try {
    body = await res.clone().json();
  } catch {
    // Not JSON - the status code alone decides.
  }
  const outcome = outcomeFromResponse(name, res.status, body);
  await finish({
    status: outcome.status,
    httpStatus: res.status,
    rowsTouched: outcome.rowsTouched,
    summary: outcome.summary ?? Prisma.DbNull,
  });
  return res;
}

const ROW_SELECT = Prisma.sql`name, "startedAt", "endedAt", "durationMs", status::text AS status, "httpStatus", "rowsTouched", summary, error`;

// The Crons tab: the last `perCron` runs of each cron within `days`, newest
// first. One statement; (name, startedAt) index.
export async function loadRecentCronRuns(perCron = 10, days = 7): Promise<CronRunRow[]> {
  return prisma.$queryRaw<CronRunRow[]>(Prisma.sql`
    SELECT ${ROW_SELECT} FROM (
      SELECT *, row_number() OVER (PARTITION BY name ORDER BY "startedAt" DESC) AS rk
      FROM cron_runs
      WHERE "startedAt" >= now() - make_interval(days => ${days}::int)
    ) t
    WHERE rk <= ${perCron}
    ORDER BY name, "startedAt" DESC
  `);
}

// The newest run of each cron, any age (the red dot reads this inside the
// combined status statement; the Crons page reads it too, so a cron that
// hasn't run in over a week still shows its last run). DISTINCT ON walks the
// (name, startedAt) index once per name.
export const LATEST_CRON_RUNS_SQL = Prisma.sql`
  SELECT DISTINCT ON (name) ${ROW_SELECT}
  FROM cron_runs
  ORDER BY name, "startedAt" DESC
`;

export async function loadLatestCronRuns(): Promise<CronRunRow[]> {
  return prisma.$queryRaw<CronRunRow[]>(LATEST_CRON_RUNS_SQL);
}
