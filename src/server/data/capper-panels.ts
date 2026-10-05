// The /dashboard panels ("right now": streaks and recent form), all from ONE statement:
//   Hot Hand | Rising Fast | Best last 20
//   Coldest  | Falling off | Worst last 20
// Hot Hand, Coldest and Rising Fast are the panels that used to sit on /cappers, built from the same
// SQL fragments (cappers-page-aggregates.ts: panelSql, formLookupCte, formTrendCte) on the same
// roster (test cappers left out). Falling off is Rising Fast's mirror, from the same bounded read.
// Best / Worst last 20 read each active capper's newest 20 graded picks; this file applies their
// thresholds. No pick row ever reaches JS.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { round2, SCORECARD_WIN_THRESHOLD, DASHBOARD_REPORTS_CACHE_TTL_SECONDS } from "@/server/data/stats";
import { ORDER_GRADED_DESC } from "@/server/data/capper-list-aggregates";
import { formLookupCte, formTrendCte, panelRange, panelSql, risingEntriesFromRows, streakEntriesFromRows } from "@/server/data/cappers-page-aggregates";
import { DEFAULT_PANEL_WINDOW, FORM_PANEL_COUNT, type RisingEntry, type StreakEntry } from "@/lib/cappers-panels";
import { cachedByTag } from "@/server/data/cached";
import { cacheKeys } from "@/lib/cache-keys";

// Best / Worst last 20 only: cappers with no picks logged (datePosted) in this window drop off, and
// reappear the moment they log a new one. (Hot Hand / Coldest have their own "This week" eligibility;
// Rising Fast / Falling off have none.)
export const ACTIVITY_WINDOW_DAYS = 14;

// Best/Worst Last-20's window - "last 20 graded picks" is the panel's own name.
export const RECENT_FORM_WINDOW = 20;
// Need at least half the window decided before recent form means anything.
export const RECENT_FORM_MIN_SAMPLE = 10;
// Same shrinkage strength as weightedRoiScore, applied to win% instead of
// ROI for Best Last-20 - kept identical for consistency across the app's
// two weighted-ranking mechanisms. Ranks the panel only - the displayed
// record/win% is always the raw recent rate, never the shrunk score.
export const RECENT_FORM_SHRINKAGE_K = 10;
// The line between Best and Worst Last-20: the app-wide win% color rule (getRecordColor).
export const BEST_LAST20_MIN_WIN_PCT = 50;

// Deliberately simple - just the raw record and win% over the last 20 graded
// picks (pushes count in the denominator).
export type BestLast20Entry = {
  capperId: string;
  name: string;
  colorTag: string | null;
  wins: number;
  losses: number;
  pushes: number;
  recentWinPct: number;
  weightedScore: number; // ranks the panel only, never displayed
};

export type CapperPanels = {
  // The /cappers Hot Hand / Coldest rows at "This week" (the window dropdown fetches the others
  // through /api/cappers/panel, as it always has).
  hottest: StreakEntry[];
  coldest: StreakEntry[];
  rising: RisingEntry[];
  // Rising Fast's mirror: `pts` is negative, most negative first.
  falling: RisingEntry[];
  // Best: recent win% at or above BEST_LAST20_MIN_WIN_PCT, best first; Worst: below it, worst
  // first. One pool split in two, so no capper is ever in both. At most FORM_PANEL_COUNT each.
  bestLast20: BestLast20Entry[];
  worstLast20: BestLast20Entry[];
};

// The cache slot is chosen by this string alone (cachedByTag's callback text is
// identical for every user), so every input that changes the result must
// appear here. Distinct from cacheKeys.dashboard - that one is only the shared
// invalidation tag. "v3": the shape changed, and an entry cached by a previous
// deploy must not be read as the new one.
export function capperPanelsCacheKey(userId: string): string {
  return `capper-panels:v3:${userId}`;
}

// Reads only Pick rows (plus the roster), so it shares getDashboardSummary's
// invalidation tag and TTL: every pick mutation already calls
// revalidateTag(cacheKeys.dashboard(userId)) (docs/cache-invalidation-contract.md).
export async function getCapperPanels(userId: string): Promise<CapperPanels> {
  return cachedByTag(capperPanelsCacheKey(userId), DASHBOARD_REPORTS_CACHE_TTL_SECONDS, () => computeCapperPanels(userId), [cacheKeys.dashboard(userId)]);
}

