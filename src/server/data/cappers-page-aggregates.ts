// Everything the /cappers page shows, computed in the database in ONE statement (design:
// docs/design/dashboard-capper-detail-egress.md §3 - composable CTE fragments under
// a small per-instance connection pool, where every extra statement is another
// round trip queued behind the rest of the instance's work).
//
// The database filters, ranks, searches and paginates; the app receives only what is drawn:
// one page of leaderboard rows (LIMIT 20), the top-4 cards, the three panels' five rows, the overview
// numbers, and - only for the cappers actually displayed - their streaks, specialist candidates
// and last-20 sparkline series. No raw pick history reaches JS, and nothing here is cached
// across users (favorites are per-user).
//
// Numbers use the same derivations as the old page: window totals come from
// windowTotalsSelect (the fragment queryWindowTotals wraps), streaks from currentStreaksSelect,
// specialist tags from specialistCandidatesSelect + specialistTagsFromCandidateRows, and records
// are turned into RecordStats by the same statsFromRows/recordStatsFromTotals. ROI/units used as
// SORT keys are rounded in SQL with round2HalfUpSql (JS round2 semantics) so the order matches
// the old JS sort exactly. A WIN at odds = 0 makes the old JS units Infinity/NaN (see
// zeroOddsWinUnitsWon); the sort keys apply the same poisoning (uw_eff below), so the order always
// matches the displayed ROI / units, with NaN - which has no order - last.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  round2,
  weightedRoiScore,
  scorecardWindowRange,
  recordStatsFromTotals,
  RANKING_MIN_SAMPLE,
  SPECIALIST_CONCENTRATION_THRESHOLD,
  type ScorecardWindow,
} from "@/server/data/stats";
import {
  ORDER_DESC,
  WIN_UNITS,
  currentStreaksSelect,
  specialistCandidatesSelect,
  windowTotalsSelect,
  windowsCte,
  IN_WINDOW,
  type SpecialistCandidateRow,
  type StreakRow,
  type WindowTotals,
} from "@/server/data/capper-list-aggregates";
import { round2HalfUpSql } from "@/server/data/page-aggregate-fragments";
import { statsFromRows, specialistTagsFromCandidateRows } from "@/server/data/pick-aggregates-cappers-adapter";
import type { FavoriteCappersSummary, LeaderboardEntry } from "@/server/data/cappers";
import { PAGE_SIZE, type CappersSortKey } from "@/lib/cappers-page-params";
import { startOfEasternDay } from "@/lib/dates";
import {
  DEFAULT_PANEL_WINDOW,
  STREAK_LOOKBACK,
  STREAK_PANEL_MIN,
  FORM_LOOKBACK,
  TREND_RECENT,
  TREND_MIN_BASELINE,
  FORM_TREND_MIN_PTS,
  CONSISTENT_PICKS,
  CONSISTENT_BLOCKS,
  CONSISTENT_MIN_MEAN_PCT,
  FORM_PANEL_COUNT,
  type ActiveEntry,
  type ConsistentEntry,
  type FallingEntry,
  type PanelKey,
  type PanelRows,
  type PanelWindow,
  type StreakEntry,
  type WinnerEntry,
} from "@/lib/cappers-panels";
export * from "@/lib/cappers-panels";

export const SPARKLINE_PICKS = 20;
// Fewer graded picks than this draws a flat grey line and no net label.
export const SPARKLINE_MIN_PICKS = 3;
export const TOP_CAPPERS_COUNT = 4;
// Standout Cappers' own minimum graded picks (wins + losses + pushes) per page time window. It does
// NOT follow the leaderboard's min-picks dropdown. Tune here.
export const STANDOUT_MIN_GRADED: Record<ScorecardWindow, number> = {
  TODAY: 2,
  YESTERDAY: 2,
  LAST_7: 5,
  LAST_30: 10,
  LAST_60: 10,
  ALL: 10,
};
// The Standout sparkline is downsampled to about this many points (the net label stays exact).
const STANDOUT_SPARKLINE_MAX_POINTS = 60;
export const MOST_ACTIVE_COUNT = 5;
export const HOTTEST_COUNT = 5;
// Graded picks a capper needs in the week to be eligible for Hottest (one lucky bet can't top it).
export const HOTTEST_MIN_GRADED = 5;
const DAY_MS = 86400000;
// The stat cards' sparklines: this many rolling 7-day buckets ending now, oldest first.
export const STAT_WEEKS = 8;

export type CapperSparkline = {
  // Cumulative units after each of the capper's last (up to) 20 graded picks, oldest first,
  // starting from 0. Pushes are flat steps. The leaderboard's is not affected by the page's time
  // window; Standout's (CappersPageData.topSparklines) covers the selected window.
  points: number[];
  netUnits: number;
  // Graded picks behind the line (<= 20).
  n: number;
};

export type SparklineTone = "up" | "down" | "flat";
export function sparklineTone(s: CapperSparkline | undefined): SparklineTone {
  if (!s || s.n < SPARKLINE_MIN_PICKS || s.netUnits === 0) return "flat";
  return s.netUnits > 0 ? "up" : "down";
}


export type OverviewStats = {
  activeCappers: number;
  // Cappers with a pick posted in the last 7 days minus the 7 days before (whatever the time tab).
  activeCappersDelta: number;
  // Cappers on the roster added in the last 30 days.
  newCappersThisMonth: number;
  // One value per rolling week (STAT_WEEKS of them, oldest first), independent of the time tab:
  // roster size at each week's end (the CURRENT roster by date added - deleted / merged cappers
  // leave no history), cappers with a pick posted that week, picks posted that week, and the pooled
  // ROI and net units of the picks graded with a game that week.
  weekly: { tracked: number[]; active: number[]; picks: number[]; roi: number[]; net: number[] };
  picksThisWeek: number;
  // Percent change vs the 7 days before; null when last week had no picks.
  picksThisWeekPct: number | null;
  avgRoi: number;
  gradedPicks: number;
  // The selected window's pooled net units and record (the same totals avgRoi is computed from).
  netUnits: number;
  record: { wins: number; losses: number; pushes: number };
};

