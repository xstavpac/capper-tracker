// The database-side aggregation behind getCapperLeagueRecords / getCapperCategoryRecords
// (picks.ts) - see docs/design/picks-by-capper-egress.md for the full design and the
// DECIDED answers (Q1-Q8) this implements. One $queryRaw scans a capper's decided
// (WIN/LOSS/PUSH) picks ONCE and derives every requested shape from that single pass:
//   - "cards": per requested (capperId, leagueSport, category) triple, the Overall and
//     League win/loss/push counts (getCapperLeagueRecords' `records`).
//   - "catrec": per requested (capperId, category) pair, the all-time win/loss/push
//     counts (getCapperCategoryRecords). item.recent (the same pair's most-recent-
//     CATEGORY_RECENT_FORM_WINDOW counts) is NOT computed here - design doc Q3:
//     nothing reads it (confirmed by a full grep of src/ for a production reader -
//     see the removal commit), so it's dropped rather than carried for parity's sake.
//     picks-by-capper-legacy.ts (the frozen JS reference) still computes it, since
//     it's unmodified from the pre-migration path - the acceptance test excludes
//     `.recent` from its legacy-vs-sql comparison for exactly this reason.
//   - "streaks": per capper, the current overall WIN/LOSS streak (gaps-and-islands,
//     same shape as queryCurrentStreaks in capper-list-aggregates.ts, window = ALL).
//   - "last20": per capper, the record over their most recent LEAGUE_RECORD_LAST_N
//     decided picks (any category, any league).
//
// This file is only the SQL layer - it returns raw totals, never winPct/labels/null-
// collapsing. picks.ts's getCapperRecordBundle applies those with the SAME shared
// functions (winPctOf, PICK_CATEGORY_LABELS) the JS path used, so there is one
// implementation of each rule. Semantics preserved from the JS path (stats.ts):
//   - Only WIN/LOSS/PUSH rows are read; PENDING/CANCELLED never affect any output.
//   - category is the STORED Pick.category column (stamped at insert - see
//     docs/design/picks-by-capper-egress.md §3), not re-derived here.
//   - Ordering is the canonical (gameTime, createdAt, id) tie-break (ORDER_DESC,
//     reused from capper-list-aggregates.ts) - a deliberate behavioral stabilization
//     over the old path's undefined same-gameTime order (design doc §4.1, Q1).
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ORDER_DESC } from "@/server/data/capper-list-aggregates";

export type CardRequest = { capperId: string; leagueSport: string; category: string };
export type CategoryRequest = { capperId: string; category: string };

export type CardTotalsRow = {
  cid: string;
  sport: string;
  cat: string;
  oWins: number;
  oLosses: number;
  oPushes: number;
  lWins: number;
  lLosses: number;
  lPushes: number;
};

export type CategoryTotalsRow = {
  cid: string;
  cat: string;
  wins: number;
  losses: number;
  pushes: number;
};

export type StreakTotalsRow = { cid: string; type: "WIN" | "LOSS"; count: number };

export type Last20TotalsRow = { cid: string; decided: number; wins: number; losses: number; pushes: number };

export type CapperRecordBundleTotals = {
  cards: CardTotalsRow[];
  catrec: CategoryTotalsRow[];
  streaks: StreakTotalsRow[];
  last20: Last20TotalsRow[];
};

const EMPTY_TOTALS: CapperRecordBundleTotals = { cards: [], catrec: [], streaks: [], last20: [] };

export type CapperRecordBundleParams = {
  userId: string;
  capperIds: string[];
  cardReq: CardRequest[]; // deduped by the caller
  catReq: CategoryRequest[]; // deduped by the caller
  last20Window: number; // LEAGUE_RECORD_LAST_N
};

