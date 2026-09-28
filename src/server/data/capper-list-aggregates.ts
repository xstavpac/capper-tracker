// The database-side aggregation behind the /cappers list page: every query here
// summarizes Pick history INSIDE Postgres and returns only the small result
// (one row per capper x window, per capper x category, ...), instead of
// shipping the user's full pick history to the app to be summarized in JS.
//
// This file is only the SQL layer - it returns raw totals and never rounds or
// derives anything. winPct / ROI / round2 / weightedScore / the specialist
// decision stay in stats.ts (recordStatsFromTotals, weightedRoiScore,
// specialistFromCategoryTotals), applied by pick-aggregates-cappers-adapter.ts
// to what these queries return, so there is one implementation of each rule.
//
// Semantics deliberately preserved from the JS path (see the adapter's legacy
// functions and stats.ts):
//   - Window bounds come from scorecardWindowRange (the same function
//     filterPicksByGameWindow filters with), bound as parameters from ONE `now`.
//     Every window but ALL also requires gradedAt IS NOT NULL; ALL has no
//     predicate at all.
//   - A pick of ANY status inside a window counts toward that window's pick
//     count (nPicks) - including a CANCELLED pick with gradedAt set - because
//     that is what makes a capper "have picks" in a window on the JS path.
//   - unitsRisked sums units over WIN, LOSS and PUSH (computeStats does).
//   - A WIN at odds = 0 makes the JS path's unitsWon Infinity/NaN. SQL can't
//     sum that, so it reports which kind of zero-odds win exists
//     (zeroOddsWinFlags) and zeroOddsWinUnitsWon() reproduces the JS value.
//   - Order-dependent results (float sums, streaks) use the createdAt, id
//     tie-break after gameTime everywhere, matching the adapter's ordered
//     fallback dataset.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { SCORECARD_WINDOWS, scorecardWindowRange, PICK_CATEGORY_VERSION, type ScorecardWindow } from "@/server/data/stats";

export type WindowTotals = {
  // null on the pooled (favorites-collective) variant, which has no per-capper grouping.
  capperId: string | null;
  window: ScorecardWindow;
  nPicks: number;
  wins: number;
  losses: number;
  pushes: number;
  unitsWon: number;
  unitsLost: number;
  unitsRisked: number;
  zeroOddsWinFlags: number;
};

export type StreakRow = { capperId: string; window: ScorecardWindow; type: "WIN" | "LOSS"; count: number };

// One capper's record in one category that could make them that category's
// specialist. The capper-level totals ride along on every row so the specialist
// rule (stats.ts specialistFromCategoryTotals) has its denominator without the
// database sending a row per category the capper ever touched.
export type SpecialistCandidateRow = {
  capperId: string;
  category: string;
  wins: number;
  losses: number;
  pushes: number;
  // Sortable "createdAt then id" key of the capper's first decided pick in this
  // category - the D2 tie-break, comparable with plain `<`.
  firstDecidedKey: string;
  decidedTotal: number;
  totalWins: number;
  totalLosses: number;
};

// One capper's record in one category of the panel's sport, plus that category's
// pooled totals (every capper, not just the returned ones).
export type CategoryPanelRow = {
  capperId: string;
  category: string;
  wins: number;
  losses: number;
  pushes: number;
  // Sortable "createdAt then id" key of the capper's first pick (any status) in
  // this category - orders leaderboard ties.
  firstAnyKey: string;
  categoryWins: number;
  categoryLosses: number;
  categoryPushes: number;
};

export type WindowScope = {
  userId: string;
  sportName?: string;
  // Restrict to these cappers (the favorites-collective query).
  capperIds?: string[];
  // Collapse every capper into one row per window.
  pooled?: boolean;
  windows?: ScorecardWindow[];
  now?: Date;
};

const ORDER = Prisma.sql`p."gameTime", p."createdAt", p.id COLLATE "C"`;
const ORDER_DESC = Prisma.sql`p."gameTime" DESC, p."createdAt" DESC, p.id COLLATE "C" DESC`;

