// Shared building blocks for the /dashboard and /cappers/[capperId] egress
// reductions - docs/design/dashboard-capper-detail-egress.md §3-§4 (PR "shared
// building blocks"). NOTHING IN THIS FILE IS WIRED TO A PAGE YET: no caller reads
// these outside tests and the parity harness, so no displayed number can change.
//
// Shape (design doc §3.0): every block is an exported `Prisma.Sql` SELECT builder
// (no WITH of its own at the top level a page has to know about) plus a row mapper.
// A page composes the blocks it needs as CTEs of ONE statement (buildPageBundleQuery
// -> one jsonb) because under connection_limit=1 statements serialize, so one
// statement per block would just re-create today's round-trip count. Every fragment
// returns raw totals/rows only; ROI, winPct, round2, labels and the sort stay in
// stats.ts, applied by the mappers here calling the same functions the JS path uses.
//
// Blocks:
//   3.a  windowTotalsSelect        (capper-list-aggregates.ts; groupBySport added)
//   3.b  categoryTilesSelect + sportFirstKeysSelect, finalizer categoryBreakdownFromCounts (stats.ts)
//   3.c  unitsSeriesSelect         dashboard running sum + downsample, chartPointsFromSeriesRows
//   3.d  dashboardRecentPicksSelect / capperRecentPicksSelect + mappers
//   3.e  pendingCountsSelect
//   4.1  decidedSeriesSelect       the narrow raw series fed to the existing JS functions
//
// Ordering everywhere is the canonical (gameTime, createdAt, id COLLATE "C")
// tie-break (ORDER / ORDER_DESC), the same total order the JS sorts in pick-order.ts use.
import { Prisma } from "@prisma/client";
import type { PickStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { formatEastern } from "@/lib/dates";
import { formatPickLabel } from "@/lib/bet-line";
import {
  IN_WINDOW,
  ORDER,
  ORDER_DESC,
  WIN_UNITS,
  windowsCte,
  zeroOddsWinUnitsWon,
} from "@/server/data/capper-list-aggregates";
import { UNITS_CHART_MAX_POINTS, downsampleUnitsChart } from "@/server/data/units-chart-downsample";
import { betTypeLabel, round2, type ScorecardWindow, type SeriesPick, type UnitsChartPoint } from "@/server/data/stats";

// ---------------------------------------------------------------------------
// Bundle composition
// ---------------------------------------------------------------------------

export type BundlePart = {
  // A plain identifier: it becomes a CTE name and the key in the returned object.
  name: string;
  // The fragment's SELECT (any of the *Select builders below).
  select: Prisma.Sql;
  // Bare column names of the part's rows ("idx", `"gameTime", "createdAt", id COLLATE "C"`)
  // to order the returned array by. jsonb_agg's order is otherwise the CTE's arrival
  // order, which the planner does not promise to preserve.
  orderBy?: Prisma.Sql;
};

// ONE statement: WITH [windows], part1 AS (...), part2 AS (...) SELECT jsonb_build_object(
// 'part1', [...rows], 'part2', [...rows]). `windows` is required by any part that reads
// the `w` CTE (windowTotalsSelect, categoryTilesSelect).
export function buildPageBundleQuery(opts: {
  windows?: { windows: ScorecardWindow[]; now: Date };
  parts: BundlePart[];
}): Prisma.Sql {
  for (const p of opts.parts) {
    if (!/^[a-z][a-zA-Z0-9_]*$/.test(p.name)) throw new Error(`bundle part name must be a plain identifier: ${p.name}`);
  }
  const ctes: Prisma.Sql[] = [];
  if (opts.windows) ctes.push(windowsCte(opts.windows.windows, opts.windows.now));
  for (const p of opts.parts) ctes.push(Prisma.sql`${Prisma.raw(p.name)} AS (${p.select})`);
  const outs = opts.parts.map((p) => {
    const n = Prisma.raw(p.name);
    const order = p.orderBy ? Prisma.sql` ORDER BY ${p.orderBy}` : Prisma.empty;
    return Prisma.sql`${p.name}::text, COALESCE((SELECT jsonb_agg(to_jsonb(bundle_row)${order}) FROM ${n} bundle_row), '[]'::jsonb)`;
  });
  return Prisma.sql`
    WITH ${Prisma.join(ctes, ", ")}
    SELECT jsonb_build_object(${Prisma.join(outs, ", ")}) AS out
  `;
}

// Runs a bundle and returns { partName: rows[] }. Every value is what
// `to_jsonb(row)` produced: numbers as JS numbers (bigint epoch-ms included), so the
// mappers below accept `number | bigint` and Number() them, which also lets them take
// the rows a plain $queryRaw of a single fragment returns.
export async function queryPageBundle(query: Prisma.Sql): Promise<Record<string, unknown[]>> {
  const rows = await prisma.$queryRaw<{ out: Record<string, unknown[]> }[]>(query);
  return rows[0]?.out ?? {};
}

// ---------------------------------------------------------------------------
// SQL round-half-up (design doc §3.c, §8 micro-test 2)
// ---------------------------------------------------------------------------

// JS's round2 is Math.round(x * 100) / 100, and Math.round breaks ties toward +Infinity.
// Postgres round(float8) is half-to-even and round(numeric) is half-away-from-zero, so
// neither may appear. y - floor(y) is exact in IEEE, so `>= 0.5` picks ceil on exactly
// the ties (and above) and floor below. Used ONLY to decide bucket extrema and ties in
// the downsample; the value emitted is the unrounded running sum and JS applies round2.
// `x` is repeated in the text, so pass a plain column/parameter, not a costly expression.
export function round2HalfUpSql(x: Prisma.Sql): Prisma.Sql {
  const y = Prisma.sql`(${x} * 100::float8)`;
  return Prisma.sql`((CASE WHEN ${y} - floor(${y}) >= 0.5::float8 THEN ceil(${y}) ELSE floor(${y}) END) / 100::float8)`;
}

// ---------------------------------------------------------------------------
// 3.b Category tiles
// ---------------------------------------------------------------------------

export type CategoryTileRow = {
  window: ScorecardWindow;
  sport?: string; // only when groupBySport
  category: string;
  wins: number;
  losses: number;
  pushes: number;
};

// Decided picks with a stored category, grouped per (window [, sport], category). Reads
// the `w` CTE (windowsCte). The STORED Pick.category only - never runtime pickCategory().
// `chipSet` pushes the dashboard's DEFAULT_CHIP_SET down (passed in from the JS constant
// so the keys live in one place); the capper page omits it because chip sets vary per
// sport and chipSetForLeague stays in JS. Counts only - no money, so no float concerns.
export function categoryTilesSelect(scope: {
  userId: string;
  capperId?: string;
  groupBySport?: boolean;
  chipSet?: string[];
}): Prisma.Sql {
  const sportSelect = scope.groupBySport ? Prisma.sql`s.name AS "sport",` : Prisma.empty;
  const sportJoin = scope.groupBySport ? Prisma.sql`JOIN sports s ON s.id = p."sportId"` : Prisma.empty;
  const capper = scope.capperId ? Prisma.sql`AND p."capperId" = ${scope.capperId}` : Prisma.empty;
  const chips = scope.chipSet ? Prisma.sql`AND p.category = ANY(${scope.chipSet}::text[])` : Prisma.empty;
  const groupCols = [Prisma.sql`w.win`, scope.groupBySport ? Prisma.sql`s.name` : null, Prisma.sql`p.category`].filter(
    (c): c is Prisma.Sql => c !== null
  );
  return Prisma.sql`
    SELECT
      w.win AS "window",
      ${sportSelect}
      p.category AS "category",
      (count(*) FILTER (WHERE p.status = 'WIN'))::int AS "wins",
      (count(*) FILTER (WHERE p.status = 'LOSS'))::int AS "losses",
      (count(*) FILTER (WHERE p.status = 'PUSH'))::int AS "pushes"
    FROM picks p
    JOIN w ON ${IN_WINDOW}
    ${sportJoin}
    WHERE p."userId" = ${scope.userId} ${capper}
      AND p.status IN ('WIN', 'LOSS', 'PUSH')
      AND p.category IS NOT NULL
      ${chips}
    GROUP BY ${Prisma.join(groupCols)}
  `;
}

export function categoryTileRowsFromBundle(rows: unknown[]): CategoryTileRow[] {
  return (rows as Record<string, unknown>[]).map((r) => ({
    window: r.window as ScorecardWindow,
    ...(r.sport !== undefined ? { sport: r.sport as string } : {}),
    category: r.category as string,
    wins: Number(r.wins),
    losses: Number(r.losses),
    pushes: Number(r.pushes),
  }));
}

// Sortable (gameTime, createdAt, id) key: three fixed-width digit fields then the id,
// compared bytewise (COLLATE "C") so SQL's min() and JS's `<` agree - the same
// construction as KEY in capper-list-aggregates.ts with gameTime prepended.
export const CHRONO_KEY = Prisma.sql`(lpad(round(extract(epoch FROM p."gameTime") * 1000)::bigint::text, 15, '0') || lpad(round(extract(epoch FROM p."createdAt") * 1000)::bigint::text, 15, '0') || p.id) COLLATE "C"`;

// The JS twin of CHRONO_KEY, for tests and for any mapper that must compare keys.
export function chronoKeyOf(p: { gameTime: Date; createdAt: Date; id: string }): string {
  return String(p.gameTime.getTime()).padStart(15, "0") + String(p.createdAt.getTime()).padStart(15, "0") + p.id;
}

export type SportFirstKeyRow = { sport: string; firstKey: string };

// Per sport, the smallest (gameTime, createdAt, id) key over ALL of the capper's picks
// (every status, whole history). The capper page's sport tabs sort by total tile count
// desc with a stable sort, so ties keep first-appearance order over `picks` - i.e. this
// key. A separate fragment (not a column of the tile rows) because the tile rows are
// decided-only and window-filtered while first appearance is not (design doc §3.b).
export function sportFirstKeysSelect(scope: { userId: string; capperId: string }): Prisma.Sql {
  return Prisma.sql`
    SELECT s.name AS "sport", min(${CHRONO_KEY}) AS "firstKey"
    FROM picks p
    JOIN sports s ON s.id = p."sportId"
    WHERE p."userId" = ${scope.userId} AND p."capperId" = ${scope.capperId}
    GROUP BY s.name
  `;
}

export function sportFirstKeysFromBundle(rows: unknown[]): SportFirstKeyRow[] {
  return (rows as Record<string, unknown>[]).map((r) => ({ sport: r.sport as string, firstKey: r.firstKey as string }));
}

// ---------------------------------------------------------------------------
// 3.c Dashboard units series: running sum + extrema-preserving downsample, in SQL
// ---------------------------------------------------------------------------

// Number of interior buckets - derived from the JS constant, never restated.
const DOWNSAMPLE_BUCKETS = Math.floor((UNITS_CHART_MAX_POINTS - 2) / 2);

export type UnitsSeriesRow = {
  idx: number; // 0-based position in the FULL settled series (index-bucketing needs it; the mapper drops it)
  t: number | bigint; // gameTime, epoch ms
  run: number; // UNROUNDED running sum through this row - JS applies round2
  flags: number; // running bit_or of zero-odds-WIN kinds (see zeroOddsWinUnitsWon); 0 in every real dataset
};

// The settled (WIN/LOSS/PUSH) picks of a user [or one capper] as the dashboard's chart
// series, already downsampled exactly as downsampleUnitsChart(computeUnitsChartData(...))
// would: identity for n <= UNITS_CHART_MAX_POINTS, otherwise the first point, the
// lowest and highest of each of 999 index buckets (first index wins ties), the last
// point. Bit-exactness with the JS path rests on:
//   - the running sum being the JS `running +=/-=` sequence: ROWS-framed window sum in
//     the canonical order; a LOSS adds (0 - units) (x - u == x + (0 - u) in IEEE, and
//     the 0 keeps a zero-units loss at +0 like JS); PUSH adds 0; WIN adds WIN_UNITS;
//   - bucket bounds computed with the same float64 operations (n-2)/999, b*bs, (b+1)*bs;
//   - comparisons done on round2 values via round2HalfUpSql (JS compares round2 values).
// Zero-odds: float8 division by zero errors in Postgres and JS's Infinity/NaN poison can't
// be summed, so a WIN at odds = 0 adds 0 and sets a RUNNING flag instead (chartPointsFromSeriesRows
// substitutes JS's poison from the first flagged row on). If ANY row in scope is flagged the
// SQL downsample is skipped and the full series comes back, for JS downsampleUnitsChart.
// Unreachable while odds = 0 rows number zero (both creators reject them); Q6 decided no CHECK.
export function unitsSeriesSelect(scope: { userId: string; capperId?: string }): Prisma.Sql {
  const capper = scope.capperId ? Prisma.sql`AND p."capperId" = ${scope.capperId}` : Prisma.empty;
  return Prisma.sql`
    WITH s AS MATERIALIZED (
      SELECT
        (row_number() OVER o - 1)::int AS idx,
        round(extract(epoch FROM p."gameTime") * 1000)::bigint AS t,
        sum(CASE WHEN p.status = 'WIN' THEN COALESCE(${WIN_UNITS}, 0::float8)
                 WHEN p.status = 'LOSS' THEN 0::float8 - p.units
                 ELSE 0::float8 END) OVER o AS run,
        COALESCE(bit_or(CASE WHEN p.status = 'WIN' AND p.odds = 0
                             THEN (CASE WHEN p.units > 0 THEN 1 WHEN p.units < 0 THEN 2 ELSE 4 END)
                             ELSE 0 END) OVER o, 0)::int AS flags
      FROM picks p
      WHERE p."userId" = ${scope.userId} ${capper} AND p.status IN ('WIN', 'LOSS', 'PUSH')
      WINDOW o AS (ORDER BY ${ORDER} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
    ),
    c AS MATERIALIZED (
      SELECT s.idx, s.t, s.run, s.flags,
             ${round2HalfUpSql(Prisma.sql`s.run`)} AS cum,
             count(*) OVER () AS n,
             bool_or(s.flags <> 0) OVER () AS anyflag
      FROM s
    ),
    bk AS (
      SELECT COALESCE(max(n) > ${UNITS_CHART_MAX_POINTS}::int AND NOT bool_or(anyflag), false) AS "on",
             max(n)::int AS n,
             ((max(n) - 2)::float8 / ${DOWNSAMPLE_BUCKETS}::float8) AS bs
      FROM c
    ),
    -- Each interior row's bucket. Candidates b0-1..b0+1 around the analytic bucket, then the
    -- EXACT float64 bounds decide membership, so a row JS's floor() arithmetic puts in no
    -- bucket (or one) is treated identically here.
    asg AS (
      SELECT c.idx, c.cum, x.b
      FROM c CROSS JOIN bk
      CROSS JOIN LATERAL (
        SELECT g AS b
        FROM generate_series(
          GREATEST(floor((c.idx - 1)::float8 / bk.bs)::int - 1, 0),
          LEAST(floor((c.idx - 1)::float8 / bk.bs)::int + 1, ${DOWNSAMPLE_BUCKETS}::int - 1)
        ) g
        WHERE c.idx >= 1 + floor(g::float8 * bk.bs)::int
          AND c.idx < 1 + floor((g + 1)::float8 * bk.bs)::int
      ) x
      WHERE bk."on" AND c.idx >= 1 AND c.idx <= bk.n - 2
    ),
    ext AS (SELECT b, min(cum) AS mn, max(cum) AS mx FROM asg GROUP BY b),
    sel AS (
      SELECT min(a.idx) FILTER (WHERE a.cum = e.mn) AS lo_i,
             min(a.idx) FILTER (WHERE a.cum = e.mx) AS hi_i
      FROM asg a JOIN ext e ON e.b = a.b
      GROUP BY a.b
    ),
    keep AS (
      SELECT 0 AS idx FROM bk WHERE bk."on"
      UNION SELECT bk.n - 1 FROM bk WHERE bk."on"
      UNION SELECT lo_i FROM sel
      UNION SELECT hi_i FROM sel
    )
    SELECT c.idx AS "idx", c.t AS "t", c.run AS "run", c.flags AS "flags"
    FROM c CROSS JOIN bk
    WHERE NOT bk."on" OR c.idx IN (SELECT idx FROM keep)
    ORDER BY c.idx
  `;
}

export const UNITS_SERIES_ORDER_BY = Prisma.sql`idx`;

// SQL rows -> the dashboard's chart points, using the JS the legacy path uses: the date
// label from formatEastern, round2 from stats.ts. Rows past a flagged zero-odds WIN carry
// JS's Infinity/NaN, as the totals adapter does. When the database did not downsample
// (flagged scope; n <= max is already the identity) the existing downsampleUnitsChart
// runs here, so the result always equals downsampleUnitsChart(computeUnitsChartData(picks)).
export function chartPointsFromSeriesRows(rows: UnitsSeriesRow[]): UnitsChartPoint[] {
  const points = rows.map((r) => {
    const poison = r.flags === 0 ? null : zeroOddsWinUnitsWon(r.flags);
    return {
      date: formatEastern(new Date(Number(r.t)), { month: "short", day: "numeric" }),
      cumulativeUnits: round2(poison ?? r.run),
    };
  });
  return downsampleUnitsChart(points);
}

function unitsSeriesRowsFromBundle(rows: unknown[]): UnitsSeriesRow[] {
  return (rows as Record<string, unknown>[]).map((r) => ({
    idx: Number(r.idx),
    t: Number(r.t),
    run: Number(r.run),
    flags: Number(r.flags),
  }));
}
export { unitsSeriesRowsFromBundle };

// Standalone execution (tests, the parity harness). Pages will use the bundle instead.
export async function queryUnitsSeries(scope: { userId: string; capperId?: string }): Promise<UnitsSeriesRow[]> {
  const rows = await prisma.$queryRaw<UnitsSeriesRow[]>(unitsSeriesSelect(scope));
  return rows.map((r) => ({ idx: Number(r.idx), t: Number(r.t), run: r.run, flags: Number(r.flags) }));
}

// ---------------------------------------------------------------------------
// 3.d Recent N picks
// ---------------------------------------------------------------------------

export const DASHBOARD_RECENT_PICKS = 10;
export const CAPPER_RECENT_PICKS = 10;

export type DashboardRecentRow = {
  rn: number;
  id: string;
  awayTeam: string;
  homeTeam: string;
  betDetail: string | null;
  betType: string;
  line: number | null;
  status: PickStatus;
  units: number;
  capperName: string;
};

// Newest `limit` picks (any status), no relations besides the capper's name: exactly the
// columns formatPickLabel plus the dashboard row read.
export function dashboardRecentPicksSelect(scope: { userId: string; limit?: number }): Prisma.Sql {
  return Prisma.sql`
    SELECT row_number() OVER (ORDER BY ${ORDER_DESC})::int AS "rn",
           p.id AS "id", p."awayTeam" AS "awayTeam", p."homeTeam" AS "homeTeam",
           p."betDetail" AS "betDetail", p."betType"::text AS "betType", p.line AS "line",
           p.status::text AS "status", p.units AS "units", c.name AS "capperName"
    FROM picks p
    JOIN cappers c ON c.id = p."capperId"
    WHERE p."userId" = ${scope.userId}
    ORDER BY ${ORDER_DESC}
    LIMIT ${scope.limit ?? DASHBOARD_RECENT_PICKS}::int
  `;
}
export const DASHBOARD_RECENT_ORDER_BY = Prisma.sql`"rn"`;

// Flattened to what computeDashboardSummary's recentPicks has always carried.
export function dashboardRecentPicksFromRows(rows: unknown[]) {
  return (rows as DashboardRecentRow[]).map((r) => ({
    id: r.id,
    awayTeam: r.awayTeam,
    homeTeam: r.homeTeam,
    label: formatPickLabel(r.betDetail, r.betType, r.line) ?? betTypeLabel(r.betType),
    capperName: r.capperName,
    status: r.status,
    units: Number(r.units),
  }));
}

export type CapperRecentRow = {
  rs: number; // rank within the pick's sport, newest first
  ra: number; // rank over all the capper's picks, newest first
  id: string;
  awayTeam: string;
  homeTeam: string;
  betDetail: string | null;
  betType: string;
  line: number | null;
  odds: number;
  units: number;
  gameTime: number | bigint; // epoch ms
  status: PickStatus;
  sport: string;
};

// Which sport is selected is only known once the all-time tab list exists (design doc Q3),
// so the statement returns the newest `perSport` picks of EVERY sport the capper has plus
// the overall newest `overall` (the no-tab fallback); JS picks the right list. All statuses.
export function capperRecentPicksSelect(scope: {
  userId: string;
  capperId: string;
  perSport?: number;
  overall?: number;
}): Prisma.Sql {
  const perSport = scope.perSport ?? CAPPER_RECENT_PICKS;
  const overall = scope.overall ?? CAPPER_RECENT_PICKS;
  return Prisma.sql`
    SELECT * FROM (
      SELECT row_number() OVER (PARTITION BY s.name ORDER BY ${ORDER_DESC})::int AS "rs",
             row_number() OVER (ORDER BY ${ORDER_DESC})::int AS "ra",
             p.id AS "id", p."awayTeam" AS "awayTeam", p."homeTeam" AS "homeTeam",
             p."betDetail" AS "betDetail", p."betType"::text AS "betType", p.line AS "line",
             p.odds AS "odds", p.units AS "units",
             round(extract(epoch FROM p."gameTime") * 1000)::bigint AS "gameTime",
             p.status::text AS "status", s.name AS "sport"
      FROM picks p
      JOIN sports s ON s.id = p."sportId"
      WHERE p."userId" = ${scope.userId} AND p."capperId" = ${scope.capperId}
    ) r
    WHERE r."rs" <= ${perSport}::int OR r."ra" <= ${overall}::int
  `;
}
export const CAPPER_RECENT_ORDER_BY = Prisma.sql`"ra"`;

// selectCapperRecentPicks's result shape, from the rows above: the newest `limit` picks of
// `selectedCategorySport` (all statuses), or of every sport when the capper has no tab.
export function capperRecentPicksFromRows(
  rows: unknown[],
  selectedCategorySport: string | undefined,
  limit = CAPPER_RECENT_PICKS
): { picks: (Omit<CapperRecentRow, "gameTime" | "rs" | "ra"> & { gameTime: Date })[]; scopedSport: string | null } {
  const scopedSport = selectedCategorySport ?? null;
  const all = (rows as CapperRecentRow[]).map((r) => ({ ...r, gameTime: Number(r.gameTime) }));
  const picked = scopedSport
    ? all.filter((r) => r.sport === scopedSport && r.rs <= limit).sort((a, b) => a.rs - b.rs)
    : all.filter((r) => r.ra <= limit).sort((a, b) => a.ra - b.ra);
  return {
    picks: picked.map(({ rs: _rs, ra: _ra, gameTime, ...rest }) => ({ ...rest, units: Number(rest.units), gameTime: new Date(gameTime) })),
    scopedSport,
  };
}

// ---------------------------------------------------------------------------
// 3.e Pending counts
// ---------------------------------------------------------------------------

export type PendingCounts = { pending: number; stale: number };

// `staleCutoff` is bound from the same `now` the caller uses (now - 24 h): stale is
// PENDING with gameTime strictly before it, as computeDashboardSummary filters.
export function pendingCountsSelect(scope: { userId: string; staleCutoff: Date }): Prisma.Sql {
  return Prisma.sql`
    SELECT (count(*) FILTER (WHERE p.status = 'PENDING'))::int AS "pending",
           (count(*) FILTER (WHERE p.status = 'PENDING' AND p."gameTime" < ${scope.staleCutoff.toISOString()}::timestamp))::int AS "stale"
    FROM picks p
    WHERE p."userId" = ${scope.userId}
  `;
}

export function pendingCountsFromBundle(rows: unknown[]): PendingCounts {
  const r = (rows[0] ?? {}) as Record<string, unknown>;
  return { pending: Number(r.pending ?? 0), stale: Number(r.stale ?? 0) };
}

// ---------------------------------------------------------------------------
// 4.1 The narrow decided-pick series (capper detail)
// ---------------------------------------------------------------------------

export type NarrowSeriesRow = {
  id: string;
  createdAt: number | bigint; // epoch ms
  gameTime: number | bigint;
  gradedAt: number | bigint | null;
  status: PickStatus;
  units: number;
  odds: number;
  sport: string;
};

// The row the existing JS functions read (SeriesPick) plus the sport name the sport-scoped
// chart needs - what computeStats, currentStreak, computeMomentum, computeConsistency,
// computeBestOddsRange, filterPicksByGameWindow and computeUnitsChartData accept.
export type NarrowSeriesPick = SeriesPick & { sport: { name: string } };

// A capper's DECIDED picks (WIN/LOSS/PUSH), whole history, no relation rows (the sport
// name is one joined column), in the canonical order. Times are epoch-ms bigint (exact for
// timestamp(3)); PENDING/CANCELLED are excluded because no consumer reads them (recents
// and the "any status" counts come from other blocks). No betDetail, teams, notes,
// category etc. - nothing a series consumer never touches.
export function decidedSeriesSelect(scope: { userId: string; capperId: string }): Prisma.Sql {
  return Prisma.sql`
    SELECT p.id AS "id",
           round(extract(epoch FROM p."createdAt") * 1000)::bigint AS "createdAt",
           round(extract(epoch FROM p."gameTime") * 1000)::bigint AS "gameTime",
           CASE WHEN p."gradedAt" IS NULL THEN NULL ELSE round(extract(epoch FROM p."gradedAt") * 1000)::bigint END AS "gradedAt",
           p.status::text AS "status", p.units AS "units", p.odds AS "odds", s.name AS "sport"
    FROM picks p
    JOIN sports s ON s.id = p."sportId"
    WHERE p."userId" = ${scope.userId} AND p."capperId" = ${scope.capperId}
      AND p.status IN ('WIN', 'LOSS', 'PUSH')
    ORDER BY ${ORDER}
  `;
}
export const DECIDED_SERIES_ORDER_BY = Prisma.sql`"gameTime", "createdAt", id COLLATE "C"`;

export function narrowSeriesFromRows(rows: unknown[]): NarrowSeriesPick[] {
  return (rows as NarrowSeriesRow[]).map((r) => ({
    id: r.id,
    createdAt: new Date(Number(r.createdAt)),
    gameTime: new Date(Number(r.gameTime)),
    gradedAt: r.gradedAt === null ? null : new Date(Number(r.gradedAt)),
    status: r.status,
    units: Number(r.units),
    odds: Number(r.odds),
    sport: { name: r.sport },
  }));
}

export async function queryDecidedSeries(scope: { userId: string; capperId: string }): Promise<NarrowSeriesPick[]> {
  return narrowSeriesFromRows(await prisma.$queryRaw<NarrowSeriesRow[]>(decidedSeriesSelect(scope)));
}