export type CappersPageQuery = {
  userId: string;
  window: ScorecardWindow;
  league?: string;
  min: number;
  sort: CappersSortKey;
  fav: boolean;
  q: string;
  page: number;
  now?: Date;
};

export type CappersPageData = {
  capperCount: number;
  overview: OverviewStats;
  rows: LeaderboardEntry[];
  // Rows matching the filters, across all pages.
  total: number;
  // The page actually returned (the requested one clamped to the last page).
  page: number;
  top: LeaderboardEntry[];
  sparklines: Map<string, CapperSparkline>;
  // Standout cards: each card's graded picks across the page's selected window (n = all of them).
  topSparklines: Map<string, CapperSparkline>;
  // The page's three panels. Hot Hand, Coldest and Falling off live on /dashboard (capper-panels.ts),
  // built from the same fragments below (panelSql, formLookupCte, fallingCte).
  mostActive: ActiveEntry[];
  winners: WinnerEntry[];
  consistent: ConsistentEntry[];
  favSummary: FavoriteCappersSummary | null;
};

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const ts = (d: Date) => Prisma.sql`${d.toISOString()}::timestamp`;

// The unitsWon the page DISPLAYS (statsFromRows -> zeroOddsWinUnitsWon): a WIN at odds = 0 makes
// it Infinity / -Infinity / NaN, and ROI and net units with it. The sort keys use exactly this,
// so "Sort by ROI" can never disagree with the ROI column. Shared with the Hottest card so a
// capper's units there are the same number as everywhere else.
export const uwEffSql = (a: string) => {
  const flags = Prisma.raw(`${a}."zeroOddsWinFlags"`);
  const uw = Prisma.raw(`${a}."unitsWon"`);
  return Prisma.sql`CASE WHEN ${flags} = 0 THEN ${uw}
                   WHEN (${flags} & 4) <> 0 OR (${flags} & 3) = 3 THEN 'NaN'::float8
                   WHEN (${flags} & 1) <> 0 THEN 'Infinity'::float8
                   ELSE '-Infinity'::float8 END`;
};

// Per-capper entries for one totals source: the roster joined to its window totals, then the sort
// keys. Same inclusion rules as buildLeaderboards: every window but ALL lists only cappers with a
// pick in the window; a sport scope lists only cappers who have a pick in that sport (`lroster`).
function entryCtes(name: string, totals: string, sportRoster: boolean, window: ScorecardWindow): [string, Prisma.Sql][] {
  const t = Prisma.raw(totals);
  const where: Prisma.Sql[] = [];
  if (sportRoster) where.push(Prisma.sql`r.id IN (SELECT cid FROM lroster)`);
  if (window !== "ALL") where.push(Prisma.sql`COALESCE(t."nPicks", 0) > 0`);
  return [
    [
      name,
      Prisma.sql`
        SELECT r.id AS cid, r.name, r."colorTag", r."isFavorite",
          COALESCE(t.wins, 0)::int AS wins, COALESCE(t.losses, 0)::int AS losses, COALESCE(t.pushes, 0)::int AS pushes,
          COALESCE(t."unitsWon", 0)::float8 AS "unitsWon", COALESCE(t."unitsLost", 0)::float8 AS "unitsLost",
          COALESCE(t."unitsRisked", 0)::float8 AS "unitsRisked", COALESCE(t."zeroOddsWinFlags", 0)::int AS "zeroOddsWinFlags"
        FROM roster r LEFT JOIN ${t} t ON t."capperId" = r.id
        ${where.length ? Prisma.sql`WHERE ${Prisma.join(where, " AND ")}` : Prisma.empty}
      `,
    ],
    [
      name + "_k",
      Prisma.sql`
        SELECT x.*, ${round2HalfUpSql(Prisma.sql`x.net_raw`)} AS net_r,
          CASE WHEN x."unitsRisked" > 0 THEN ${round2HalfUpSql(Prisma.sql`x.roi_raw`)} ELSE 0::float8 END AS roi_r
        FROM (
          SELECT e.*, e.wins + e.losses + e.pushes AS decided,
            e.uw_eff - e."unitsLost" AS net_raw,
            CASE WHEN e."unitsRisked" > 0 THEN (e.uw_eff - e."unitsLost") / e."unitsRisked" * 100::float8 ELSE 0::float8 END AS roi_raw,
            CASE WHEN e.wins + e.losses > 0 THEN e.wins::float8 / (e.wins + e.losses)::float8 * 100::float8 ELSE 0::float8 END AS win_pct
          FROM (
            SELECT e0.*,
              ${uwEffSql("e0")} AS uw_eff
            FROM ${Prisma.raw(name)} e0
          ) e
        ) x
      `,
    ],
  ];
}

// Sort keys are a fixed whitelist (never user text); every ranking ends in the same total-order
// tie-break as the old JS: units, then name, then id.
// NaN has no place in an order, so it sorts last (Postgres would otherwise put it first when descending).
const SORT_SQL: Record<CappersSortKey, Prisma.Sql> = {
  roi: Prisma.sql`(roi_r = 'NaN'::float8), roi_r DESC`,
  win: Prisma.sql`win_pct DESC`,
  units: Prisma.sql`(net_r = 'NaN'::float8), net_r DESC`,
  record: Prisma.sql`(wins - losses) DESC, wins DESC`,
};
const TIE_BREAK = Prisma.sql`(net_r = 'NaN'::float8), net_r DESC, lower(name) COLLATE "C", name COLLATE "C", cid COLLATE "C"`;

