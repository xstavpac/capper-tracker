import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { GRADING_FUZZY_WINDOW_DAYS, GRADING_STUCK_AFTER_FINAL_HOURS, GRADING_STUCK_LIST_LIMIT, GRADING_STUCK_NO_RESULT_HOURS } from "@/lib/admin-thresholds";
import { REGRADE_LOOKBACK_DAYS, regradeLookbackCutoff } from "@/server/data/grading";
import { LIVE_SPORTS, RESOLVABLE_SPORT_KEYS } from "@/server/data/odds";
import type { GradingView, PendingBySport, StuckPick } from "@/lib/grading-health";

// Read side of the ops console's Grading tab. Cross-user on purpose (it's the
// grading pipeline's health, not anyone's picks); only counts, and at most
// GRADING_STUCK_LIST_LIMIT stuck picks, leave the database.
//
// Timestamps go in as UTC ISO text cast to timestamp - the columns are
// timestamp(3) holding UTC - so the session time zone never matters.

// The sports the grade-picks cron grades, by sports.name (= LIVE_SPORTS label).
export const AUTO_GRADED_SPORTS = RESOLVABLE_SPORT_KEYS.map((k) => LIVE_SPORTS.find((s) => s.key === k)?.label).filter((n): n is string => !!n);

const ts = (d: Date) => Prisma.sql`${d.toISOString()}::timestamp`;

type Cutoffs = { lookback: Date; finalCut: Date; noResultCut: Date };
export function stuckCutoffs(now: Date): Cutoffs {
  return {
    lookback: regradeLookbackCutoff(now),
    finalCut: new Date(now.getTime() - GRADING_STUCK_AFTER_FINAL_HOURS * 3600000),
    noResultCut: new Date(now.getTime() - GRADING_STUCK_NO_RESULT_HOURS * 3600000),
  };
}

// The stuck-pending predicate over picks p (joined to sports s and
// LEFT JOIN pick_grade_failures f). Shared by the page and the red dot.
function stuckWhere(c: Cutoffs): Prisma.Sql {
  return Prisma.sql`
    p.status = 'PENDING'
    AND s.name = ANY(${AUTO_GRADED_SPORTS}::text[])
    AND p."gameTime" >= ${ts(c.lookback)}
    AND (
      (f."finalSeenAt" IS NOT NULL AND f."finalSeenAt" <= ${ts(c.finalCut)})
      OR (f."finalSeenAt" IS NULL AND p."gameTime" <= ${ts(c.noResultCut)})
    )`;
}

const STUCK_FROM = Prisma.sql`
  FROM picks p
  JOIN sports s ON s.id = p."sportId"
  LEFT JOIN pick_grade_failures f ON f."pickId" = p.id`;

const STUCK_COLS = Prisma.sql`
  p.id, s.name AS sport, p."betType"::text AS "betType", p.period::text AS period, p."betDetail", p."homeTeam", p."awayTeam",
  p."gameTime", f.reason, f."finalSeenAt", f."lastSeenAt", f.attempts`;

// For the combined status statement: the stuck count and the oldest stuck
// pick (one row), as json.
export function gradingStatusSql(now: Date): { count: Prisma.Sql; oldest: Prisma.Sql } {
  const c = stuckCutoffs(now);
  return {
    count: Prisma.sql`(SELECT count(*)::int ${STUCK_FROM} WHERE ${stuckWhere(c)})`,
    oldest: Prisma.sql`(SELECT row_to_json(x) FROM (SELECT ${STUCK_COLS} ${STUCK_FROM} WHERE ${stuckWhere(c)} ORDER BY p."gameTime" ASC LIMIT 1) x)`,
  };
}

type JsonStuck = Omit<StuckPick, "gameTime" | "finalSeenAt" | "lastSeenAt"> & { gameTime: string; finalSeenAt: string | null; lastSeenAt: string | null };

export function parseStuck(r: JsonStuck): StuckPick {
  return {
    ...r,
    gameTime: new Date(r.gameTime),
    finalSeenAt: r.finalSeenAt ? new Date(r.finalSeenAt) : null,
    lastSeenAt: r.lastSeenAt ? new Date(r.lastSeenAt) : null,
  };
}

// The page: one statement - pending by sport (with in/past lookback and
// stuck counts), the stuck total, the oldest GRADING_STUCK_LIST_LIMIT stuck
// picks with their last failure reason, and the fuzzy-graded count.
export async function loadGradingView(now = new Date()): Promise<GradingView> {
  const c = stuckCutoffs(now);
  const fuzzyFrom = new Date(now.getTime() - GRADING_FUZZY_WINDOW_DAYS * 86400000);
  const [row] = await prisma.$queryRaw<{ bySport: Omit<PendingBySport, "autoGraded">[] | null; stuckTotal: number; stuck: JsonStuck[] | null; fuzzy: number }[]>(Prisma.sql`
    SELECT
      (SELECT json_agg(t ORDER BY t.pending DESC, t.sport) FROM (
         SELECT s.name AS sport,
                count(*)::int AS pending,
                (count(*) FILTER (WHERE p."gameTime" >= ${ts(c.lookback)}))::int AS "inLookback",
                (count(*) FILTER (WHERE p."gameTime" < ${ts(c.lookback)}))::int AS "pastLookback",
                (count(*) FILTER (WHERE ${stuckWhere(c)}))::int AS stuck
         ${STUCK_FROM}
         WHERE p.status = 'PENDING'
         GROUP BY s.name
       ) t) AS "bySport",
      (SELECT count(*)::int ${STUCK_FROM} WHERE ${stuckWhere(c)}) AS "stuckTotal",
      (SELECT json_agg(x) FROM (
         SELECT ${STUCK_COLS} ${STUCK_FROM} WHERE ${stuckWhere(c)}
         ORDER BY p."gameTime" ASC
         LIMIT ${GRADING_STUCK_LIST_LIMIT}
       ) x) AS stuck,
      (SELECT count(*)::int FROM picks WHERE "gradedViaFuzzyMatch" = true AND "gradedAt" >= ${ts(fuzzyFrom)}) AS fuzzy
  `);
  return {
    now,
    lookbackDays: REGRADE_LOOKBACK_DAYS,
    bySport: (row.bySport ?? []).map((s) => ({ ...s, autoGraded: AUTO_GRADED_SPORTS.includes(s.sport) })),
    stuckTotal: row.stuckTotal,
    stuck: (row.stuck ?? []).map(parseStuck),
    fuzzyGraded: row.fuzzy,
  };
}
