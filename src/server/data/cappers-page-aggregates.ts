// Everything the /cappers page shows, computed in the database in ONE statement (design:
// docs/design/dashboard-capper-detail-egress.md §3 - composable CTE fragments under
// connection_limit=1, where every extra statement is another serial round trip).
//
// The database filters, ranks, searches and paginates; the app receives only what is drawn:
// one page of leaderboard rows (LIMIT 20), the top-4 cards, five most-active rows, the overview
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
  type SpecialistCandidateRow,
  type StreakRow,
  type WindowTotals,
} from "@/server/data/capper-list-aggregates";
import { round2HalfUpSql } from "@/server/data/page-aggregate-fragments";
import { statsFromRows, specialistTagsFromCandidateRows } from "@/server/data/pick-aggregates-cappers-adapter";
import type { ActivityEntry, FavoriteCappersSummary, LeaderboardEntry } from "@/server/data/cappers";
import { PAGE_SIZE, type CappersSortKey } from "@/lib/cappers-page-params";
import { startOfEasternDay } from "@/lib/dates";
import {
  DEFAULT_PANEL_WINDOW,
  STREAK_LOOKBACK,
  STREAK_PANEL_MIN,
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
export const HOT_STREAK_MIN = 5;
export const TOP_CAPPERS_COUNT = 4;
export const MOST_ACTIVE_COUNT = 5;
export const HOTTEST_COUNT = 5;
// Graded picks a capper needs in the week to be eligible for Hottest (one lucky bet can't top it).
export const HOTTEST_MIN_GRADED = 5;
const DAY_MS = 86400000;

export type CapperSparkline = {
  // Cumulative units after each of the capper's last (up to) 20 graded picks, oldest first,
  // starting from 0. Pushes are flat steps. Not affected by the page's time window.
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
  // Change against the immediately preceding period of the same length; null for ALL.
  activeCappersDelta: number | null;
  picksThisWeek: number;
  // Percent change vs the 7 days before; null when last week had no picks.
  picksThisWeekPct: number | null;
  avgRoi: number;
  gradedPicks: number;
  hotStreaks: number;
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
  mostActive: ActivityEntry[];
  hottest: StreakEntry[];
  winners: WinnerEntry[];
  coldest: StreakEntry[];
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
//   active   - picks posted (datePosted) in the window, any status.
//   winners  - net units over graded picks posted in the window: >= HOTTEST_MIN_GRADED graded picks,
//              net units > 0, odds-0 win left out. This is the old "Hottest this week".
//   hottest / coldest - current WIN / LOSS streak (see streakPanelSql).
export function panelSql(panel: PanelKey, userId: string, range: { start: Date; end: Date }): Prisma.Sql {
  if (panel === "hottest" || panel === "coldest") return streakPanelSql(panel === "hottest" ? "WIN" : "LOSS", userId, range);
  if (panel === "active") {
    return Prisma.sql`
      SELECT r.id AS "capperId", r.name, r."colorTag", m.n AS "pickCount"
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
    SELECT h.cid AS "capperId", h.name, h."colorTag", h.net_r AS "netUnits"
    FROM (
      SELECT g.cid, r.name, r."colorTag", ${round2HalfUpSql(Prisma.sql`g.net_raw`)} AS net_r
      FROM (
        SELECT a.cid, ${uwEffSql("a")} - a."unitsLost" AS net_raw
        FROM (
          SELECT p."capperId" AS cid,
            (count(*) FILTER (WHERE p.status IN ('WIN', 'LOSS', 'PUSH')))::int AS graded,
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
// window). The streak is the one the "Hot streaks" stat counts: only WIN/LOSS picks (a push or void
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

// One panel at one window, as its own small statement (the dropdown's fetch). Same SQL as the page.
export async function getPanelRows(q: { userId: string; panel: PanelKey; window: PanelWindow; now?: Date }): Promise<PanelRows> {
  const range = panelRange(q.window, q.now ?? new Date());
  const rows = await prisma.$queryRaw<any[]>(Prisma.sql`
    WITH roster AS (SELECT id, name, "colorTag", "isFavorite" FROM cappers WHERE "userId" = ${q.userId}),
    pnl AS (${panelSql(q.panel, q.userId, range)})
    SELECT * FROM pnl
  `);
  return rows.map((r) => ({
    ...r,
    ...(r.pickCount === undefined ? {} : { pickCount: Number(r.pickCount) }),
    ...(r.netUnits === undefined ? {} : { netUnits: Number(r.netUnits) }),
    ...(r.streak === undefined ? {} : { streak: Number(r.streak) }),
    ...(r.units === undefined ? {} : { units: Number(r.units) }),
  }));
}

export function buildCappersPageQuery(q: CappersPageQuery): Prisma.Sql {
  const now = q.now ?? new Date();
  const range = scorecardWindowRange(q.window, now);
  const previous = range ? { start: new Date(range.start.getTime() - (range.end.getTime() - range.start.getTime())), end: range.start } : null;
  const weekStart = new Date(now.getTime() - 7 * DAY_MS);
  const priorWeekStart = new Date(now.getTime() - 14 * DAY_MS);

  const ctes: [string, Prisma.Sql][] = [];
  const add = (name: string, sql: Prisma.Sql) => ctes.push([name, sql]);

  add("roster", Prisma.sql`SELECT id, name, "colorTag", "isFavorite" FROM cappers WHERE "userId" = ${q.userId}`);
  add("ut", windowTotalsSelect({ userId: q.userId }));
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

  // Top cappers: same minimum-picks rule, but never below one decided pick (no ROI otherwise).
  add(
    "top",
    Prisma.sql`SELECT * FROM ${Prisma.raw(unscoped)} WHERE decided >= ${Math.max(q.min, 1)} ORDER BY (roi_r = 'NaN'::float8), roi_r DESC, ${TIE_BREAK} LIMIT ${TOP_CAPPERS_COUNT}`
  );
  add("disp", Prisma.sql`SELECT cid FROM pg UNION SELECT cid FROM top`);

  // Streaks: the hot-streaks card needs every capper's (unscoped) streak, computed once; the
  // leaderboard rows read theirs from it, or - with a league - a league-scoped one for the page's
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

  // The four panels, all at the default "This week" window (see panelSql; the dropdown fetches one
  // panel at another window through getPanelRows).
  const weekRange = panelRange(DEFAULT_PANEL_WINDOW, now);
  add("ma", panelSql("active", q.userId, weekRange));
  add("hot", panelSql("hottest", q.userId, weekRange));
  add("win", panelSql("winners", q.userId, weekRange));
  add("cold", panelSql("coldest", q.userId, weekRange));
  // Streaks for the Standout cards (always the unscoped roster, like the cards themselves).
  add("stt", Prisma.sql`SELECT * FROM st_u WHERE "capperId" IN (SELECT cid FROM top)`);

  // Overview: counts by datePosted (activity), pooled money totals from the per-capper totals.
  const curFilter = range ? Prisma.sql`p."datePosted" >= ${ts(range.start)} AND p."datePosted" < ${ts(range.end)}` : Prisma.sql`true`;
  const prevFilter = previous ? Prisma.sql`p."datePosted" >= ${ts(previous.start)} AND p."datePosted" < ${ts(previous.end)}` : Prisma.sql`false`;
  const lowerBound = range ? Prisma.sql`AND p."datePosted" >= ${ts(new Date(Math.min(previous!.start.getTime(), priorWeekStart.getTime())))}` : Prisma.empty;
  add(
    "ov",
    Prisma.sql`
      SELECT
        (SELECT count(*) FROM roster)::int AS "capperCount",
        (SELECT count(*) FROM roster WHERE "isFavorite")::int AS "favCount",
        a.cur, a.prev, a.week, a.prior,
        (SELECT COALESCE(sum(wins), 0) FROM ut)::int AS wins, (SELECT COALESCE(sum(losses), 0) FROM ut)::int AS losses,
        (SELECT COALESCE(sum(pushes), 0) FROM ut)::int AS pushes,
        (SELECT COALESCE(sum("unitsWon"), 0) FROM ut)::float8 AS "unitsWon", (SELECT COALESCE(sum("unitsLost"), 0) FROM ut)::float8 AS "unitsLost",
        (SELECT COALESCE(sum("unitsRisked"), 0) FROM ut)::float8 AS "unitsRisked",
        (SELECT count(*) FROM st_u WHERE type = 'WIN' AND "count" >= ${HOT_STREAK_MIN})::int AS hot
      FROM (
        SELECT
          (count(DISTINCT p."capperId") FILTER (WHERE ${curFilter}))::int AS cur,
          (count(DISTINCT p."capperId") FILTER (WHERE ${prevFilter}))::int AS prev,
          (count(*) FILTER (WHERE p."datePosted" >= ${ts(weekStart)} AND p."datePosted" < ${ts(now)}))::int AS week,
          (count(*) FILTER (WHERE p."datePosted" >= ${ts(priorWeekStart)} AND p."datePosted" < ${ts(weekStart)}))::int AS prior
        FROM picks p WHERE p."userId" = ${q.userId} ${lowerBound}
      ) a
    `
  );
  if (q.fav) add("fs", windowTotalsSelect({ userId: q.userId, favoritesOnly: true, pooled: true }));

  const outputs = ["ov", "pg", "top", "st", "stt", "sp", "sl", "ma", "hot", "win", "cold", ...(q.fav ? ["fs"] : [])];
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

  const sparklines = new Map<string, CapperSparkline>();
  for (const s of out.sl ?? []) {
    const pts = (s.pts as number[]).map(Number);
    sparklines.set(s.capperId, { points: [0, ...pts], netUnits: round2(pts[pts.length - 1] ?? 0), n: Number(s.n) });
  }

  const pooled = recordStatsFromTotals({
    wins: ov.wins ?? 0,
    losses: ov.losses ?? 0,
    pushes: ov.pushes ?? 0,
    unitsWon: ov.unitsWon ?? 0,
    unitsLost: ov.unitsLost ?? 0,
    unitsRisked: ov.unitsRisked ?? 0,
  });
  const week = Number(ov.week ?? 0);
  const prior = Number(ov.prior ?? 0);

  let favSummary: FavoriteCappersSummary | null = null;
  if (q.fav && Number(ov.favCount ?? 0) > 0) {
    // The pooled collectiveStats.currentStreak is never read (see FavoriteCappersSummary).
    favSummary = { collectiveStats: statsFromRows(out.fs?.[0] ? totalsOf(out.fs[0], q.window) : undefined, undefined), entries: [] };
  }

  return {
    capperCount: Number(ov.capperCount ?? 0),
    overview: {
      activeCappers: Number(ov.cur ?? 0),
      activeCappersDelta: scorecardWindowRange(q.window, now) ? Number(ov.cur ?? 0) - Number(ov.prev ?? 0) : null,
      picksThisWeek: week,
      picksThisWeekPct: prior > 0 ? Math.round(((week - prior) / prior) * 1000) / 10 : null,
      avgRoi: pooled.roi,
      gradedPicks: pooled.wins + pooled.losses + pooled.pushes,
      hotStreaks: Number(ov.hot ?? 0),
    },
    rows: pg.map((r) => entryOf(r, q.window, streaks.get(r.cid), specialists.get(r.cid) ?? null)),
    total,
    page: Math.min(Math.max(1, q.page), lastPage),
    top: ((out.top ?? []) as EntryRow[]).map((r) => entryOf(r, q.window, topStreaks.get(r.cid), null)),
    sparklines,
    mostActive: (out.ma ?? []).map((m: ActivityEntry) => ({ capperId: m.capperId, name: m.name, colorTag: m.colorTag, pickCount: Number(m.pickCount) })),
    hottest: (out.hot ?? []).map((h: StreakEntry) => ({ capperId: h.capperId, name: h.name, colorTag: h.colorTag, streak: Number(h.streak) })),
    winners: (out.win ?? []).map((h: WinnerEntry) => ({ capperId: h.capperId, name: h.name, colorTag: h.colorTag, netUnits: Number(h.netUnits) })),
    coldest: (out.cold ?? []).map((h: StreakEntry) => ({ capperId: h.capperId, name: h.name, colorTag: h.colorTag, streak: Number(h.streak), units: Number(h.units) })),
    favSummary,
  };
}