// A panel window as an instant range. "Today" is the Eastern calendar day so far; the others roll.
export function panelRange(w: PanelWindow, now: Date): { start: Date; end: Date } {
  if (w === "today") return { start: startOfEasternDay(now), end: now };
  return { start: new Date(now.getTime() - (w === "week" ? 7 : 30) * DAY_MS), end: now };
}

// The SELECT for one panel, reading a `roster` CTE (id, name, "colorTag", "isFavorite") - the page's
// statement has one, and getPanelRows builds one. Returns at most 5 rows, never a pick row.
//   active   - picks posted (datePosted) in the window, any status. Every row also carries
//              totalPicks: the window's picks across the whole roster, not just these five.
//   winners  - net units over graded picks posted in the window: >= HOTTEST_MIN_GRADED graded picks,
//              net units > 0, odds-0 win left out. This is the old "Hottest this week". Rows carry
//              the window's wins / losses too.
//   hottest / coldest - current WIN / LOSS streak (see streakPanelSql).
export function panelSql(panel: PanelKey, userId: string, range: { start: Date; end: Date }): Prisma.Sql {
  if (panel === "hottest" || panel === "coldest") return streakPanelSql(panel === "hottest" ? "WIN" : "LOSS", userId, range);
  if (panel === "active") {
    return Prisma.sql`
      SELECT r.id AS "capperId", r.name, r."colorTag", m.n AS "pickCount", (sum(m.n) OVER ())::int AS "totalPicks"
      FROM (SELECT p."capperId" AS cid, count(*)::int AS n FROM picks p WHERE p."userId" = ${userId} AND p."datePosted" >= ${ts(range.start)} GROUP BY p."capperId") m
      JOIN roster r ON r.id = m.cid
      ORDER BY m.n DESC, r."isFavorite" DESC, r.name, r.id
      LIMIT ${MOST_ACTIVE_COUNT}
    `;
  }
  // Net units over the window, graded picks only (pending/cancelled excluded, a push adds 0). Units
  // are the page's own expression (WIN_UNITS / unitsLost / uw_eff, rounded like the sort keys) and
  // ties use the page's tie order (TIE_BREAK). A non-finite value (odds = 0 win) has no label to
  // draw, so it is left out.
  return Prisma.sql`
    SELECT h.cid AS "capperId", h.name, h."colorTag", h.net_r AS "netUnits", h.wins, h.losses
    FROM (
      SELECT g.cid, r.name, r."colorTag", ${round2HalfUpSql(Prisma.sql`g.net_raw`)} AS net_r, g.wins, g.losses
      FROM (
        SELECT a.cid, a.wins, a.losses, ${uwEffSql("a")} - a."unitsLost" AS net_raw
        FROM (
          SELECT p."capperId" AS cid,
            (count(*) FILTER (WHERE p.status IN ('WIN', 'LOSS', 'PUSH')))::int AS graded,
            (count(*) FILTER (WHERE p.status = 'WIN'))::int AS wins,
            (count(*) FILTER (WHERE p.status = 'LOSS'))::int AS losses,
            COALESCE(sum(${WIN_UNITS}) FILTER (WHERE p.status = 'WIN' AND p.odds <> 0), 0)::float8 AS "unitsWon",
            COALESCE(sum(p.units) FILTER (WHERE p.status = 'LOSS'), 0)::float8 AS "unitsLost",
            COALESCE(bit_or(CASE WHEN p.units > 0 THEN 1 WHEN p.units < 0 THEN 2 ELSE 4 END) FILTER (WHERE p.status = 'WIN' AND p.odds = 0), 0)::int AS "zeroOddsWinFlags"
          FROM picks p
          WHERE p."userId" = ${userId} AND p."datePosted" >= ${ts(range.start)}
          GROUP BY p."capperId"
        ) a
        WHERE a.graded >= ${HOTTEST_MIN_GRADED}
      ) g
      JOIN roster r ON r.id = g.cid
    ) h
    WHERE h.net_r > 0 AND h.net_r < 'Infinity'::float8
    ORDER BY h.net_r DESC, lower(h.name) COLLATE "C", h.name COLLATE "C", h.cid COLLATE "C"
    LIMIT ${HOTTEST_COUNT}
  `;
}

// Hottest (kind WIN) / Coldest (kind LOSS): a capper's CURRENT consecutive streak, with the panel
// window used only as an eligibility filter (>= 1 graded pick with gradedAt and gameTime in the
// window). The streak counts only WIN/LOSS picks (a push or void
// neither extends nor breaks a run), newest first in ORDER_DESC (gameTime, createdAt, id) - see
// currentStreaksSelect - but read from the capper's whole history, bounded to STREAK_LOOKBACK picks
// per capper by a LATERAL index-ordered LIMIT (picks_user_capper_streak_idx).
// Ranked longest run first, then larger |units| over the run (Hottest: net win units; Coldest: units
// lost; odds-0 picks contribute nothing), then name. Coldest returns its units negated.
function streakPanelSql(kind: "WIN" | "LOSS", userId: string, range: { start: Date; end: Date }): Prisma.Sql {
  const units = kind === "WIN" ? WIN_UNITS : Prisma.sql`p.units`;
  const lostUnits = kind === "LOSS" ? Prisma.sql`, -${round2HalfUpSql(Prisma.sql`s.u`)} AS units` : Prisma.empty;
  return Prisma.sql`
    WITH el AS (
      SELECT DISTINCT p."capperId" AS cid
      FROM picks p
      WHERE p."userId" = ${userId} AND p.status IN ('WIN', 'LOSS', 'PUSH') AND p."gradedAt" IS NOT NULL
        AND p."gameTime" >= ${ts(range.start)} AND p."gameTime" < ${ts(range.end)}
    ),
    d AS (
      SELECT el.cid, q.st, q.units, q.odds,
        row_number() OVER (PARTITION BY el.cid ORDER BY q."gameTime" DESC, q."createdAt" DESC, q.id COLLATE "C" DESC) AS rn
      FROM el
      CROSS JOIN LATERAL (
        SELECT p.status::text AS st, p.units, p.odds, p."gameTime", p."createdAt", p.id
        FROM picks p
        WHERE p."userId" = ${userId} AND p."capperId" = el.cid AND p.status IN ('WIN', 'LOSS')
        ORDER BY ${ORDER_DESC}
        LIMIT ${STREAK_LOOKBACK}
      ) q
    ),
    run AS (
      SELECT d.cid, lead.st AS type,
        COALESCE(min(d.rn) FILTER (WHERE d.st <> lead.st) - 1, count(*))::int AS n
      FROM d JOIN d lead ON lead.cid = d.cid AND lead.rn = 1
      GROUP BY d.cid, lead.st
    ),
    s AS (
      SELECT run.cid, run.n, COALESCE(sum(${units}) FILTER (WHERE p.odds <> 0), 0)::float8 AS u
      FROM run JOIN d p ON p.cid = run.cid AND p.rn <= run.n
      WHERE run.type = ${kind} AND run.n >= ${STREAK_PANEL_MIN}
      GROUP BY run.cid, run.n
    )
    SELECT s.cid AS "capperId", r.name, r."colorTag", s.n AS streak${lostUnits}
    FROM s JOIN roster r ON r.id = s.cid
    ORDER BY s.n DESC, s.u DESC, lower(r.name) COLLATE "C", r.name COLLATE "C", r.id COLLATE "C"
    LIMIT ${HOTTEST_COUNT}
  `;
}