// The window bounds as a VALUES table: (win, wstart, wend), NULL bounds for ALL.
// Instants travel as ISO strings cast to `timestamp` (no zone), which reads the
// UTC wall clock regardless of the session's TimeZone setting - the column is
// timestamp(3) holding UTC.
function windowsValues(windows: ScorecardWindow[], now: Date): Prisma.Sql {
  return Prisma.join(
    windows.map((w) => {
      const range = scorecardWindowRange(w, now);
      return range
        ? Prisma.sql`(${w}::text, ${range.start.toISOString()}::timestamp, ${range.end.toISOString()}::timestamp)`
        : Prisma.sql`(${w}::text, NULL::timestamp, NULL::timestamp)`;
    })
  );
}

const IN_WINDOW = Prisma.sql`(w.wstart IS NULL OR (p."gradedAt" IS NOT NULL AND p."gameTime" >= w.wstart AND p."gameTime" < w.wend))`;

function scopePredicates(scope: { sportName?: string; capperIds?: string[] }): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (scope.sportName) parts.push(Prisma.sql`AND p."sportId" IN (SELECT id FROM sports WHERE name = ${scope.sportName})`);
  if (scope.capperIds) parts.push(Prisma.sql`AND p."capperId" IN (${Prisma.join(scope.capperIds)})`);
  return parts.length ? Prisma.join(parts, " ") : Prisma.empty;
}

// odds/units math is spelled out in float8 (not `/ 100.0`, which is numeric
// division) so every per-pick value is the same IEEE-754 double the JS
// unitsWonOnBet produces. NULLIF keeps an odds = 0 row from ever dividing by
// zero; those rows are excluded from the sum and reported via zeroOddsWinFlags.
const WIN_UNITS = Prisma.sql`p.units * (CASE WHEN p.odds > 0 THEN p.odds::float8 / 100::float8 ELSE 100::float8 / NULLIF(abs(p.odds), 0)::float8 END)`;

// One query, every requested window: per capper (or pooled) x window totals.
export async function queryWindowTotals(scope: WindowScope): Promise<WindowTotals[]> {
  if (scope.capperIds && scope.capperIds.length === 0) return [];
  const windows = scope.windows ?? SCORECARD_WINDOWS;
  const now = scope.now ?? new Date();
  const capperSelect = scope.pooled ? Prisma.sql`NULL::text AS "capperId",` : Prisma.sql`p."capperId" AS "capperId",`;
  const groupBy = scope.pooled ? Prisma.sql`w.win` : Prisma.sql`p."capperId", w.win`;

  const rows = await prisma.$queryRaw<
    {
      capperId: string | null;
      window: ScorecardWindow;
      nPicks: number;
      wins: number;
      losses: number;
      pushes: number;
      unitsWon: number;
      unitsLost: number;
      unitsRisked: number;
      zeroOddsWinFlags: number;
    }[]
  >(Prisma.sql`
    WITH w(win, wstart, wend) AS (VALUES ${windowsValues(windows, now)})
    SELECT
      ${capperSelect}
      w.win AS "window",
      count(*)::int AS "nPicks",
      (count(*) FILTER (WHERE p.status = 'WIN'))::int AS "wins",
      (count(*) FILTER (WHERE p.status = 'LOSS'))::int AS "losses",
      (count(*) FILTER (WHERE p.status = 'PUSH'))::int AS "pushes",
      COALESCE(sum(${WIN_UNITS} ORDER BY ${ORDER}) FILTER (WHERE p.status = 'WIN' AND p.odds <> 0), 0)::float8 AS "unitsWon",
      COALESCE(sum(p.units ORDER BY ${ORDER}) FILTER (WHERE p.status = 'LOSS'), 0)::float8 AS "unitsLost",
      COALESCE(sum(p.units ORDER BY ${ORDER}) FILTER (WHERE p.status IN ('WIN', 'LOSS', 'PUSH')), 0)::float8 AS "unitsRisked",
      COALESCE(bit_or(CASE WHEN p.units > 0 THEN 1 WHEN p.units < 0 THEN 2 ELSE 4 END) FILTER (WHERE p.status = 'WIN' AND p.odds = 0), 0)::int AS "zeroOddsWinFlags"
    FROM picks p
    JOIN w ON ${IN_WINDOW}
    WHERE p."userId" = ${scope.userId} ${scopePredicates(scope)}
    GROUP BY ${groupBy}
  `);
  return rows;
}