// The one statement. Exported so tests and measurements run exactly what production runs.
export function buildCapperPanelsQuery(userId: string, now: Date): Prisma.Sql {
  const weekRange = panelRange(DEFAULT_PANEL_WINDOW, now);
  const activityCutoff = new Date(now.getTime() - ACTIVITY_WINDOW_DAYS * 86400000);
  const ctes: [string, Prisma.Sql][] = [
    ["roster", Prisma.sql`SELECT id, name, "colorTag", "isFavorite" FROM cappers WHERE "userId" = ${userId} AND NOT "isTest"`],
    ["hot", panelSql("hottest", userId, weekRange)],
    ["cold", panelSql("coldest", userId, weekRange)],
    formLookupCte(userId),
    formTrendCte("rising"),
    formTrendCte("falling"),
    // Each active roster capper's newest RECENT_FORM_WINDOW graded picks (WIN / LOSS / PUSH), most
    // recently graded first, as W / L / P counts. One small row per capper with enough of them.
    [
      "l20",
      Prisma.sql`
        SELECT r.id AS "capperId", r.name, r."colorTag", f.wins, f.losses, f.pushes
        FROM roster r
        CROSS JOIN LATERAL (
          SELECT (count(*) FILTER (WHERE q.st = 'WIN'))::int AS wins,
                 (count(*) FILTER (WHERE q.st = 'LOSS'))::int AS losses,
                 (count(*) FILTER (WHERE q.st = 'PUSH'))::int AS pushes
          FROM (
            SELECT p.status::text AS st
            FROM picks p
            WHERE p."userId" = ${userId} AND p."capperId" = r.id AND p.status IN ('WIN', 'LOSS', 'PUSH')
            ORDER BY ${ORDER_GRADED_DESC}
            LIMIT ${RECENT_FORM_WINDOW}
          ) q
        ) f
        WHERE f.wins + f.losses + f.pushes >= ${RECENT_FORM_MIN_SAMPLE}
          AND EXISTS (SELECT 1 FROM picks p WHERE p."userId" = ${userId} AND p."capperId" = r.id AND p."datePosted" >= ${activityCutoff.toISOString()}::timestamp)
      `,
    ],
  ];
  const outputs = ["hot", "cold", "rising", "falling", "l20"];
  return Prisma.sql`
    WITH ${Prisma.join(
      ctes.map(([name, sql]) => Prisma.sql`${Prisma.raw(name)} AS (${sql})`),
      ",\n"
    )}
    SELECT jsonb_build_object(${Prisma.join(
      outputs.map((n) => Prisma.sql`${n}::text, COALESCE((SELECT jsonb_agg(to_jsonb(o)) FROM ${Prisma.raw(n)} o), '[]'::jsonb)`),
      ", "
    )}) AS out
  `;
}

// `now` is a parameter only so tests can pin it; production passes nothing.
export async function computeCapperPanels(userId: string, now: Date = new Date()): Promise<CapperPanels> {
  const rows = await prisma.$queryRaw<{ out: Record<string, any[]> }[]>(buildCapperPanelsQuery(userId, now));
  const out = rows[0]?.out ?? {};

  const pool: BestLast20Entry[] = (out.l20 ?? []).map((r) => {
    const wins = Number(r.wins);
    const losses = Number(r.losses);
    const pushes = Number(r.pushes);
    const decided = wins + losses + pushes;
    const recentWinPct = round2((wins / decided) * 100);
    // Same shrinkage idea as weightedRoiScore, but pulling toward the
    // -110 breakeven win% (52.4) instead of a 0% ROI prior - ranks the two
    // panels only; the displayed record/win% is always the raw recent
    // rate, same "sort weighted, show raw" pattern as the main leaderboard.
    const weightedScore = round2((decided * recentWinPct + RECENT_FORM_SHRINKAGE_K * SCORECARD_WIN_THRESHOLD) / (decided + RECENT_FORM_SHRINKAGE_K));
    return { capperId: r.capperId, name: r.name, colorTag: r.colorTag, wins, losses, pushes, recentWinPct, weightedScore };
  });
  // A total order (score, then name, then id), so equal scores never depend on the rows' arrival order.
  const byName = (a: BestLast20Entry, b: BestLast20Entry) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.capperId < b.capperId ? -1 : 1);
  const isBest = (e: BestLast20Entry) => e.recentWinPct >= BEST_LAST20_MIN_WIN_PCT;

  return {
    hottest: streakEntriesFromRows(out.hot, false),
    coldest: streakEntriesFromRows(out.cold, true),
    rising: risingEntriesFromRows(out.rising),
    falling: risingEntriesFromRows(out.falling),
    bestLast20: pool.filter(isBest).sort((a, b) => b.weightedScore - a.weightedScore || byName(a, b)).slice(0, FORM_PANEL_COUNT),
    worstLast20: pool.filter((e) => !isBest(e)).sort((a, b) => a.weightedScore - b.weightedScore || byName(a, b)).slice(0, FORM_PANEL_COUNT),
  };
}