// Falling off / Most Consistent both read ONE bounded lookup of each roster capper's newest
// FORM_LOOKBACK decided picks (WIN / LOSS only; push, cancelled and pending are not decided), newest
// first in ORDER_DESC via the same LATERAL index-ordered LIMIT the streak panels use
// (picks_user_capper_streak_idx). They read the `roster` CTE, so they share the other panels' capper
// eligibility (test accounts left out), and ignore any time window. Each returns one [name, sql] CTE:
//   formLookupCte   dl (cid, win, gt, rn)  rn 1 = newest; gt = gameTime.
//   fallingCte      falling. recent = rn 1..TREND_RECENT, baseline = rn > TREND_RECENT (never the
//                   combined set). Needs exactly TREND_RECENT recent + >= TREND_MIN_BASELINE
//                   baseline; score = recent win% - baseline win%. Keeps scores that round to
//                   -FORM_TREND_MIN_PTS or less, worst first; ties by larger baseline, then id.
//                   Rows carry pts (the score in whole percentage points, negative), baseline (the
//                   baseline win rate as a fraction) and results (the recent picks' win flags,
//                   oldest first), all read from dl: the chart is drawn from those (trendSeries).
//   consistentCte   the newest CONSISTENT_PICKS (all required) as CONSISTENT_BLOCKS equal blocks, oldest
//                   first; mean block win% >= CONSISTENT_MIN_MEAN_PCT. Ranked by population standard
//                   deviation of the block win%s ascending, then higher mean, then id.
// Scores are numeric (exact) and rounded to 9 places so equal fractions tie instead of differing by
// float noise. Consistent rows carry sd (that standard deviation), which the confidence score is
// derived from (consistencyScore).
export function formLookupCte(userId: string): [string, Prisma.Sql] {
  return [
    "dl",
    Prisma.sql`
      SELECT r.id AS cid, q.win, q."gameTime" AS gt,
        row_number() OVER (PARTITION BY r.id ORDER BY q."gameTime" DESC, q."createdAt" DESC, q.id COLLATE "C" DESC) AS rn
      FROM roster r
      CROSS JOIN LATERAL (
        SELECT (p.status = 'WIN') AS win, p."gameTime", p."createdAt", p.id
        FROM picks p
        WHERE p."userId" = ${userId} AND p."capperId" = r.id AND p.status IN ('WIN', 'LOSS')
        ORDER BY ${ORDER_DESC}
        LIMIT ${FORM_LOOKBACK}
      ) q
    `,
  ];
}

export function fallingCte(): [string, Prisma.Sql] {
  const score = Prisma.sql`round(s.rw::numeric / s.rn_n - s.bw::numeric / s.bn, 9)`;
  return [
    "falling",
    Prisma.sql`
      SELECT t.cid AS "capperId", t.name, t."colorTag", round(t.score * 100)::int AS pts, t.baseline::float8 AS baseline,
        (SELECT array_agg(d.win ORDER BY d.rn DESC) FROM dl d WHERE d.cid = t.cid AND d.rn <= ${TREND_RECENT}::int) AS results
      FROM (
        SELECT s.cid, r.name, r."colorTag", s.bn, round(s.bw::numeric / s.bn, 9) AS baseline,
          ${score} AS score
        FROM (
          SELECT cid,
            count(*) FILTER (WHERE rn <= ${TREND_RECENT}::int) AS rn_n,
            count(*) FILTER (WHERE rn <= ${TREND_RECENT}::int AND win) AS rw,
            count(*) FILTER (WHERE rn > ${TREND_RECENT}::int) AS bn,
            count(*) FILTER (WHERE rn > ${TREND_RECENT}::int AND win) AS bw
          FROM dl GROUP BY cid
        ) s
        JOIN roster r ON r.id = s.cid
        WHERE s.rn_n = ${TREND_RECENT}::int AND s.bn >= ${TREND_MIN_BASELINE}::int
          AND round(${score} * 100) <= -${FORM_TREND_MIN_PTS}::int
        ORDER BY score ASC, s.bn DESC, r.id COLLATE "C"
        LIMIT ${FORM_PANEL_COUNT}
      ) t
      ORDER BY t.score ASC, t.bn DESC, t.cid COLLATE "C"
    `,
  ];
}