// unitsWon on the JS path for a set containing WINs at odds = 0: units *
// (100 / 0) is Infinity (units > 0), -Infinity (units < 0) or NaN (units = 0),
// and adding it to the running sum poisons it. flags is the bit_or of those
// kinds (1 = positive units, 2 = negative, 4 = zero); combining kinds that
// disagree (Infinity + -Infinity) is NaN too. Returns null when there is no
// zero-odds win and the SQL sum stands as-is.
export function zeroOddsWinUnitsWon(flags: number): number | null {
  if (flags === 0) return null;
  if (flags & 4) return NaN;
  if ((flags & 3) === 3) return NaN;
  return flags & 1 ? Infinity : -Infinity;
}

// Current streak per capper x window: the run of identical results at the tail
// of that window's own WIN/LOSS picks (chronological, ties by createdAt, id).
// Gaps-and-islands in the database - one small row per capper x window comes
// back, never the picks. Each window is scoped to its own slice, so a loss just
// outside a 7-day cutoff breaks the ALL streak but not the LAST_7 one.
export async function queryCurrentStreaks(scope: Omit<WindowScope, "pooled" | "capperIds">): Promise<StreakRow[]> {
  const windows = scope.windows ?? SCORECARD_WINDOWS;
  const now = scope.now ?? new Date();
  return prisma.$queryRaw<StreakRow[]>(Prisma.sql`
    WITH w(win, wstart, wend) AS (VALUES ${windowsValues(windows, now)}),
    d AS (
      SELECT
        p."capperId" AS cid,
        w.win,
        p.status::text AS st,
        row_number() OVER (PARTITION BY p."capperId", w.win ORDER BY ${ORDER_DESC}) AS rn
      FROM picks p
      JOIN w ON ${IN_WINDOW}
      WHERE p."userId" = ${scope.userId} AND p.status IN ('WIN', 'LOSS') ${scopePredicates(scope)}
    )
    SELECT
      d.cid AS "capperId",
      d.win AS "window",
      lead.st AS "type",
      COALESCE(min(d.rn) FILTER (WHERE d.st <> lead.st) - 1, count(*))::int AS "count"
    FROM d
    JOIN d lead ON lead.cid = d.cid AND lead.win = d.win AND lead.rn = 1
    GROUP BY d.cid, d.win, lead.st
  `);
}

// Sortable "createdAt then id" key: 15-digit zero-padded epoch ms then the id,
// compared bytewise (COLLATE "C") so SQL's min() and JS's `<` agree.
const KEY = Prisma.sql`(lpad(round(extract(epoch FROM p."createdAt") * 1000)::bigint::text, 15, '0') || p.id) COLLATE "C"`;

// Candidate specialists: per capper, only the categories that clear the
// specialist rule's concentration share and minimum sample (both passed in from
// stats.ts, never re-declared here) - at most two per capper - each carrying the
// capper's decided totals. stats.ts's specialistFromCategoryTotals still makes
// the actual decision (including the win% comparison); this is only a prefilter
// so the database doesn't send a row per capper x category. `unstamped` counts
// decided picks whose stored category isn't at the current PICK_CATEGORY_VERSION;
// callers fall back to the raw-pick path when it is above 0.
export async function querySpecialistCandidates(scope: {
  userId: string;
  sportName?: string;
  minShare: number;
  minSample: number;
}): Promise<{ rows: SpecialistCandidateRow[]; unstamped: number }> {
  const sport = scope.sportName ? Prisma.sql`AND p."sportId" IN (SELECT id FROM sports WHERE name = ${scope.sportName})` : Prisma.empty;
  const rows = await prisma.$queryRaw<(SpecialistCandidateRow & { isMeta: boolean; unstamped: number })[]>(Prisma.sql`
    WITH g AS (
      SELECT
        p."capperId" AS cid,
        p.category AS cat,
        (count(*) FILTER (WHERE p.status = 'WIN'))::int AS w,
        (count(*) FILTER (WHERE p.status = 'LOSS'))::int AS l,
        (count(*) FILTER (WHERE p.status = 'PUSH'))::int AS pu,
        min(${KEY}) AS k,
        (count(*) FILTER (WHERE p."categoryVersion" < ${PICK_CATEGORY_VERSION}))::int AS unst
      FROM picks p
      WHERE p."userId" = ${scope.userId} AND p.status IN ('WIN', 'LOSS', 'PUSH') ${sport}
      GROUP BY p."capperId", p.category
    ),
    t AS (
      SELECT g.*,
        (sum(w + l + pu) OVER (PARTITION BY cid))::int AS total,
        (sum(w) OVER (PARTITION BY cid))::int AS tw,
        (sum(l) OVER (PARTITION BY cid))::int AS tl
      FROM g
    )
    SELECT cid AS "capperId", cat AS "category", w AS "wins", l AS "losses", pu AS "pushes", k AS "firstDecidedKey",
           total AS "decidedTotal", tw AS "totalWins", tl AS "totalLosses", false AS "isMeta", 0 AS "unstamped"
    FROM t
    WHERE cat IS NOT NULL AND (w + l + pu) >= ${scope.minSample} AND (w + l + pu)::float8 / total::float8 >= ${scope.minShare}::float8
    UNION ALL
    SELECT NULL, NULL, 0, 0, 0, NULL, 0, 0, 0, true, COALESCE((SELECT sum(unst) FROM g), 0)::int
  `);
  const meta = rows.find((r) => r.isMeta);
  return { rows: rows.filter((r) => !r.isMeta), unstamped: meta?.unstamped ?? 0 };
}

