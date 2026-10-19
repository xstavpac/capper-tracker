import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { IMPORT_ALERT_STAGES, IMPORT_LIST_LIMIT, IMPORT_LISTED_STAGES, IMPORT_WINDOW_HOURS } from "@/lib/admin-thresholds";
import { sanitizeAmbiguityLog, type ImportAmbiguityEntry, type ImportsView, type FallbackPick, type SkippedLineRow } from "@/lib/import-health";

// Write and read side of import_runs + the import_skipped_lines window the
// ops console's Imports tab shows.

const MAX_FALLBACK_PICKS = 200;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

// One row per bulk import (bulkImportPicksAction), written after the picks
// (it needs their ids). Best-effort like the skipped-line log: it never fails
// the import (one small insert, errors swallowed).
export async function recordImportRun(input: {
  userId: string;
  itemsSubmitted: number;
  picksInserted: number;
  skipped: number;
  fallbackPicks: FallbackPick[];
  ambiguity: unknown; // from the browser - validated here
}): Promise<void> {
  try {
    const ambiguity = sanitizeAmbiguityLog(input.ambiguity);
    const fallback = input.fallbackPicks.slice(0, MAX_FALLBACK_PICKS).map((f) => ({ ...f, betDetail: clip(f.betDetail, 300), sport: clip(f.sport, 60) }));
    await prisma.importRun.create({
      data: {
        userId: input.userId,
        itemsSubmitted: input.itemsSubmitted,
        picksInserted: input.picksInserted,
        skipped: input.skipped,
        fallbackUnmatched: input.fallbackPicks.length,
        fallbackPicks: fallback.length ? fallback : Prisma.DbNull,
        ambiguousAuto: ambiguity.filter((a) => a.method !== "user").reduce((n, a) => n + a.count, 0),
        ambiguousAsked: ambiguity.filter((a) => a.method === "user").reduce((n, a) => n + a.count, 0),
        ambiguity: ambiguity.length ? ambiguity : Prisma.DbNull,
      },
    });
  } catch (err) {
    console.error("[import-runs] failed to record the import run", err instanceof Error ? err.message : String(err));
  }
}

const ts = (d: Date) => Prisma.sql`${d.toISOString()}::timestamp`;

// For the combined status statement: alerting skipped lines and fallback
// picks in the window, as one json object.
export function importsStatusSql(now: Date): Prisma.Sql {
  const since = new Date(now.getTime() - IMPORT_WINDOW_HOURS * 3600000);
  return Prisma.sql`(SELECT json_build_object(
      'failed', (SELECT count(*)::int FROM import_skipped_lines WHERE stage::text = ANY(${[...IMPORT_ALERT_STAGES]}::text[]) AND "createdAt" >= ${ts(since)}),
      'fallback', (SELECT coalesce(sum("fallbackUnmatched"), 0)::int FROM import_runs WHERE "createdAt" >= ${ts(since)})
    ))`;
}

// The page: one statement over the last IMPORT_WINDOW_HOURS - skipped lines
// by stage, the newest IMPORT_LIST_LIMIT alerting / listed lines, import run
// totals, the fallback picks, and the ambiguity decisions.
export async function loadImportsView(now = new Date()): Promise<ImportsView> {
  const since = new Date(now.getTime() - IMPORT_WINDOW_HOURS * 3600000);
  const shown = [...IMPORT_ALERT_STAGES, ...IMPORT_LISTED_STAGES];
  type Row = {
    byStage: { stage: string; count: number }[] | null;
    lines: (Omit<SkippedLineRow, "createdAt"> & { createdAt: string })[] | null;
    runs: { runs: number; items: number; inserted: number; skipped: number; fallback: number; ambiguousAuto: number; ambiguousAsked: number };
    fallbackPicks: (FallbackPick & { createdAt: string })[] | null;
    ambiguity: ImportAmbiguityEntry[] | null;
  };
  const [row] = await prisma.$queryRaw<Row[]>(Prisma.sql`
    SELECT
      (SELECT json_agg(t ORDER BY t.count DESC) FROM (
         SELECT stage::text AS stage, count(*)::int AS count
         FROM import_skipped_lines WHERE "createdAt" >= ${ts(since)}
         GROUP BY stage
       ) t) AS "byStage",
      (SELECT json_agg(l ORDER BY l."createdAt" DESC) FROM (
         SELECT id, stage::text AS stage, "capperName", "rawText", "guessedSport", reason, "createdAt"
         FROM import_skipped_lines
         WHERE "createdAt" >= ${ts(since)} AND stage::text = ANY(${shown}::text[])
         ORDER BY "createdAt" DESC
         LIMIT ${IMPORT_LIST_LIMIT}
       ) l) AS lines,
      (SELECT json_build_object(
         'runs', count(*)::int,
         'items', coalesce(sum("itemsSubmitted"), 0)::int,
         'inserted', coalesce(sum("picksInserted"), 0)::int,
         'skipped', coalesce(sum(skipped), 0)::int,
         'fallback', coalesce(sum("fallbackUnmatched"), 0)::int,
         'ambiguousAuto', coalesce(sum("ambiguousAuto"), 0)::int,
         'ambiguousAsked', coalesce(sum("ambiguousAsked"), 0)::int
       ) FROM import_runs WHERE "createdAt" >= ${ts(since)}) AS runs,
      (SELECT json_agg(f) FROM (
         SELECT e.value->>'pickId' AS "pickId", e.value->>'sport' AS sport, e.value->>'betDetail' AS "betDetail", r."createdAt"
         FROM import_runs r CROSS JOIN LATERAL jsonb_array_elements(r."fallbackPicks") e
         WHERE r."createdAt" >= ${ts(since)} AND jsonb_typeof(r."fallbackPicks") = 'array'
         ORDER BY r."createdAt" DESC
         LIMIT ${IMPORT_LIST_LIMIT}
       ) f) AS "fallbackPicks",
      (SELECT json_agg(a ORDER BY a.count DESC) FROM (
         SELECT e.value->>'key' AS key, e.value->>'sport' AS sport, e.value->>'method' AS method, sum((e.value->>'count')::int)::int AS count
         FROM import_runs r CROSS JOIN LATERAL jsonb_array_elements(r.ambiguity) e
         WHERE r."createdAt" >= ${ts(since)} AND jsonb_typeof(r.ambiguity) = 'array'
         GROUP BY 1, 2, 3
         LIMIT ${IMPORT_LIST_LIMIT}
       ) a) AS ambiguity
  `);
  return {
    now,
    windowHours: IMPORT_WINDOW_HOURS,
    byStage: row.byStage ?? [],
    lines: (row.lines ?? []).map((l) => ({ ...l, createdAt: new Date(l.createdAt) })),
    runs: row.runs,
    fallbackPicks: (row.fallbackPicks ?? []).map(({ createdAt: _c, ...f }) => f),
    ambiguity: row.ambiguity ?? [],
  };
}