export function consistentCte(): [string, Prisma.Sql] {
  const blockSize = CONSISTENT_PICKS / CONSISTENT_BLOCKS;
  return [
    "consistent",
    Prisma.sql`
      SELECT b.cid AS "capperId", r.name, r."colorTag", b.blocks, b.sd::float8 AS sd
      FROM (
        SELECT cid, sum(n) AS n, sum(w) AS tw,
          round(stddev_pop(w::numeric * 100 / n), 9) AS sd,
          array_agg(round(w::numeric * 100 / n, 4)::float8 ORDER BY blk) AS blocks
        FROM (
          SELECT cid, blk, count(*) AS n, count(*) FILTER (WHERE win) AS w
          FROM (
            SELECT cid, win, (${CONSISTENT_PICKS}::int - rn) / ${blockSize}::int AS blk
            FROM dl WHERE rn <= ${CONSISTENT_PICKS}::int
          ) y
          GROUP BY cid, blk
        ) x
        GROUP BY cid
      ) b
      JOIN roster r ON r.id = b.cid
      WHERE b.n = ${CONSISTENT_PICKS}::int
        AND b.tw::numeric * 100 / b.n >= ${CONSISTENT_MIN_MEAN_PCT}::int
      ORDER BY b.sd ASC, b.tw DESC, r.id COLLATE "C"
      LIMIT ${FORM_PANEL_COUNT}
    `,
  ];
}

// jsonb rows -> typed rows, shared by the page statement, the dropdown fetch and the dashboard.
export const streakEntriesFromRows = (rows: any[] | undefined, withUnits: boolean): StreakEntry[] =>
  (rows ?? []).map((h) => ({ capperId: h.capperId, name: h.name, colorTag: h.colorTag, streak: Number(h.streak), ...(withUnits ? { units: Number(h.units) } : {}) }));
export const fallingEntriesFromRows = (rows: any[] | undefined): FallingEntry[] =>
  (rows ?? []).map((h) => ({ capperId: h.capperId, name: h.name, colorTag: h.colorTag, pts: Number(h.pts), results: (h.results ?? []).map(Boolean), baseline: Number(h.baseline) }));

// One panel at one window, as its own small statement (the dropdown's fetch). Same SQL as the page.
export async function getPanelRows(q: { userId: string; panel: PanelKey; window: PanelWindow; now?: Date }): Promise<PanelRows> {
  const range = panelRange(q.window, q.now ?? new Date());
  const rows = await prisma.$queryRaw<any[]>(Prisma.sql`
    WITH roster AS (SELECT id, name, "colorTag", "isFavorite" FROM cappers WHERE "userId" = ${q.userId} AND NOT "isTest"),
    pnl AS (${panelSql(q.panel, q.userId, range)})
    SELECT * FROM pnl
  `);
  return rows.map((r) => ({
    ...r,
    ...(r.pickCount === undefined ? {} : { pickCount: Number(r.pickCount), totalPicks: Number(r.totalPicks) }),
    ...(r.netUnits === undefined ? {} : { netUnits: Number(r.netUnits), wins: Number(r.wins), losses: Number(r.losses) }),
    ...(r.streak === undefined ? {} : { streak: Number(r.streak) }),
    ...(r.units === undefined ? {} : { units: Number(r.units) }),
  }));
}