// The "best at" panel's data for one sport: per category, the pooled record and
// the top `limit` cappers with at least `minPicks` decided picks, ordered by
// win% (ties by the D2 first-pick key). The category leaderboard rule (min
// sample, size, ordering) is applied again in the adapter; this only keeps the
// database from sending every capper x category. Ineligible cappers are ranked
// last, so a category with fewer than `limit` eligible cappers still returns a
// row carrying its pooled totals. `unstamped` counts the sport's picks (any
// status) whose stored category isn't at the current version.
export async function queryCategoryPanel(scope: {
  userId: string;
  sportName: string;
  minPicks: number;
  limit: number;
}): Promise<{ rows: CategoryPanelRow[]; unstamped: number }> {
  const rows = await prisma.$queryRaw<(CategoryPanelRow & { isMeta: boolean; unstamped: number })[]>(Prisma.sql`
    WITH g AS (
      SELECT
        p."capperId" AS cid,
        p.category AS cat,
        (count(*) FILTER (WHERE p.status = 'WIN'))::int AS w,
        (count(*) FILTER (WHERE p.status = 'LOSS'))::int AS l,
        (count(*) FILTER (WHERE p.status = 'PUSH'))::int AS pu,
        min(${KEY}) AS k
      FROM picks p
      WHERE p."userId" = ${scope.userId} AND p.category IS NOT NULL
        AND p."sportId" IN (SELECT id FROM sports WHERE name = ${scope.sportName})
      GROUP BY p."capperId", p.category
    ),
    r AS (
      SELECT g.*,
        (sum(w) OVER (PARTITION BY cat))::int AS cw,
        (sum(l) OVER (PARTITION BY cat))::int AS cl,
        (sum(pu) OVER (PARTITION BY cat))::int AS cpu,
        row_number() OVER (
          PARTITION BY cat
          ORDER BY (w + l + pu >= ${scope.minPicks}) DESC,
                   CASE WHEN w + l > 0 THEN (w::float8 / (w + l)::float8) * 100 ELSE 0 END DESC,
                   k
        ) AS rk
      FROM g
    )
    SELECT cid AS "capperId", cat AS "category", w AS "wins", l AS "losses", pu AS "pushes", k AS "firstAnyKey",
           cw AS "categoryWins", cl AS "categoryLosses", cpu AS "categoryPushes", false AS "isMeta", 0 AS "unstamped"
    FROM r WHERE rk <= ${scope.limit}
    UNION ALL
    SELECT NULL, NULL, 0, 0, 0, NULL, 0, 0, 0, true,
      (SELECT (count(*) FILTER (WHERE p."categoryVersion" < ${PICK_CATEGORY_VERSION}))::int
         FROM picks p
        WHERE p."userId" = ${scope.userId}
          AND p."sportId" IN (SELECT id FROM sports WHERE name = ${scope.sportName}))
  `);
  const meta = rows.find((r) => r.isMeta);
  return { rows: rows.filter((r) => !r.isMeta), unstamped: meta?.unstamped ?? 0 };
}
