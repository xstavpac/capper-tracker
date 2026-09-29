import { Prisma, type ImportSkipStage } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Read side of the import skipped-line log, for the admin report only.
// Cross-user on purpose: the point is which markets cappers in general post
// that the importer can't handle. Run on demand (no caching, no polling).
export type SkippedLineReport = {
  from: Date;
  to: Date;
  total: number;
  byStage: { stage: ImportSkipStage; count: number }[];
  // marketHint null = no market keyword matched the line.
  byMarketHint: { marketHint: string | null; count: number; topLines: { rawText: string; count: number }[] }[];
};

export const TOP_LINES_PER_BUCKET = 5;

export async function getSkippedLineReport(from: Date, to: Date): Promise<SkippedLineReport> {
  const where = { createdAt: { gte: from, lt: to } };

  const [stageGroups, hintGroups, topLines] = await Promise.all([
    prisma.importSkippedLine.groupBy({ by: ["stage"], where, _count: { _all: true } }),
    prisma.importSkippedLine.groupBy({ by: ["marketHint"], where, _count: { _all: true } }),
    // Top N raw lines per bucket in one statement (window function), instead
    // of pulling every (hint, line) group into JS.
    prisma.$queryRaw<{ marketHint: string | null; rawText: string; n: number }[]>(Prisma.sql`
      SELECT "marketHint", "rawText", n FROM (
        SELECT "marketHint", "rawText", count(*)::int AS n,
               row_number() OVER (PARTITION BY "marketHint" ORDER BY count(*) DESC, "rawText") AS rk
        FROM "import_skipped_lines"
        WHERE "createdAt" >= ${from} AND "createdAt" < ${to}
        GROUP BY "marketHint", "rawText"
      ) t
      WHERE rk <= ${TOP_LINES_PER_BUCKET}
      ORDER BY n DESC
    `),
  ]);

  const byStage = stageGroups.map((g) => ({ stage: g.stage, count: g._count._all })).sort((a, b) => b.count - a.count);
  const byMarketHint = hintGroups
    .map((g) => ({
      marketHint: g.marketHint,
      count: g._count._all,
      topLines: topLines
        .filter((l) => l.marketHint === g.marketHint)
        .map((l) => ({ rawText: l.rawText, count: l.n })),
    }))
    .sort((a, b) => b.count - a.count);

  return { from, to, total: byStage.reduce((sum, s) => sum + s.count, 0), byStage, byMarketHint };
}

// "YYYY-MM-DD" -> start of that UTC day; anything else -> null.
export function parseDateParam(value: string | string[] | undefined): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(value + "T00:00:00.000Z");
  return Number.isNaN(d.getTime()) ? null : d;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Default window: last 30 days through now. `to` from the query is an
// inclusive calendar day, so it becomes the exclusive start of the next day.
export function resolveReportRange(
  fromParam: string | string[] | undefined,
  toParam: string | string[] | undefined,
  now: Date = new Date()
): { from: Date; to: Date; fromInput: string; toInput: string } {
  const toDay = parseDateParam(toParam);
  const to = toDay ? new Date(toDay.getTime() + DAY_MS) : new Date(now.getTime() + 1);
  const from = parseDateParam(fromParam) ?? new Date(to.getTime() - 30 * DAY_MS);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from, to, fromInput: iso(from), toInput: iso(new Date(to.getTime() - 1)) };
}