export function buildCappersPageQuery(q: CappersPageQuery): Prisma.Sql {
  const now = q.now ?? new Date();
  const range = scorecardWindowRange(q.window, now);
  // weekEdges[i]..weekEdges[i + 1] is stat-card week i (oldest first); the last edge is now.
  const weekEdges = Array.from({ length: STAT_WEEKS + 1 }, (_, i) => new Date(now.getTime() - (STAT_WEEKS - i) * 7 * DAY_MS));
  const weekEnds = Prisma.join(weekEdges.slice(1).map((d, i) => Prisma.sql`(${i}::int, ${ts(d)})`));

  const ctes: [string, Prisma.Sql][] = [];
  const add = (name: string, sql: Prisma.Sql) => ctes.push([name, sql]);

  add("roster", Prisma.sql`SELECT id, name, "colorTag", "isFavorite", "createdAt" FROM cappers WHERE "userId" = ${q.userId} AND NOT "isTest"`);
  add("ut", windowTotalsSelect({ userId: q.userId }));
  add("ut_r", Prisma.sql`SELECT * FROM ut WHERE "capperId" IN (SELECT id FROM roster)`);
  if (q.league) {
    add("lroster", Prisma.sql`SELECT DISTINCT p."capperId" AS cid FROM picks p WHERE p."userId" = ${q.userId} AND p."sportId" IN (SELECT id FROM sports WHERE name = ${q.league})`);
    add("lt", windowTotalsSelect({ userId: q.userId, sportName: q.league }));
  }
  ctes.push(...entryCtes("e", q.league ? "lt" : "ut", !!q.league, q.window));
  // The unscoped roster for Top cappers: with no league it is the same CTE.
  const unscoped = q.league ? "eu_k" : "e_k";
  if (q.league) ctes.push(...entryCtes("eu", "ut", false, q.window));

  // Leaderboard: filter -> rank -> page, all in SQL. `total` rides on every ranked row so the
  // page clamp and the footer count need no second query.
  const filters: Prisma.Sql[] = [Prisma.sql`decided >= ${q.min}`];
  if (q.fav) filters.push(Prisma.sql`"isFavorite"`);
  if (q.q.trim()) filters.push(Prisma.sql`strpos(lower(name), lower(${q.q.trim()})) > 0`);
  add(
    "fil",
    Prisma.sql`
      SELECT e_k.*, row_number() OVER (ORDER BY ${SORT_SQL[q.sort]}, ${TIE_BREAK}) AS rn, count(*) OVER () AS total
      FROM e_k WHERE ${Prisma.join(filters, " AND ")}
    `
  );
  const lastPage = Prisma.sql`GREATEST(1, CEIL(total::float8 / ${PAGE_SIZE}::float8)::int)`;
  const pageNo = Prisma.sql`LEAST(${Math.max(1, q.page)}::int, ${lastPage})`;
  add("pg", Prisma.sql`SELECT * FROM fil WHERE rn > (${pageNo} - 1) * ${PAGE_SIZE} AND rn <= ${pageNo} * ${PAGE_SIZE}`);

  // Standout cappers: the selected window's own built-in minimum (STANDOUT_MIN_GRADED, never the
  // leaderboard's dropdown). Qualify only with net units > 0 AND wins > losses; an odds-0 win makes
  // net units non-finite and is left out. Ranked by net units, then win %, then graded picks.
  // Nobody qualifying yields no rows - there is no fallback to a non-qualifying capper.
  add(
    "top",
    Prisma.sql`
      SELECT * FROM ${Prisma.raw(unscoped)}
      WHERE decided >= ${STANDOUT_MIN_GRADED[q.window]} AND net_r > 0 AND net_r < 'Infinity'::float8 AND wins > losses
      ORDER BY net_r DESC, win_pct DESC, decided DESC, ${TIE_BREAK}
      LIMIT ${TOP_CAPPERS_COUNT}`
  );
  add("disp", Prisma.sql`SELECT cid FROM pg`);

  // Streaks: every capper's (unscoped) streak, computed once; the leaderboard rows and the Standout
  // cards read theirs from it, or - with a league - the rows read a league-scoped one for the page's
  // cappers only.
  add("st_u", currentStreaksSelect({ userId: q.userId, windows: [q.window], now }));
  add(
    "st",
    q.league
      ? currentStreaksSelect({ userId: q.userId, sportName: q.league, windows: [q.window], now, onlyCappersFrom: "pg" })
      : Prisma.sql`SELECT * FROM st_u WHERE "capperId" IN (SELECT cid FROM pg)`
  );
  add("sp", specialistCandidatesSelect({ userId: q.userId, sportName: q.league, minShare: SPECIALIST_CONCENTRATION_THRESHOLD, minSample: RANKING_MIN_SAMPLE, onlyCappersFrom: "pg" }));

  // Sparkline: each displayed capper's last 20 graded picks (WIN/LOSS/PUSH; pending and cancelled
  // excluded) newest-first in the canonical (gameTime, createdAt, id) order, then a running sum
  // oldest-first. A push contributes 0.
  add(
    "sl",
    Prisma.sql`
      SELECT cid AS "capperId", count(*)::int AS n, jsonb_agg(cum ORDER BY rn DESC) AS pts
      FROM (
        SELECT cid, rn, sum(delta) OVER (PARTITION BY cid ORDER BY rn DESC) AS cum
        FROM (
          SELECT p."capperId" AS cid,
            CASE p.status WHEN 'WIN' THEN COALESCE(${WIN_UNITS}, 0) WHEN 'LOSS' THEN -p.units ELSE 0 END::float8 AS delta,
            row_number() OVER (PARTITION BY p."capperId" ORDER BY ${ORDER_DESC}) AS rn
          FROM picks p
          WHERE p."userId" = ${q.userId} AND p."capperId" IN (SELECT cid FROM disp) AND p.status IN ('WIN', 'LOSS', 'PUSH')
        ) r
        WHERE rn <= ${SPARKLINE_PICKS}
      ) s
      GROUP BY cid
    `
  );

  // Standout sparklines: the same graded picks the card's record is built from (the page window's
  // predicate, WIN/LOSS/PUSH), as a running net-units sum oldest-first, thinned to ~60 points.
  add(
    "tsl",
    Prisma.sql`
      SELECT cid AS "capperId", max(i)::int AS n, jsonb_agg(cum ORDER BY i) FILTER (WHERE i % step = 0 OR i = cnt) AS pts
      FROM (
        SELECT cid, i, cnt, cum, GREATEST(1, CEIL(cnt::float8 / ${STANDOUT_SPARKLINE_MAX_POINTS}::float8)::int) AS step
        FROM (
          SELECT cid, i, cum, max(i) OVER (PARTITION BY cid) AS cnt
          FROM (
            SELECT cid, row_number() OVER (PARTITION BY cid ORDER BY gt, ca, id) AS i,
              sum(delta) OVER (PARTITION BY cid ORDER BY gt, ca, id) AS cum
            FROM (
              SELECT p."capperId" AS cid, p."gameTime" AS gt, p."createdAt" AS ca, p.id COLLATE "C" AS id,
                CASE p.status WHEN 'WIN' THEN COALESCE(${WIN_UNITS}, 0) WHEN 'LOSS' THEN -p.units ELSE 0 END::float8 AS delta
              FROM picks p
              JOIN w ON ${IN_WINDOW}
              WHERE p."userId" = ${q.userId} AND p."capperId" IN (SELECT cid FROM top) AND p.status IN ('WIN', 'LOSS', 'PUSH')
            ) g
          ) r
        ) c
      ) t
      GROUP BY cid
    `
  );
  // The two windowed panels at the default "This week" window (see panelSql; the dropdown fetches one
  // panel at another window through getPanelRows), and the windowless Most Consistent.
  const weekRange = panelRange(DEFAULT_PANEL_WINDOW, now);
  add("ma", panelSql("active", q.userId, weekRange));
  add("win", panelSql("winners", q.userId, weekRange));
  ctes.push(formLookupCte(q.userId), consistentCte());
  // Streaks for the Standout cards (always the unscoped roster, like the cards themselves).
  add("stt", Prisma.sql`SELECT * FROM st_u WHERE "capperId" IN (SELECT cid FROM top)`);

  // Overview: counts by datePosted (activity), pooled money totals from the per-capper totals.
  const curFilter = range ? Prisma.sql`p."datePosted" >= ${ts(range.start)} AND p."datePosted" < ${ts(range.end)}` : Prisma.sql`true`;
  // The same scan feeds the weekly series, so its lower bound reaches back STAT_WEEKS weeks (by
  // either date: the ROI series buckets by gameTime, the counts by datePosted).
  const oldest = ts(new Date(Math.min(range ? range.start.getTime() : Infinity, weekEdges[0].getTime())));
  const lowerBound = range ? Prisma.sql`AND (p."datePosted" >= ${oldest} OR p."gameTime" >= ${oldest})` : Prisma.empty;
  const weekOf = (col: string) => Prisma.sql`floor(extract(epoch FROM p.${Prisma.raw(col)} - k.t0) / ${7 * 86400}::int)::int`;
  // The one scan of the roster's picks, reduced to a row per capper x week posted x week graded
  // (dw / gw: 0 = oldest stat-card week, NULL = outside them; gw also NULL when not graded), then
  // rolled up three ways in one pass: g = 3 everything (the tab's active cappers), g = 1 per week
  // posted, g = 2 per week graded. OFFSET 0 keeps the week origin a value computed once rather than
  // a text-to-timestamp cast repeated for every pick.
  add(
    "ag",
    Prisma.sql`
      SELECT GROUPING(c.dw, c.gw)::int AS g, c.dw, c.gw,
        COALESCE(sum(c.n), 0)::int AS n,
        count(DISTINCT c.cid)::int AS nc,
        (count(DISTINCT c.cid) FILTER (WHERE c.cur))::int AS cur,
        COALESCE(sum(c.uw), 0)::float8 AS uw, COALESCE(sum(c.ul), 0)::float8 AS ul, COALESCE(sum(c.ur), 0)::float8 AS ur
      FROM (
        SELECT x.cid, x.dw, x.gw, x.cur, count(*) AS n,
          sum(x.win_units) FILTER (WHERE x.status = 'WIN' AND x.odds <> 0) AS uw,
          sum(x.units) FILTER (WHERE x.status = 'LOSS') AS ul,
          sum(x.units) FILTER (WHERE x.status IN ('WIN', 'LOSS', 'PUSH')) AS ur
        FROM (
          SELECT p."capperId" AS cid, p.status, p.units, p.odds, ${WIN_UNITS} AS win_units, (${curFilter}) AS cur,
            CASE WHEN ${weekOf('"datePosted"')} BETWEEN 0 AND ${STAT_WEEKS - 1} THEN ${weekOf('"datePosted"')} END AS dw,
            CASE WHEN p."gradedAt" IS NOT NULL AND ${weekOf('"gameTime"')} BETWEEN 0 AND ${STAT_WEEKS - 1} THEN ${weekOf('"gameTime"')} END AS gw
          FROM picks p CROSS JOIN (SELECT ${ts(weekEdges[0])} AS t0 OFFSET 0) k
          WHERE p."userId" = ${q.userId} AND p."capperId" IN (SELECT id FROM roster) ${lowerBound}
        ) x
        GROUP BY x.cid, x.dw, x.gw, x.cur
      ) c
      GROUP BY GROUPING SETS ((), (c.dw), (c.gw))
    `
  );
  add(
    "ov",
    Prisma.sql`
      SELECT
        (SELECT count(*) FROM roster)::int AS "capperCount",
        (SELECT count(*) FROM roster WHERE "isFavorite")::int AS "favCount",
        (SELECT count(*) FROM roster WHERE "createdAt" >= ${ts(new Date(now.getTime() - 30 * DAY_MS))})::int AS "newMonth",
        (SELECT jsonb_agg((SELECT count(*) FROM roster r WHERE r."createdAt" < e.t)::int ORDER BY e.k) FROM (VALUES ${weekEnds}) e(k, t)) AS wk_tracked,
        (SELECT cur FROM ag WHERE g = 3) AS cur,
        (SELECT jsonb_agg(jsonb_build_array(dw, n, nc)) FROM ag WHERE g = 1 AND dw IS NOT NULL) AS wk_posted,
        (SELECT jsonb_agg(jsonb_build_array(gw, uw, ul, ur)) FROM ag WHERE g = 2 AND gw IS NOT NULL) AS wk_graded,
        (SELECT COALESCE(sum(wins), 0) FROM ut_r)::int AS wins, (SELECT COALESCE(sum(losses), 0) FROM ut_r)::int AS losses,
        (SELECT COALESCE(sum(pushes), 0) FROM ut_r)::int AS pushes,
        (SELECT COALESCE(sum("unitsWon"), 0) FROM ut_r)::float8 AS "unitsWon", (SELECT COALESCE(sum("unitsLost"), 0) FROM ut_r)::float8 AS "unitsLost",
        (SELECT COALESCE(sum("unitsRisked"), 0) FROM ut_r)::float8 AS "unitsRisked"
    `
  );
  if (q.fav) add("fs", windowTotalsSelect({ userId: q.userId, favoritesOnly: true, pooled: true }));

  const outputs = ["ov", "pg", "top", "st", "stt", "sp", "sl", "tsl", "ma", "win", "consistent", ...(q.fav ? ["fs"] : [])];
  return Prisma.sql`
    WITH ${windowsCte([q.window], now)},
    ${Prisma.join(
      ctes.map(([name, sql]) => Prisma.sql`${Prisma.raw(name)} AS (${sql})`),
      ",\n"
    )}
    SELECT jsonb_build_object(${Prisma.join(
      outputs.map((n) => Prisma.sql`${n}::text, COALESCE((SELECT jsonb_agg(to_jsonb(o)) FROM ${Prisma.raw(n)} o), '[]'::jsonb)`),
      ", "
    )}) AS out
  `;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

type EntryRow = {
  cid: string;
  name: string;
  colorTag: string | null;
  isFavorite: boolean;
  wins: number;
  losses: number;
  pushes: number;
  unitsWon: number;
  unitsLost: number;
  unitsRisked: number;
  zeroOddsWinFlags: number;
  total?: number | string;
};

function totalsOf(r: Pick<EntryRow, "wins" | "losses" | "pushes" | "unitsWon" | "unitsLost" | "unitsRisked" | "zeroOddsWinFlags">, window: ScorecardWindow): WindowTotals {
  return { capperId: null, window, nPicks: 0, ...r };
}

function entryOf(r: EntryRow, window: ScorecardWindow, streak: StreakRow | undefined, specialist: LeaderboardEntry["specialist"]): LeaderboardEntry {
  const stats = statsFromRows(totalsOf(r, window), streak);
  return { capperId: r.cid, name: r.name, colorTag: r.colorTag, stats, weightedScore: weightedRoiScore(stats), specialist, isFavorite: r.isFavorite };
}

export async function getCappersPageData(q: CappersPageQuery): Promise<CappersPageData> {
  const now = q.now ?? new Date();
  const rows = await prisma.$queryRaw<{ out: Record<string, any[]> }[]>(buildCappersPageQuery({ ...q, now }));
  const out = rows[0]?.out ?? {};
  const ov = out.ov?.[0] ?? {};

  const streaks = new Map<string, StreakRow>((out.st ?? []).map((s: StreakRow) => [s.capperId, s]));
  const topStreaks = new Map<string, StreakRow>((out.stt ?? []).map((s: StreakRow) => [s.capperId, s]));
  const specialists = specialistTagsFromCandidateRows((out.sp ?? []) as SpecialistCandidateRow[]);
  const pg = (out.pg ?? []) as EntryRow[];
  const total = pg.length ? Number(pg[0].total) : 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const seriesMap = (rows: any[] | undefined) => {
    const m = new Map<string, CapperSparkline>();
    for (const s of rows ?? []) {
      const pts = (s.pts as number[]).map(Number);
      m.set(s.capperId, { points: [0, ...pts], netUnits: round2(pts[pts.length - 1] ?? 0), n: Number(s.n) });
    }
    return m;
  };
  const sparklines = seriesMap(out.sl);
  const topSparklines = seriesMap(out.tsl);

  const pooled = recordStatsFromTotals({
    wins: ov.wins ?? 0,
    losses: ov.losses ?? 0,
    pushes: ov.pushes ?? 0,
    unitsWon: ov.unitsWon ?? 0,
    unitsLost: ov.unitsLost ?? 0,
    unitsRisked: ov.unitsRisked ?? 0,
  });
  // Weekly rows: [week, picks posted, cappers posting] and [week, units won, lost, risked].
  const weekly = (rows: unknown, col: number) => {
    const out = Array.from({ length: STAT_WEEKS }, () => 0);
    for (const r of (rows as number[][] | null) ?? []) out[Number(r[0])] = Number(r[col]);
    return out;
  };
  const series = (v: unknown) => Array.from({ length: STAT_WEEKS }, (_, i) => Number((v as unknown[] | null)?.[i] ?? 0));
  const wkPicks = weekly(ov.wk_posted, 1);
  const wkActive = weekly(ov.wk_posted, 2);
  const wkUw = weekly(ov.wk_graded, 1);
  const wkUl = weekly(ov.wk_graded, 2);
  const wkUr = weekly(ov.wk_graded, 3);
  // The last two weeks are "this week" and "last week" (rolling 7 days ending now).
  const week = wkPicks[STAT_WEEKS - 1];
  const prior = wkPicks[STAT_WEEKS - 2];

  let favSummary: FavoriteCappersSummary | null = null;
  if (q.fav && Number(ov.favCount ?? 0) > 0) {
    // The pooled collectiveStats.currentStreak is never read (see FavoriteCappersSummary).
    favSummary = { collectiveStats: statsFromRows(out.fs?.[0] ? totalsOf(out.fs[0], q.window) : undefined, undefined), entries: [] };
  }

  return {
    capperCount: Number(ov.capperCount ?? 0),
    overview: {
      activeCappers: Number(ov.cur ?? 0),
      activeCappersDelta: wkActive[STAT_WEEKS - 1] - wkActive[STAT_WEEKS - 2],
      newCappersThisMonth: Number(ov.newMonth ?? 0),
      weekly: {
        tracked: series(ov.wk_tracked),
        active: wkActive,
        picks: wkPicks,
        roi: wkUr.map((ur, i) => (ur > 0 ? round2(((wkUw[i] - wkUl[i]) / ur) * 100) : 0)),
        net: wkUw.map((uw, i) => round2(uw - wkUl[i])),
      },
      picksThisWeek: week,
      picksThisWeekPct: prior > 0 ? Math.round(((week - prior) / prior) * 1000) / 10 : null,
      avgRoi: pooled.roi,
      gradedPicks: pooled.wins + pooled.losses + pooled.pushes,
      netUnits: pooled.netUnits,
      record: { wins: pooled.wins, losses: pooled.losses, pushes: pooled.pushes },
    },
    rows: pg.map((r) => entryOf(r, q.window, streaks.get(r.cid), specialists.get(r.cid) ?? null)),
    total,
    page: Math.min(Math.max(1, q.page), lastPage),
    top: ((out.top ?? []) as EntryRow[]).map((r) => entryOf(r, q.window, topStreaks.get(r.cid), null)),
    sparklines,
    topSparklines,
    mostActive: (out.ma ?? []).map((m: ActiveEntry) => ({ capperId: m.capperId, name: m.name, colorTag: m.colorTag, pickCount: Number(m.pickCount), totalPicks: Number(m.totalPicks) })),
    winners: (out.win ?? []).map((h: WinnerEntry) => ({ capperId: h.capperId, name: h.name, colorTag: h.colorTag, netUnits: Number(h.netUnits), wins: Number(h.wins), losses: Number(h.losses) })),
    consistent: (out.consistent ?? []).map((h: ConsistentEntry) => ({ capperId: h.capperId, name: h.name, colorTag: h.colorTag, blocks: (h.blocks ?? []).map(Number), sd: Number(h.sd) })),
    favSummary,
  };
}