// The query itself, factored out so a caller can wrap it in EXPLAIN (see
// scripts/t2-harness's EXPLAIN check, design doc §7/Q7) without duplicating
// the SQL text. `params.capperIds` must be non-empty (queryCapperRecordBundle
// guards the empty case before calling this).
function buildBundleQuery(params: CapperRecordBundleParams): Prisma.Sql {
  // VALUES can't be empty - when a caller wants only cards (or only category
  // records), the other request list is []. A zero-row typed SELECT keeps the
  // CTE's column shape without a conditional branch in the SQL string itself.
  const cardReqRows =
    params.cardReq.length > 0
      ? Prisma.sql`VALUES ${Prisma.join(
          params.cardReq.map((c) => Prisma.sql`(${c.capperId}::text, ${c.leagueSport}::text, ${c.category}::text)`)
        )}`
      : Prisma.sql`SELECT NULL::text, NULL::text, NULL::text WHERE FALSE`;

  const catReqRows =
    params.catReq.length > 0
      ? Prisma.sql`VALUES ${Prisma.join(params.catReq.map((c) => Prisma.sql`(${c.capperId}::text, ${c.category}::text)`))}`
      : Prisma.sql`SELECT NULL::text, NULL::text WHERE FALSE`;

  return Prisma.sql`
    WITH
      base AS MATERIALIZED (
        SELECT p."capperId" AS "capperId", s.name AS sport, p.category, p.status,
               p."gameTime" AS "gameTime", p."createdAt" AS "createdAt", p.id AS id
        FROM picks p
        JOIN sports s ON s.id = p."sportId"
        WHERE p."userId" = ${params.userId}
          -- = ANY(array), not IN (SELECT cid FROM ids) over a VALUES CTE - the
          -- subquery form measurably changed the plan (EXPLAIN, design doc Q7):
          -- Postgres pushed it down as a semi-join applied AFTER the sports
          -- join (every userId+status row joined to sports first, THEN
          -- capperId-filtered), scanning the whole (userId,status) index slice
          -- regardless of how few cappers were requested - ~66ms/12k buffer
          -- hits for an 8-of-110-capper call on the synthetic heavy user
          -- (§9's numbers). ANY(array) applies the capperId filter directly on
          -- the index scan, before the sports join - ~5ms/1.6k buffer hits for
          -- the same call. Existing (userId, capperId) index still isn't the
          -- one used (Postgres prefers (userId, status) here, status being
          -- more selective against 110 cappers' pooled history) - no new
          -- index needed, this was a query-shape issue, not a missing index.
          AND p."capperId" = ANY(${params.capperIds}::text[])
          AND p.status IN ('WIN', 'LOSS', 'PUSH')
      ),

      "cardReq"(cid, sport, cat) AS (${cardReqRows}),
      cards AS (
        SELECT r.cid, r.sport, r.cat,
          (count(*) FILTER (WHERE b.status = 'WIN'))::int                          AS "oWins",
          (count(*) FILTER (WHERE b.status = 'LOSS'))::int                         AS "oLosses",
          (count(*) FILTER (WHERE b.status = 'PUSH'))::int                         AS "oPushes",
          (count(*) FILTER (WHERE b.status = 'WIN'  AND b.sport = r.sport))::int   AS "lWins",
          (count(*) FILTER (WHERE b.status = 'LOSS' AND b.sport = r.sport))::int   AS "lLosses",
          (count(*) FILTER (WHERE b.status = 'PUSH' AND b.sport = r.sport))::int   AS "lPushes"
        FROM "cardReq" r
        LEFT JOIN base b ON b."capperId" = r.cid AND b.category = r.cat
        GROUP BY r.cid, r.sport, r.cat
      ),

      "catReq"(cid, cat) AS (${catReqRows}),
      catrec AS (
        SELECT q.cid, q.cat,
          (count(*) FILTER (WHERE b.status = 'WIN'))::int  AS wins,
          (count(*) FILTER (WHERE b.status = 'LOSS'))::int AS losses,
          (count(*) FILTER (WHERE b.status = 'PUSH'))::int AS pushes
        FROM "catReq" q
        LEFT JOIN base b ON b."capperId" = q.cid AND b.category = q.cat
        GROUP BY q.cid, q.cat
      ),

      -- Current overall streak (gaps-and-islands, same shape as queryCurrentStreaks,
      -- window = ALL - no gradedAt gate).
      d AS (
        SELECT p."capperId" AS cid, p.status::text AS st,
          row_number() OVER (PARTITION BY p."capperId" ORDER BY ${ORDER_DESC}) AS rn
        FROM base p WHERE p.status IN ('WIN', 'LOSS')
      ),
      streaks AS (
        SELECT d.cid, lead.st AS type,
          (COALESCE(min(d.rn) FILTER (WHERE d.st <> lead.st) - 1, count(*)))::int AS count
        FROM d JOIN d lead ON lead.cid = d.cid AND lead.rn = 1
        GROUP BY d.cid, lead.st
      ),

      -- Capper-wide last N decided picks (every category, every league).
      r AS (
        SELECT p."capperId" AS cid, p.status,
          row_number() OVER (PARTITION BY p."capperId" ORDER BY ${ORDER_DESC}) AS rn
        FROM base p
      ),
      last20 AS (
        SELECT cid,
          (count(*))::int                                                      AS decided,
          (count(*) FILTER (WHERE status = 'WIN'  AND rn <= ${params.last20Window}))::int AS wins,
          (count(*) FILTER (WHERE status = 'LOSS' AND rn <= ${params.last20Window}))::int AS losses,
          (count(*) FILTER (WHERE status = 'PUSH' AND rn <= ${params.last20Window}))::int AS pushes
        FROM r GROUP BY cid
      )
    SELECT jsonb_build_object(
      'cards',   COALESCE((SELECT jsonb_agg(to_jsonb(cards))   FROM cards),   '[]'::jsonb),
      'catrec',  COALESCE((SELECT jsonb_agg(to_jsonb(catrec))  FROM catrec),  '[]'::jsonb),
      'streaks', COALESCE((SELECT jsonb_agg(to_jsonb(streaks)) FROM streaks), '[]'::jsonb),
      'last20',  COALESCE((SELECT jsonb_agg(to_jsonb(last20))  FROM last20),  '[]'::jsonb)
    ) AS out
  `;
}

// One scan of `picks` (MATERIALIZED, per the design doc's §4.2 note) for
// capperIds, then every output is a GROUP BY / window function over that one
// scan - no repeat scans per requested shape.
export async function queryCapperRecordBundle(params: CapperRecordBundleParams): Promise<CapperRecordBundleTotals> {
  if (params.capperIds.length === 0) return EMPTY_TOTALS;
  const rows = await prisma.$queryRaw<{ out: CapperRecordBundleTotals }[]>(buildBundleQuery(params));
  return rows[0]?.out ?? EMPTY_TOTALS;
}

// EXPLAIN (ANALYZE, BUFFERS) over the exact same query text queryCapperRecordBundle
// runs - Q7's index decision (design doc §10). Not called by production code;
// a script-only entry point.
export async function explainCapperRecordBundle(params: CapperRecordBundleParams): Promise<string> {
  const rows = await prisma.$queryRaw<{ "QUERY PLAN": string }[]>(
    Prisma.sql`EXPLAIN (ANALYZE, BUFFERS) ${buildBundleQuery(params)}`
  );
  return rows.map((r) => r["QUERY PLAN"]).join("\n");
}
