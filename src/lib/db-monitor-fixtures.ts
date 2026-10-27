// Real statement texts for db-monitor-acceptance-test.ts, exactly as Prisma
// sent them (query-log capture against the LOCAL dev DB, 2026-10-19): each code
// path was run with a logging PrismaClient installed as the app's client, on
// seeded rows that were deleted afterwards. `run` is the commit the text came
// from - 52a3260 is main, 1a96517 is #277's projected board read, b1b7874 is
// the commit before #128, where retired shapes A/B/C still ran. 52f483d is the
// ops-console capture (writes issued inside a rolled-back transaction); aacbcd6
// is the egress-plan capture (2026-10-20: roster, capper, tendency batch, the
// narrowed /picks and sport reads); 3c6cb08 is "Load older picks" (2026-10-20: the
// keyset page in each filter shape, its one-row reload, the per-day final scores). Three
// cron upserts need live score/stat feeds, so their text is production's own
// pg_stat_statements entry, copied from the DB Monitor page (run e769b64).
//
// pg_stat_statements stores the same text with literal constants swapped for
// $n; the test runs every fixture through that swap too.
//
// Generated - re-capture rather than hand-edit a statement.
export type StatementFixture = {
  name: string;
  run: string;
  sql: string;
  expectLabel: string | null;
  expectFlags: string[];
};

export const STATEMENT_FIXTURES: StatementFixture[] = [
  {
    "name": "board window, main (+-2 days, full row)",
    "run": "52a3260",
    "sql": "SELECT \"public\".\"picks\".\"id\", \"public\".\"picks\".\"userId\", \"public\".\"picks\".\"capperId\", \"public\".\"picks\".\"sportId\", \"public\".\"picks\".\"leagueId\", \"public\".\"picks\".\"homeTeam\", \"public\".\"picks\".\"awayTeam\", \"public\".\"picks\".\"betType\"::text, \"public\".\"picks\".\"betDetail\", \"public\".\"picks\".\"odds\", \"public\".\"picks\".\"oddsSource\"::text, \"public\".\"picks\".\"line\", \"public\".\"picks\".\"period\"::text, \"public\".\"picks\".\"sportsbook\", \"public\".\"picks\".\"units\", \"public\".\"picks\".\"datePosted\", \"public\".\"picks\".\"gameTime\", \"public\".\"picks\".\"notes\", \"public\".\"picks\".\"status\"::text, \"public\".\"picks\".\"gradedAt\", \"public\".\"picks\".\"gradedViaFuzzyMatch\", \"public\".\"picks\".\"pickedSide\"::text, \"public\".\"picks\".\"mlFavoredSide\"::text, \"public\".\"picks\".\"playerName\", \"public\".\"picks\".\"propMarket\"::text, \"public\".\"picks\".\"gameNumber\", \"public\".\"picks\".\"category\", \"public\".\"picks\".\"categoryVersion\", \"public\".\"picks\".\"createdAt\", \"public\".\"picks\".\"updatedAt\" FROM \"public\".\"picks\" WHERE (\"public\".\"picks\".\"userId\" = $1 AND \"public\".\"picks\".\"sportId\" = $2 AND \"public\".\"picks\".\"gameTime\" >= $3 AND \"public\".\"picks\".\"gameTime\" < $4) OFFSET $5",
    "expectLabel": "Board window",
    "expectFlags": []
  },
  {
    "name": "board window, #277 (+-6h, projected)",
    "run": "1a96517 (#277)",
    "sql": "SELECT \"public\".\"picks\".\"id\", \"public\".\"picks\".\"capperId\", \"public\".\"picks\".\"homeTeam\", \"public\".\"picks\".\"awayTeam\", \"public\".\"picks\".\"betType\"::text, \"public\".\"picks\".\"betDetail\", \"public\".\"picks\".\"odds\", \"public\".\"picks\".\"oddsSource\"::text, \"public\".\"picks\".\"line\", \"public\".\"picks\".\"period\"::text, \"public\".\"picks\".\"units\", \"public\".\"picks\".\"datePosted\", \"public\".\"picks\".\"gameTime\", \"public\".\"picks\".\"status\"::text, \"public\".\"picks\".\"pickedSide\"::text, \"public\".\"picks\".\"mlFavoredSide\"::text, \"public\".\"picks\".\"propMarket\"::text, \"public\".\"picks\".\"gameNumber\" FROM \"public\".\"picks\" WHERE (\"public\".\"picks\".\"userId\" = $1 AND \"public\".\"picks\".\"sportId\" = $2 AND \"public\".\"picks\".\"gameTime\" >= $3 AND \"public\".\"picks\".\"gameTime\" <= $4) ORDER BY \"public\".\"picks\".\"gameTime\" ASC, \"public\".\"picks\".\"createdAt\" ASC, \"public\".\"picks\".\"id\" ASC OFFSET $5",
    "expectLabel": "Board window",
    "expectFlags": []
  },
  {
    "name": "category panel (SQL)",
    "run": "52a3260",
    "sql": "\n    WITH g AS (\n      SELECT\n        p.\"capperId\" AS cid,\n        p.category AS cat,\n        (count(*) FILTER (WHERE p.status = 'WIN'))::int AS w,\n        (count(*) FILTER (WHERE p.status = 'LOSS'))::int AS l,\n        (count(*) FILTER (WHERE p.status = 'PUSH'))::int AS pu,\n        min((lpad(round(extract(epoch FROM p.\"createdAt\") * 1000)::bigint::text, 15, '0') || p.id) COLLATE \"C\") AS k\n      FROM picks p\n      WHERE p.\"userId\" = $1 AND p.category IS NOT NULL\n        AND p.\"sportId\" IN (SELECT id FROM sports WHERE name = $2)\n      GROUP BY p.\"capperId\", p.category\n    ),\n    r AS (\n      SELECT g.*,\n        (sum(w) OVER (PARTITION BY cat))::int AS cw,\n        (sum(l) OVER (PARTITION BY cat))::int AS cl,\n        (sum(pu) OVER (PARTITION BY cat))::int AS cpu,\n        row_number() OVER (\n          PARTITION BY cat\n          ORDER BY (w + l + pu >= $3) DESC,\n                   CASE WHEN w + l > 0 THEN (w::float8 / (w + l)::float8) * 100 ELSE 0 END DESC,\n                   k\n        ) AS rk\n      FROM g\n    )\n    SELECT cid AS \"capperId\", cat AS \"category\", w AS \"wins\", l AS \"losses\", pu AS \"pushes\", k AS \"firstAnyKey\",\n           cw AS \"categoryWins\", cl AS \"categoryLosses\", cpu AS \"categoryPushes\"\n    FROM r WHERE rk <= $4\n  ",
    "expectLabel": "Category panel",
    "expectFlags": []
  },
  {
    "name": "record bundle (SQL)",
    "run": "52a3260",
    "sql": "\n    WITH\n      base AS MATERIALIZED (\n        SELECT p.\"capperId\" AS \"capperId\", s.name AS sport, p.category, p.status,\n               p.\"gameTime\" AS \"gameTime\", p.\"createdAt\" AS \"createdAt\", p.id AS id\n        FROM picks p\n        JOIN sports s ON s.id = p.\"sportId\"\n        WHERE p.\"userId\" = $1\n          -- = ANY(array), not IN (SELECT cid FROM ids) over a VALUES CTE - the\n          -- subquery form measurably changed the plan (EXPLAIN, design doc Q7):\n          -- Postgres pushed it down as a semi-join applied AFTER the sports\n          -- join (every userId+status row joined to sports first, THEN\n          -- capperId-filtered), scanning the whole (userId,status) index slice\n          -- regardless of how few cappers were requested - ~66ms/12k buffer\n          -- hits for an 8-of-110-capper call on the synthetic heavy user\n          -- (§9's numbers). ANY(array) applies the capperId filter directly on\n          -- the index scan, before the sports join - ~5ms/1.6k buffer hits for\n          -- the same call. Existing (userId, capperId) index still isn't the\n          -- one used (Postgres prefers (userId, status) here, status being\n          -- more selective against 110 cappers' pooled history) - no new\n          -- index needed, this was a query-shape issue, not a missing index.\n          AND p.\"capperId\" = ANY($2::text[])\n          AND p.status IN ('WIN', 'LOSS', 'PUSH')\n      ),\n\n      \"cardReq\"(cid, sport, cat) AS (SELECT NULL::text, NULL::text, NULL::text WHERE FALSE),\n      cards AS (\n        SELECT r.cid, r.sport, r.cat,\n          (count(*) FILTER (WHERE b.status = 'WIN'))::int                          AS \"oWins\",\n          (count(*) FILTER (WHERE b.status = 'LOSS'))::int                         AS \"oLosses\",\n          (count(*) FILTER (WHERE b.status = 'PUSH'))::int                         AS \"oPushes\",\n          (count(*) FILTER (WHERE b.status = 'WIN'  AND b.sport = r.sport))::int   AS \"lWins\",\n          (count(*) FILTER (WHERE b.status = 'LOSS' AND b.sport = r.sport))::int   AS \"lLosses\",\n          (count(*) FILTER (WHERE b.status = 'PUSH' AND b.sport = r.sport))::int   AS \"lPushes\"\n        FROM \"cardReq\" r\n        LEFT JOIN base b ON b.\"capperId\" = r.cid AND b.category = r.cat\n        GROUP BY r.cid, r.sport, r.cat\n      ),\n\n      \"catReq\"(cid, cat) AS (SELECT NULL::text, NULL::text WHERE FALSE),\n      catrec AS (\n        SELECT q.cid, q.cat,\n          (count(*) FILTER (WHERE b.status = 'WIN'))::int  AS wins,\n          (count(*) FILTER (WHERE b.status = 'LOSS'))::int AS losses,\n          (count(*) FILTER (WHERE b.status = 'PUSH'))::int AS pushes\n        FROM \"catReq\" q\n        LEFT JOIN base b ON b.\"capperId\" = q.cid AND b.category = q.cat\n        GROUP BY q.cid, q.cat\n      ),\n\n      -- Current overall streak (gaps-and-islands, same shape as queryCurrentStreaks,\n      -- window = ALL - no gradedAt gate).\n      d AS (\n        SELECT p.\"capperId\" AS cid, p.status::text AS st,\n          row_number() OVER (PARTITION BY p.\"capperId\" ORDER BY p.\"gameTime\" DESC, p.\"createdAt\" DESC, p.id COLLATE \"C\" DESC) AS rn\n        FROM base p WHERE p.status IN ('WIN', 'LOSS')\n      ),\n      streaks AS (\n        SELECT d.cid, lead.st AS type,\n          (COALESCE(min(d.rn) FILTER (WHERE d.st <> lead.st) - 1, count(*)))::int AS count\n        FROM d JOIN d lead ON lead.cid = d.cid AND lead.rn = 1\n        GROUP BY d.cid, lead.st\n      ),\n\n      -- Capper-wide last N decided picks (every category, every league).\n      r AS (\n        SELECT p.\"capperId\" AS cid, p.status,\n          row_number() OVER (PARTITION BY p.\"capperId\" ORDER BY p.\"gameTime\" DESC, p.\"createdAt\" DESC, p.id COLLATE \"C\" DESC) AS rn\n        FROM base p\n      ),\n      last20 AS (\n        SELECT cid,\n          (count(*))::int                                                      AS decided,\n          (count(*) FILTER (WHERE status = 'WIN'  AND rn <= $3))::int AS wins,\n          (count(*) FILTER (WHERE status = 'LOSS' AND rn <= $4))::int AS losses,\n          (count(*) FILTER (WHERE status = 'PUSH' AND rn <= $5))::int AS pushes\n        FROM r GROUP BY cid\n      )\n    SELECT jsonb_build_object(\n      'cards',   COALESCE((SELECT jsonb_agg(to_jsonb(cards))   FROM cards),   '[]'::jsonb),\n      'catrec',  COALESCE((SELECT jsonb_agg(to_jsonb(catrec))  FROM catrec),  '[]'::jsonb),\n      'streaks', COALESCE((SELECT jsonb_agg(to_jsonb(streaks)) FROM streaks), '[]'::jsonb),\n      'last20',  COALESCE((SELECT jsonb_agg(to_jsonb(last20))  FROM last20),  '[]'::jsonb)\n    ) AS out\n  ",
    "expectLabel": "Record bundle",
    "expectFlags": []
  },
  {
    "name": "slip id IN",
    "run": "52a3260",
    "sql": "SELECT \"public\".\"picks\".\"id\", \"public\".\"picks\".\"userId\", \"public\".\"picks\".\"capperId\", \"public\".\"picks\".\"sportId\", \"public\".\"picks\".\"leagueId\", \"public\".\"picks\".\"homeTeam\", \"public\".\"picks\".\"awayTeam\", \"public\".\"picks\".\"betType\"::text, \"public\".\"picks\".\"betDetail\", \"public\".\"picks\".\"odds\", \"public\".\"picks\".\"oddsSource\"::text, \"public\".\"picks\".\"line\", \"public\".\"picks\".\"period\"::text, \"public\".\"picks\".\"sportsbook\", \"public\".\"picks\".\"units\", \"public\".\"picks\".\"datePosted\", \"public\".\"picks\".\"gameTime\", \"public\".\"picks\".\"notes\", \"public\".\"picks\".\"status\"::text, \"public\".\"picks\".\"gradedAt\", \"public\".\"picks\".\"gradedViaFuzzyMatch\", \"public\".\"picks\".\"pickedSide\"::text, \"public\".\"picks\".\"mlFavoredSide\"::text, \"public\".\"picks\".\"playerName\", \"public\".\"picks\".\"propMarket\"::text, \"public\".\"picks\".\"gameNumber\", \"public\".\"picks\".\"category\", \"public\".\"picks\".\"categoryVersion\", \"public\".\"picks\".\"createdAt\", \"public\".\"picks\".\"updatedAt\" FROM \"public\".\"picks\" WHERE (\"public\".\"picks\".\"userId\" = $1 AND \"public\".\"picks\".\"id\" IN ($2,$3)) OFFSET $4",
    "expectLabel": "Slip id IN",
    "expectFlags": []
  },
  {
    "name": "capper comparison",
    "run": "52a3260",
    "sql": "SELECT \"public\".\"picks\".\"id\", \"public\".\"picks\".\"sportId\", \"public\".\"picks\".\"betType\"::text, \"public\".\"picks\".\"period\"::text, \"public\".\"picks\".\"betDetail\", \"public\".\"picks\".\"propMarket\"::text, \"public\".\"picks\".\"line\", \"public\".\"picks\".\"odds\", \"public\".\"picks\".\"pickedSide\"::text, \"public\".\"picks\".\"mlFavoredSide\"::text, \"public\".\"picks\".\"gameTime\", \"public\".\"picks\".\"units\", \"public\".\"picks\".\"status\"::text, \"public\".\"picks\".\"createdAt\", \"public\".\"picks\".\"gradedAt\" FROM \"public\".\"picks\" WHERE (\"public\".\"picks\".\"userId\" = $1 AND \"public\".\"picks\".\"capperId\" = $2) ORDER BY \"public\".\"picks\".\"gameTime\" ASC OFFSET $3",
    "expectLabel": "Capper comparison",
    "expectFlags": []
  },
  {
    "name": "/picks date range",
    "run": "52a3260",
    "sql": "SELECT \"public\".\"picks\".\"id\", \"public\".\"picks\".\"userId\", \"public\".\"picks\".\"capperId\", \"public\".\"picks\".\"sportId\", \"public\".\"picks\".\"leagueId\", \"public\".\"picks\".\"homeTeam\", \"public\".\"picks\".\"awayTeam\", \"public\".\"picks\".\"betType\"::text, \"public\".\"picks\".\"betDetail\", \"public\".\"picks\".\"odds\", \"public\".\"picks\".\"oddsSource\"::text, \"public\".\"picks\".\"line\", \"public\".\"picks\".\"period\"::text, \"public\".\"picks\".\"sportsbook\", \"public\".\"picks\".\"units\", \"public\".\"picks\".\"datePosted\", \"public\".\"picks\".\"gameTime\", \"public\".\"picks\".\"notes\", \"public\".\"picks\".\"status\"::text, \"public\".\"picks\".\"gradedAt\", \"public\".\"picks\".\"gradedViaFuzzyMatch\", \"public\".\"picks\".\"pickedSide\"::text, \"public\".\"picks\".\"mlFavoredSide\"::text, \"public\".\"picks\".\"playerName\", \"public\".\"picks\".\"propMarket\"::text, \"public\".\"picks\".\"gameNumber\", \"public\".\"picks\".\"category\", \"public\".\"picks\".\"categoryVersion\", \"public\".\"picks\".\"createdAt\", \"public\".\"picks\".\"updatedAt\" FROM \"public\".\"picks\" WHERE (\"public\".\"picks\".\"userId\" = $1 AND \"public\".\"picks\".\"gameTime\" >= $2 AND \"public\".\"picks\".\"gameTime\" < $3) ORDER BY \"public\".\"picks\".\"gameTime\" DESC OFFSET $4",
    "expectLabel": "/picks",
    "expectFlags": []
  },
  {
    "name": "/picks pending",
    "run": "52a3260",
    "sql": "SELECT \"public\".\"picks\".\"id\", \"public\".\"picks\".\"userId\", \"public\".\"picks\".\"capperId\", \"public\".\"picks\".\"sportId\", \"public\".\"picks\".\"leagueId\", \"public\".\"picks\".\"homeTeam\", \"public\".\"picks\".\"awayTeam\", \"public\".\"picks\".\"betType\"::text, \"public\".\"picks\".\"betDetail\", \"public\".\"picks\".\"odds\", \"public\".\"picks\".\"oddsSource\"::text, \"public\".\"picks\".\"line\", \"public\".\"picks\".\"period\"::text, \"public\".\"picks\".\"sportsbook\", \"public\".\"picks\".\"units\", \"public\".\"picks\".\"datePosted\", \"public\".\"picks\".\"gameTime\", \"public\".\"picks\".\"notes\", \"public\".\"picks\".\"status\"::text, \"public\".\"picks\".\"gradedAt\", \"public\".\"picks\".\"gradedViaFuzzyMatch\", \"public\".\"picks\".\"pickedSide\"::text, \"public\".\"picks\".\"mlFavoredSide\"::text, \"public\".\"picks\".\"playerName\", \"public\".\"picks\".\"propMarket\"::text, \"public\".\"picks\".\"gameNumber\", \"public\".\"picks\".\"category\", \"public\".\"picks\".\"categoryVersion\", \"public\".\"picks\".\"createdAt\", \"public\".\"picks\".\"updatedAt\" FROM \"public\".\"picks\" WHERE (\"public\".\"picks\".\"userId\" = $1 AND \"public\".\"picks\".\"status\" = CAST($2::text AS \"public\".\"PickStatus\")) ORDER BY \"public\".\"picks\".\"gameTime\" ASC OFFSET $3",
    "expectLabel": "/picks",
    "expectFlags": []
  },
  {
    "name": "grading pending count()",
    "run": "52a3260",
    "sql": "SELECT COUNT(*) FROM (SELECT \"public\".\"picks\".\"id\" FROM \"public\".\"picks\" WHERE (\"public\".\"picks\".\"sportId\" = $1 AND \"public\".\"picks\".\"status\" = CAST($2::text AS \"public\".\"PickStatus\") AND \"public\".\"picks\".\"gameTime\" >= $3) OFFSET $4) AS \"sub\"",
    "expectLabel": "Grading pending",
    "expectFlags": []
  },
  {
    "name": "grading pending findMany",
    "run": "52a3260",
    "sql": "SELECT \"public\".\"picks\".\"id\", \"public\".\"picks\".\"userId\", \"public\".\"picks\".\"capperId\", \"public\".\"picks\".\"sportId\", \"public\".\"picks\".\"leagueId\", \"public\".\"picks\".\"homeTeam\", \"public\".\"picks\".\"awayTeam\", \"public\".\"picks\".\"betType\"::text, \"public\".\"picks\".\"betDetail\", \"public\".\"picks\".\"odds\", \"public\".\"picks\".\"oddsSource\"::text, \"public\".\"picks\".\"line\", \"public\".\"picks\".\"period\"::text, \"public\".\"picks\".\"sportsbook\", \"public\".\"picks\".\"units\", \"public\".\"picks\".\"datePosted\", \"public\".\"picks\".\"gameTime\", \"public\".\"picks\".\"notes\", \"public\".\"picks\".\"status\"::text, \"public\".\"picks\".\"gradedAt\", \"public\".\"picks\".\"gradedViaFuzzyMatch\", \"public\".\"picks\".\"pickedSide\"::text, \"public\".\"picks\".\"mlFavoredSide\"::text, \"public\".\"picks\".\"playerName\", \"public\".\"picks\".\"propMarket\"::text, \"public\".\"picks\".\"gameNumber\", \"public\".\"picks\".\"category\", \"public\".\"picks\".\"categoryVersion\", \"public\".\"picks\".\"createdAt\", \"public\".\"picks\".\"updatedAt\" FROM \"public\".\"picks\" WHERE (\"public\".\"picks\".\"sportId\" = $1 AND \"public\".\"picks\".\"status\" = CAST($2::text AS \"public\".\"PickStatus\") AND \"public\".\"picks\".\"gameTime\" >= $3) ORDER BY \"public\".\"picks\".\"gameTime\" ASC LIMIT $4 OFFSET $5",
    "expectLabel": "Grading pending",
    "expectFlags": []
  },
  {
    "name": "fuzzy grading",
    "run": "52a3260",
    "sql": "SELECT \"public\".\"picks\".\"id\", \"public\".\"picks\".\"userId\", \"public\".\"picks\".\"capperId\", \"public\".\"picks\".\"sportId\", \"public\".\"picks\".\"leagueId\", \"public\".\"picks\".\"homeTeam\", \"public\".\"picks\".\"awayTeam\", \"public\".\"picks\".\"betType\"::text, \"public\".\"picks\".\"betDetail\", \"public\".\"picks\".\"odds\", \"public\".\"picks\".\"oddsSource\"::text, \"public\".\"picks\".\"line\", \"public\".\"picks\".\"period\"::text, \"public\".\"picks\".\"sportsbook\", \"public\".\"picks\".\"units\", \"public\".\"picks\".\"datePosted\", \"public\".\"picks\".\"gameTime\", \"public\".\"picks\".\"notes\", \"public\".\"picks\".\"status\"::text, \"public\".\"picks\".\"gradedAt\", \"public\".\"picks\".\"gradedViaFuzzyMatch\", \"public\".\"picks\".\"pickedSide\"::text, \"public\".\"picks\".\"mlFavoredSide\"::text, \"public\".\"picks\".\"playerName\", \"public\".\"picks\".\"propMarket\"::text, \"public\".\"picks\".\"gameNumber\", \"public\".\"picks\".\"category\", \"public\".\"picks\".\"categoryVersion\", \"public\".\"picks\".\"createdAt\", \"public\".\"picks\".\"updatedAt\" FROM \"public\".\"picks\" WHERE (\"public\".\"picks\".\"sportId\" = $1 AND \"public\".\"picks\".\"status\" IN (CAST($2::text AS \"public\".\"PickStatus\"),CAST($3::text AS \"public\".\"PickStatus\"),CAST($4::text AS \"public\".\"PickStatus\")) AND \"public\".\"picks\".\"gradedViaFuzzyMatch\" = $5 AND \"public\".\"picks\".\"gameTime\" >= $6) ORDER BY \"public\".\"picks\".\"gameTime\" DESC LIMIT $7 OFFSET $8",
    "expectLabel": "Fuzzy grading",
    "expectFlags": []
  },
  {
    "name": "control: /cappers page bundle",
    "run": "52a3260",
    "sql": "\n    WITH w(win, wstart, wend) AS (VALUES ($1::text, NULL::timestamp, NULL::timestamp)),\n    roster AS (SELECT id, name, \"colorTag\", \"isFavorite\", \"createdAt\" FROM cappers WHERE \"userId\" = $2 AND NOT \"isTest\"),\nut AS (\n    SELECT\n      p.\"capperId\" AS \"capperId\",\n      w.win AS \"window\",\n      \n      count(*)::int AS \"nPicks\",\n      (count(*) FILTER (WHERE p.status = 'WIN'))::int AS \"wins\",\n      (count(*) FILTER (WHERE p.status = 'LOSS'))::int AS \"losses\",\n      (count(*) FILTER (WHERE p.status = 'PUSH'))::int AS \"pushes\",\n      COALESCE(sum(p.units * (CASE WHEN p.odds > 0 THEN p.odds::float8 / 100::float8 ELSE 100::float8 / NULLIF(abs(p.odds), 0)::float8 END) ORDER BY p.\"gameTime\", p.\"createdAt\", p.id COLLATE \"C\") FILTER (WHERE p.status = 'WIN' AND p.odds <> 0), 0)::float8 AS \"unitsWon\",\n      COALESCE(sum(p.units ORDER BY p.\"gameTime\", p.\"createdAt\", p.id COLLATE \"C\") FILTER (WHERE p.status = 'LOSS'), 0)::float8 AS \"unitsLost\",\n      COALESCE(sum(p.units ORDER BY p.\"gameTime\", p.\"createdAt\", p.id COLLATE \"C\") FILTER (WHERE p.status IN ('WIN', 'LOSS', 'PUSH')), 0)::float8 AS \"unitsRisked\",\n      COALESCE(bit_or(CASE WHEN p.units > 0 THEN 1 WHEN p.units < 0 THEN 2 ELSE 4 END) FILTER (WHERE p.status = 'WIN' AND p.odds = 0), 0)::int AS \"zeroOddsWinFlags\"\n    FROM picks p\n    JOIN w ON (w.wstart IS NULL OR (p.\"gradedAt\" IS NOT NULL AND p.\"gameTime\" >= w.wstart AND p.\"gameTime\" < w.wend))\n    \n    WHERE p.\"userId\" = $3 \n    GROUP BY p.\"capperId\",w.win\n  ),\nut_r AS (SELECT * FROM ut WHERE \"capperId\" IN (SELECT id FROM roster)),\ne AS (\n        SELECT r.id AS cid, r.name, r.\"colorTag\", r.\"isFavorite\",\n          COALESCE(t.wins, 0)::int AS wins, COALESCE(t.losses, 0)::int AS losses, COALESCE(t.pushes, 0)::int AS pushes,\n          COALESCE(t.\"unitsWon\", 0)::float8 AS \"unitsWon\", COALESCE(t.\"unitsLost\", 0)::float8 AS \"unitsLost\",\n          COALESCE(t.\"unitsRisked\", 0)::float8 AS \"unitsRisked\", COALESCE(t.\"zeroOddsWinFlags\", 0)::int AS \"zeroOddsWinFlags\"\n        FROM roster r LEFT JOIN ut t ON t.\"capperId\" = r.id\n        \n      ),\ne_k AS (\n        SELECT x.*, ((CASE WHEN (x.net_raw * 100::float8) - floor((x.net_raw * 100::float8)) >= 0.5::float8 THEN ceil((x.net_raw * 100::float8)) ELSE floor((x.net_raw * 100::float8)) END) / 100::float8) AS net_r,\n          CASE WHEN x.\"unitsRisked\" > 0 THEN ((CASE WHEN (x.roi_raw * 100::float8) - floor((x.roi_raw * 100::float8)) >= 0.5::float8 THEN ceil((x.roi_raw * 100::float8)) ELSE floor((x.roi_raw * 100::float8)) END) / 100::float8) ELSE 0::float8 END AS roi_r\n        FROM (\n          SELECT e.*, e.wins + e.losses + e.pushes AS decided,\n            e.uw_eff - e.\"unitsLost\" AS net_raw,\n            CASE WHEN e.\"unitsRisked\" > 0 THEN (e.uw_eff - e.\"unitsLost\") / e.\"unitsRisked\" * 100::float8 ELSE 0::float8 END AS roi_raw,\n            CASE WHEN e.wins + e.losses > 0 THEN e.wins::float8 / (e.wins + e.losses)::float8 * 100::float8 ELSE 0::float8 END AS win_pct\n          FROM (\n            SELECT e0.*,\n              CASE WHEN e0.\"zeroOddsWinFlags\" = 0 THEN e0.\"unitsWon\"\n                   WHEN (e0.\"zeroOddsWinFlags\" & 4) <> 0 OR (e0.\"zeroOddsWinFlags\" & 3) = 3 THEN 'NaN'::float8\n                   WHEN (e0.\"zeroOddsWinFlags\" & 1) <> 0 THEN 'Infinity'::float8\n                   ELSE '-Infinity'::float8 END AS uw_eff\n            FROM e e0\n          ) e\n        ) x\n      ),\nfil AS (\n      SELECT e_k.*, row_number() OVER (ORDER BY (decided = 0 OR roi_r = 'NaN'::float8), roi_r DESC, (net_r = 'NaN'::float8), net_r DESC, lower(name) COLLATE \"C\", name COLLATE \"C\", cid COLLATE \"C\") AS rn, count(*) OVER () AS total\n      FROM e_k WHERE decided >= $4\n    ),\npg AS (SELECT * FROM fil WHERE rn > (LEAST($5::int, GREATEST(1, CEIL(total::float8 / $6::float8)::int)) - 1) * $7 AND rn <= LEAST($8::int, GREATEST(1, CEIL(total::float8 / $9::float8)::int)) * $10),\ntop AS (\n      SELECT * FROM e_k\n      WHERE decided >= $11 AND net_r > 0 AND net_r < 'Infinity'::float8 AND wins > losses\n      ORDER BY net_r DESC, win_pct DESC, decided DESC, (net_r = 'NaN'::float8), net_r DESC, lower(name) COLLATE \"C\", name COLLATE \"C\", cid COLLATE \"C\"\n      LIMIT $12),\ndisp AS (SELECT cid FROM pg),\nst_u AS (\n    WITH d AS (\n      SELECT\n        p.\"capperId\" AS cid,\n        w.win,\n        p.status::text AS st,\n        row_number() OVER (PARTITION BY p.\"capperId\", w.win ORDER BY p.\"gameTime\" DESC, p.\"createdAt\" DESC, p.id COLLATE \"C\" DESC) AS rn\n      FROM picks p\n      JOIN w ON (w.wstart IS NULL OR (p.\"gradedAt\" IS NOT NULL AND p.\"gameTime\" >= w.wstart AND p.\"gameTime\" < w.wend))\n      WHERE p.\"userId\" = $13 AND p.status IN ('WIN', 'LOSS')  \n    )\n    SELECT\n      d.cid AS \"capperId\",\n      d.win AS \"window\",\n      lead.st AS \"type\",\n      COALESCE(min(d.rn) FILTER (WHERE d.st <> lead.st) - 1, count(*))::int AS \"count\"\n    FROM d\n    JOIN d lead ON lead.cid = d.cid AND lead.win = d.win AND lead.rn = 1\n    GROUP BY d.cid, d.win, lead.st\n  ),\nst AS (SELECT * FROM st_u WHERE \"capperId\" IN (SELECT cid FROM pg)),\nsp AS (\n    WITH g AS (\n      SELECT\n        p.\"capperId\" AS cid,\n        p.category AS cat,\n        (count(*) FILTER (WHERE p.status = 'WIN'))::int AS w,\n        (count(*) FILTER (WHERE p.status = 'LOSS'))::int AS l,\n        (count(*) FILTER (WHERE p.status = 'PUSH'))::int AS pu,\n        min((lpad(round(extract(epoch FROM p.\"createdAt\") * 1000)::bigint::text, 15, '0') || p.id) COLLATE \"C\") AS k\n      FROM picks p\n      WHERE p.\"userId\" = $14 AND p.status IN ('WIN', 'LOSS', 'PUSH')  AND p.\"capperId\" IN (SELECT cid FROM pg)\n      GROUP BY p.\"capperId\", p.category\n    ),\n    t AS (\n      SELECT g.*,\n        (sum(w + l + pu) OVER (PARTITION BY cid))::int AS total,\n        (sum(w) OVER (PARTITION BY cid))::int AS tw,\n        (sum(l) OVER (PARTITION BY cid))::int AS tl\n      FROM g\n    )\n    SELECT cid AS \"capperId\", cat AS \"category\", w AS \"wins\", l AS \"losses\", pu AS \"pushes\", k AS \"firstDecidedKey\",\n           total AS \"decidedTotal\", tw AS \"totalWins\", tl AS \"totalLosses\"\n    FROM t\n    WHERE cat IS NOT NULL AND (w + l + pu) >= $15 AND (w + l + pu)::float8 / total::float8 >= $16::float8\n  ),\nsl AS (\n      SELECT cid AS \"capperId\", count(*)::int AS n, jsonb_agg(cum ORDER BY rn DESC) AS pts\n      FROM (\n        SELECT cid, rn, sum(delta) OVER (PARTITION BY cid ORDER BY rn DESC) AS cum\n        FROM (\n          SELECT p.\"capperId\" AS cid,\n            CASE p.status WHEN 'WIN' THEN COALESCE(p.units * (CASE WHEN p.odds > 0 THEN p.odds::float8 / 100::float8 ELSE 100::float8 / NULLIF(abs(p.odds), 0)::float8 END), 0) WHEN 'LOSS' THEN -p.units ELSE 0 END::float8 AS delta,\n            row_number() OVER (PARTITION BY p.\"capperId\" ORDER BY p.\"gameTime\" DESC, p.\"createdAt\" DESC, p.id COLLATE \"C\" DESC) AS rn\n          FROM picks p\n          WHERE p.\"userId\" = $17 AND p.\"capperId\" IN (SELECT cid FROM disp) AND p.status IN ('WIN', 'LOSS', 'PUSH')\n        ) r\n        WHERE rn <= $18\n      ) s\n      GROUP BY cid\n    ),\ntsl AS (\n      SELECT cid AS \"capperId\", max(i)::int AS n, jsonb_agg(cum ORDER BY i) FILTER (WHERE i % step = 0 OR i = cnt) AS pts\n      FROM (\n        SELECT cid, i, cnt, cum, GREATEST(1, CEIL(cnt::float8 / $19::float8)::int) AS step\n        FROM (\n          SELECT cid, i, cum, max(i) OVER (PARTITION BY cid) AS cnt\n          FROM (\n            SELECT cid, row_number() OVER (PARTITION BY cid ORDER BY gt, ca, id) AS i,\n              sum(delta) OVER (PARTITION BY cid ORDER BY gt, ca, id) AS cum\n            FROM (\n              SELECT p.\"capperId\" AS cid, p.\"gameTime\" AS gt, p.\"createdAt\" AS ca, p.id COLLATE \"C\" AS id,\n                CASE p.status WHEN 'WIN' THEN COALESCE(p.units * (CASE WHEN p.odds > 0 THEN p.odds::float8 / 100::float8 ELSE 100::float8 / NULLIF(abs(p.odds), 0)::float8 END), 0) WHEN 'LOSS' THEN -p.units ELSE 0 END::float8 AS delta\n              FROM picks p\n              JOIN w ON (w.wstart IS NULL OR (p.\"gradedAt\" IS NOT NULL AND p.\"gameTime\" >= w.wstart AND p.\"gameTime\" < w.wend))\n              WHERE p.\"userId\" = $20 AND p.\"capperId\" IN (SELECT cid FROM top) AND p.status IN ('WIN', 'LOSS', 'PUSH')\n            ) g\n          ) r\n        ) c\n      ) t\n      GROUP BY cid\n    ),\nma AS (\n      SELECT r.id AS \"capperId\", r.name, r.\"colorTag\", m.n AS \"pickCount\", (sum(m.n) OVER ())::int AS \"totalPicks\"\n      FROM (SELECT p.\"capperId\" AS cid, count(*)::int AS n FROM picks p WHERE p.\"userId\" = $21 AND p.\"datePosted\" >= $22::timestamp  GROUP BY p.\"capperId\") m\n      JOIN roster r ON r.id = m.cid\n      ORDER BY m.n DESC, r.\"isFavorite\" DESC, r.name, r.id\n      LIMIT $23\n    ),\nwin AS (\n    SELECT h.cid AS \"capperId\", h.name, h.\"colorTag\", h.net_r AS \"netUnits\", h.wins, h.losses, h.pushes\n    FROM (\n      SELECT g.cid, r.name, r.\"colorTag\", ((CASE WHEN (g.net_raw * 100::float8) - floor((g.net_raw * 100::float8)) >= 0.5::float8 THEN ceil((g.net_raw * 100::float8)) ELSE floor((g.net_raw * 100::float8)) END) / 100::float8) AS net_r, g.wins, g.losses, g.pushes\n      FROM (\n        SELECT a.cid, a.wins, a.losses, a.pushes, CASE WHEN a.\"zeroOddsWinFlags\" = 0 THEN a.\"unitsWon\"\n                   WHEN (a.\"zeroOddsWinFlags\" & 4) <> 0 OR (a.\"zeroOddsWinFlags\" & 3) = 3 THEN 'NaN'::float8\n                   WHEN (a.\"zeroOddsWinFlags\" & 1) <> 0 THEN 'Infinity'::float8\n                   ELSE '-Infinity'::float8 END - a.\"unitsLost\" AS net_raw\n        FROM (\n          SELECT p.\"capperId\" AS cid,\n            (count(*) FILTER (WHERE p.status = 'WIN'))::int AS wins,\n            (count(*) FILTER (WHERE p.status = 'LOSS'))::int AS losses,\n            (count(*) FILTER (WHERE p.status = 'PUSH'))::int AS pushes,\n            COALESCE(sum(p.units * (CASE WHEN p.odds > 0 THEN p.odds::float8 / 100::float8 ELSE 100::float8 / NULLIF(abs(p.odds), 0)::float8 END)) FILTER (WHERE p.status = 'WIN' AND p.odds <> 0), 0)::float8 AS \"unitsWon\",\n            COALESCE(sum(p.units) FILTER (WHERE p.status = 'LOSS'), 0)::float8 AS \"unitsLost\",\n            COALESCE(bit_or(CASE WHEN p.units > 0 THEN 1 WHEN p.units < 0 THEN 2 ELSE 4 END) FILTER (WHERE p.status = 'WIN' AND p.odds = 0), 0)::int AS \"zeroOddsWinFlags\"\n          FROM picks p\n          WHERE p.\"userId\" = $24 AND p.\"datePosted\" >= $25::timestamp \n          GROUP BY p.\"capperId\"\n        ) a\n      ) g\n      JOIN roster r ON r.id = g.cid\n    ) h\n    WHERE h.net_r > 0 AND h.net_r < 'Infinity'::float8\n    ORDER BY h.net_r DESC, lower(h.name) COLLATE \"C\", h.name COLLATE \"C\", h.cid COLLATE \"C\"\n    LIMIT $26\n  ),\ndl AS (\n      SELECT r.id AS cid, q.win, q.\"gameTime\" AS gt,\n        row_number() OVER (PARTITION BY r.id ORDER BY q.\"gameTime\" DESC, q.\"createdAt\" DESC, q.id COLLATE \"C\" DESC) AS rn\n      FROM roster r\n      CROSS JOIN LATERAL (\n        SELECT (p.status = 'WIN') AS win, p.\"gameTime\", p.\"createdAt\", p.id\n        FROM picks p\n        WHERE p.\"userId\" = $27 AND p.\"capperId\" = r.id AND p.status IN ('WIN', 'LOSS')\n        ORDER BY p.\"gameTime\" DESC, p.\"createdAt\" DESC, p.id COLLATE \"C\" DESC\n        LIMIT $28\n      ) q\n    ),\nconsistent AS (\n      SELECT b.cid AS \"capperId\", r.name, r.\"colorTag\", b.blocks, b.sd::float8 AS sd\n      FROM (\n        SELECT cid, sum(n) AS n, sum(w) AS tw,\n          round(stddev_pop(w::numeric * 100 / n), 9) AS sd,\n          array_agg(round(w::numeric * 100 / n, 4)::float8 ORDER BY blk) AS blocks\n        FROM (\n          SELECT cid, blk, count(*) AS n, count(*) FILTER (WHERE win) AS w\n          FROM (\n            SELECT cid, win, ($29::int - rn) / $30::int AS blk\n            FROM dl WHERE rn <= $31::int\n          ) y\n          GROUP BY cid, blk\n        ) x\n        GROUP BY cid\n      ) b\n      JOIN roster r ON r.id = b.cid\n      WHERE b.n = $32::int\n        AND b.tw::numeric * 100 / b.n >= $33::int\n      ORDER BY b.sd ASC, b.tw DESC, r.id COLLATE \"C\"\n      LIMIT $34\n    ),\nstt AS (SELECT * FROM st_u WHERE \"capperId\" IN (SELECT cid FROM top)),\nag AS (\n      SELECT GROUPING(c.dw, c.gw)::int AS g, c.dw, c.gw,\n        COALESCE(sum(c.n), 0)::int AS n,\n        count(DISTINCT c.cid)::int AS nc,\n        (count(DISTINCT c.cid) FILTER (WHERE c.cur))::int AS cur,\n        COALESCE(sum(c.uw), 0)::float8 AS uw, COALESCE(sum(c.ul), 0)::float8 AS ul, COALESCE(sum(c.ur), 0)::float8 AS ur\n      FROM (\n        SELECT x.cid, x.dw, x.gw, x.cur, count(*) AS n,\n          sum(x.win_units) FILTER (WHERE x.status = 'WIN' AND x.odds <> 0) AS uw,\n          sum(x.units) FILTER (WHERE x.status = 'LOSS') AS ul,\n          sum(x.units) FILTER (WHERE x.status IN ('WIN', 'LOSS', 'PUSH')) AS ur\n        FROM (\n          SELECT p.\"capperId\" AS cid, p.status, p.units, p.odds, p.units * (CASE WHEN p.odds > 0 THEN p.odds::float8 / 100::float8 ELSE 100::float8 / NULLIF(abs(p.odds), 0)::float8 END) AS win_units, (true) AS cur,\n            CASE WHEN floor(extract(epoch FROM p.\"datePosted\" - k.t0) / $35::int)::int BETWEEN 0 AND $36 THEN floor(extract(epoch FROM p.\"datePosted\" - k.t0) / $37::int)::int END AS dw,\n            CASE WHEN p.\"gradedAt\" IS NOT NULL AND floor(extract(epoch FROM p.\"gameTime\" - k.t0) / $38::int)::int BETWEEN 0 AND $39 THEN floor(extract(epoch FROM p.\"gameTime\" - k.t0) / $40::int)::int END AS gw\n          FROM picks p CROSS JOIN (SELECT $41::timestamp AS t0 OFFSET 0) k\n          WHERE p.\"userId\" = $42 AND p.\"capperId\" IN (SELECT id FROM roster) \n        ) x\n        GROUP BY x.cid, x.dw, x.gw, x.cur\n      ) c\n      GROUP BY GROUPING SETS ((), (c.dw), (c.gw))\n    ),\nov AS (\n      SELECT\n        (SELECT count(*) FROM roster)::int AS \"capperCount\",\n        (SELECT count(*) FROM roster WHERE \"isFavorite\")::int AS \"favCount\",\n        (SELECT count(*) FROM roster WHERE \"createdAt\" >= $43::timestamp)::int AS \"newMonth\",\n        (SELECT jsonb_agg((SELECT count(*) FROM roster r WHERE e.k = $44::int OR r.\"createdAt\" < e.t)::int ORDER BY e.k) FROM (VALUES ($45::int, $46::timestamp),($47::int, $48::timestamp),($49::int, $50::timestamp),($51::int, $52::timestamp),($53::int, $54::timestamp),($55::int, $56::timestamp),($57::int, $58::timestamp),($59::int, $60::timestamp)) e(k, t)) AS wk_tracked,\n        (SELECT cur FROM ag WHERE g = 3) AS cur,\n        (SELECT jsonb_agg(jsonb_build_array(dw, n, nc)) FROM ag WHERE g = 1 AND dw IS NOT NULL) AS wk_posted,\n        (SELECT jsonb_agg(jsonb_build_array(gw, uw, ul, ur)) FROM ag WHERE g = 2 AND gw IS NOT NULL) AS wk_graded,\n        (SELECT COALESCE(sum(wins), 0) FROM ut_r)::int AS wins, (SELECT COALESCE(sum(losses), 0) FROM ut_r)::int AS losses,\n        (SELECT COALESCE(sum(pushes), 0) FROM ut_r)::int AS pushes,\n        (SELECT COALESCE(sum(\"unitsWon\"), 0) FROM ut_r)::float8 AS \"unitsWon\", (SELECT COALESCE(sum(\"unitsLost\"), 0) FROM ut_r)::float8 AS \"unitsLost\",\n        (SELECT COALESCE(sum(\"unitsRisked\"), 0) FROM ut_r)::float8 AS \"unitsRisked\"\n    )\n    SELECT jsonb_build_object($61::text, COALESCE((SELECT jsonb_agg(to_jsonb(o)) FROM ov o), '[]'::jsonb), $62::text, COALESCE((SELECT jsonb_agg(to_jsonb(o)) FROM pg o), '[]'::jsonb), $63::text, COALESCE((SELECT jsonb_agg(to_jsonb(o)) FROM top o), '[]'::jsonb), $64::text, COALESCE((SELECT jsonb_agg(to_jsonb(o)) FROM st o), '[]'::jsonb), $65::text, COALESCE((SELECT jsonb_agg(to_jsonb(o)) FROM stt o), '[]'::jsonb), $66::text, COALESCE((SELECT jsonb_agg(to_jsonb(o)) FROM sp o), '[]'::jsonb), $67::text, COALESCE((SELECT jsonb_agg(to_jsonb(o)) FROM sl o), '[]'::jsonb), $68::text, COALESCE((SELECT jsonb_agg(to_jsonb(o)) FROM tsl o), '[]'::jsonb), $69::text, COALESCE((SELECT jsonb_agg(to_jsonb(o)) FROM ma o), '[]'::jsonb), $70::text, COALESCE((SELECT jsonb_agg(to_jsonb(o)) FROM win o), '[]'::jsonb), $71::text, COALESCE((SELECT jsonb_agg(to_jsonb(o)) FROM consistent o), '[]'::jsonb)) AS out\n  ",
    "expectLabel": null,
    "expectFlags": []
  },
  {
    "name": "control: /cappers/[id] bundle",
    "run": "52a3260",
    "sql": "\n    WITH w(win, wstart, wend) AS (VALUES ($1::text, NULL::timestamp, NULL::timestamp)), totals AS (SELECT * FROM (\n    SELECT\n      p.\"capperId\" AS \"capperId\",\n      w.win AS \"window\",\n      \n      count(*)::int AS \"nPicks\",\n      (count(*) FILTER (WHERE p.status = 'WIN'))::int AS \"wins\",\n      (count(*) FILTER (WHERE p.status = 'LOSS'))::int AS \"losses\",\n      (count(*) FILTER (WHERE p.status = 'PUSH'))::int AS \"pushes\",\n      COALESCE(sum(p.units * (CASE WHEN p.odds > 0 THEN p.odds::float8 / 100::float8 ELSE 100::float8 / NULLIF(abs(p.odds), 0)::float8 END) ORDER BY p.\"gameTime\", p.\"createdAt\", p.id COLLATE \"C\") FILTER (WHERE p.status = 'WIN' AND p.odds <> 0), 0)::float8 AS \"unitsWon\",\n      COALESCE(sum(p.units ORDER BY p.\"gameTime\", p.\"createdAt\", p.id COLLATE \"C\") FILTER (WHERE p.status = 'LOSS'), 0)::float8 AS \"unitsLost\",\n      COALESCE(sum(p.units ORDER BY p.\"gameTime\", p.\"createdAt\", p.id COLLATE \"C\") FILTER (WHERE p.status IN ('WIN', 'LOSS', 'PUSH')), 0)::float8 AS \"unitsRisked\",\n      COALESCE(bit_or(CASE WHEN p.units > 0 THEN 1 WHEN p.units < 0 THEN 2 ELSE 4 END) FILTER (WHERE p.status = 'WIN' AND p.odds = 0), 0)::int AS \"zeroOddsWinFlags\"\n    FROM picks p\n    JOIN w ON (w.wstart IS NULL OR (p.\"gradedAt\" IS NOT NULL AND p.\"gameTime\" >= w.wstart AND p.\"gameTime\" < w.wend))\n    \n    WHERE p.\"userId\" = $2 AND p.\"capperId\" IN ($3)\n    GROUP BY p.\"capperId\",w.win\n  ) t WHERE t.\"window\" = $4), sportTotals AS (SELECT * FROM (\n    SELECT\n      p.\"capperId\" AS \"capperId\",\n      w.win AS \"window\",\n      s.name AS \"sport\",\n      count(*)::int AS \"nPicks\",\n      (count(*) FILTER (WHERE p.status = 'WIN'))::int AS \"wins\",\n      (count(*) FILTER (WHERE p.status = 'LOSS'))::int AS \"losses\",\n      (count(*) FILTER (WHERE p.status = 'PUSH'))::int AS \"pushes\",\n      COALESCE(sum(p.units * (CASE WHEN p.odds > 0 THEN p.odds::float8 / 100::float8 ELSE 100::float8 / NULLIF(abs(p.odds), 0)::float8 END) ORDER BY p.\"gameTime\", p.\"createdAt\", p.id COLLATE \"C\") FILTER (WHERE p.status = 'WIN' AND p.odds <> 0), 0)::float8 AS \"unitsWon\",\n      COALESCE(sum(p.units ORDER BY p.\"gameTime\", p.\"createdAt\", p.id COLLATE \"C\") FILTER (WHERE p.status = 'LOSS'), 0)::float8 AS \"unitsLost\",\n      COALESCE(sum(p.units ORDER BY p.\"gameTime\", p.\"createdAt\", p.id COLLATE \"C\") FILTER (WHERE p.status IN ('WIN', 'LOSS', 'PUSH')), 0)::float8 AS \"unitsRisked\",\n      COALESCE(bit_or(CASE WHEN p.units > 0 THEN 1 WHEN p.units < 0 THEN 2 ELSE 4 END) FILTER (WHERE p.status = 'WIN' AND p.odds = 0), 0)::int AS \"zeroOddsWinFlags\"\n    FROM picks p\n    JOIN w ON (w.wstart IS NULL OR (p.\"gradedAt\" IS NOT NULL AND p.\"gameTime\" >= w.wstart AND p.\"gameTime\" < w.wend))\n    JOIN sports s ON s.id = p.\"sportId\"\n    WHERE p.\"userId\" = $5 AND p.\"capperId\" IN ($6)\n    GROUP BY p.\"capperId\",w.win,s.name\n  ) t WHERE t.\"window\" = $7), tiles AS (\n    SELECT\n      w.win AS \"window\",\n      s.name AS \"sport\",\n      p.category AS \"category\",\n      (count(*) FILTER (WHERE p.status = 'WIN'))::int AS \"wins\",\n      (count(*) FILTER (WHERE p.status = 'LOSS'))::int AS \"losses\",\n      (count(*) FILTER (WHERE p.status = 'PUSH'))::int AS \"pushes\",\n      COALESCE(sum(p.units * (CASE WHEN p.odds > 0 THEN p.odds::float8 / 100::float8 ELSE 100::float8 / NULLIF(abs(p.odds), 0)::float8 END)) FILTER (WHERE p.status = 'WIN'), 0)::float8 AS \"unitsWon\",\n      COALESCE(sum(p.units) FILTER (WHERE p.status = 'LOSS'), 0)::float8 AS \"unitsLost\"\n    FROM picks p\n    JOIN w ON (w.wstart IS NULL OR (p.\"gradedAt\" IS NOT NULL AND p.\"gameTime\" >= w.wstart AND p.\"gameTime\" < w.wend))\n    JOIN sports s ON s.id = p.\"sportId\"\n    WHERE p.\"userId\" = $8 AND p.\"capperId\" = $9\n      AND p.status IN ('WIN', 'LOSS', 'PUSH')\n      AND p.category IS NOT NULL\n      \n    GROUP BY w.win,s.name,p.category\n  ), firstKeys AS (\n    SELECT s.name AS \"sport\", min((lpad(round(extract(epoch FROM p.\"gameTime\") * 1000)::bigint::text, 15, '0') || lpad(round(extract(epoch FROM p.\"createdAt\") * 1000)::bigint::text, 15, '0') || p.id) COLLATE \"C\") AS \"firstKey\"\n    FROM picks p\n    JOIN sports s ON s.id = p.\"sportId\"\n    WHERE p.\"userId\" = $10 AND p.\"capperId\" = $11\n    GROUP BY s.name\n  ), recent AS (\n    SELECT row_number() OVER (ORDER BY p.\"gameTime\" DESC, p.\"createdAt\" DESC, p.id COLLATE \"C\" DESC)::int AS \"rn\",\n           p.id AS \"id\", p.\"awayTeam\" AS \"awayTeam\", p.\"homeTeam\" AS \"homeTeam\",\n           p.\"betDetail\" AS \"betDetail\", p.\"betType\"::text AS \"betType\", p.line AS \"line\",\n           p.odds AS \"odds\", p.units AS \"units\",\n           round(extract(epoch FROM p.\"gameTime\") * 1000)::bigint AS \"gameTime\",\n           p.status::text AS \"status\", s.name AS \"sport\"\n    FROM picks p\n    JOIN sports s ON s.id = p.\"sportId\"\n    WHERE p.\"userId\" = $12 AND p.\"capperId\" = $13  \n    ORDER BY p.\"gameTime\" DESC, p.\"createdAt\" DESC, p.id COLLATE \"C\" DESC\n    LIMIT $14::int\n  ), series AS (\n    SELECT p.id AS \"id\",\n           round(extract(epoch FROM p.\"createdAt\") * 1000)::bigint AS \"createdAt\",\n           round(extract(epoch FROM p.\"gameTime\") * 1000)::bigint AS \"gameTime\",\n           CASE WHEN p.\"gradedAt\" IS NULL THEN NULL ELSE round(extract(epoch FROM p.\"gradedAt\") * 1000)::bigint END AS \"gradedAt\",\n           p.status::text AS \"status\", p.units AS \"units\", p.odds AS \"odds\", s.name AS \"sport\"\n    FROM picks p\n    JOIN sports s ON s.id = p.\"sportId\"\n    WHERE p.\"userId\" = $15 AND p.\"capperId\" = $16\n      AND p.status IN ('WIN', 'LOSS', 'PUSH')\n    ORDER BY p.\"gameTime\", p.\"createdAt\", p.id COLLATE \"C\"\n  ), meta AS (\n    SELECT count(*)::int AS \"count\",\n           (count(*) FILTER (WHERE p.status = 'PENDING'))::int AS \"pending\",\n           round(extract(epoch FROM min(p.\"datePosted\")) * 1000)::bigint AS \"trackedSince\",\n           round(extract(epoch FROM max(p.\"datePosted\")) * 1000)::bigint AS \"lastPick\"\n    FROM picks p\n    WHERE p.\"userId\" = $17 AND p.\"capperId\" = $18\n  )\n    SELECT jsonb_build_object($19::text, COALESCE((SELECT jsonb_agg(to_jsonb(bundle_row)) FROM totals bundle_row), '[]'::jsonb), $20::text, COALESCE((SELECT jsonb_agg(to_jsonb(bundle_row)) FROM sportTotals bundle_row), '[]'::jsonb), $21::text, COALESCE((SELECT jsonb_agg(to_jsonb(bundle_row)) FROM tiles bundle_row), '[]'::jsonb), $22::text, COALESCE((SELECT jsonb_agg(to_jsonb(bundle_row)) FROM firstKeys bundle_row), '[]'::jsonb), $23::text, COALESCE((SELECT jsonb_agg(to_jsonb(bundle_row) ORDER BY \"rn\") FROM recent bundle_row), '[]'::jsonb), $24::text, COALESCE((SELECT jsonb_agg(to_jsonb(bundle_row) ORDER BY \"gameTime\", \"createdAt\", id COLLATE \"C\") FROM series bundle_row), '[]'::jsonb), $25::text, COALESCE((SELECT jsonb_agg(to_jsonb(bundle_row)) FROM meta bundle_row), '[]'::jsonb)) AS out\n  ",
    "expectLabel": null,
    "expectFlags": []
  },
  {
    "name": "control: /dashboard summary",
    "run": "52a3260",
    "sql": "\n    WITH w(win, wstart, wend) AS (VALUES ($1::text, NULL::timestamp, NULL::timestamp)), totals AS (\n    SELECT\n      NULL::text AS \"capperId\",\n      w.win AS \"window\",\n      \n      count(*)::int AS \"nPicks\",\n      (count(*) FILTER (WHERE p.status = 'WIN'))::int AS \"wins\",\n      (count(*) FILTER (WHERE p.status = 'LOSS'))::int AS \"losses\",\n      (count(*) FILTER (WHERE p.status = 'PUSH'))::int AS \"pushes\",\n      COALESCE(sum(p.units * (CASE WHEN p.odds > 0 THEN p.odds::float8 / 100::float8 ELSE 100::float8 / NULLIF(abs(p.odds), 0)::float8 END) ORDER BY p.\"gameTime\", p.\"createdAt\", p.id COLLATE \"C\") FILTER (WHERE p.status = 'WIN' AND p.odds <> 0), 0)::float8 AS \"unitsWon\",\n      COALESCE(sum(p.units ORDER BY p.\"gameTime\", p.\"createdAt\", p.id COLLATE \"C\") FILTER (WHERE p.status = 'LOSS'), 0)::float8 AS \"unitsLost\",\n      COALESCE(sum(p.units ORDER BY p.\"gameTime\", p.\"createdAt\", p.id COLLATE \"C\") FILTER (WHERE p.status IN ('WIN', 'LOSS', 'PUSH')), 0)::float8 AS \"unitsRisked\",\n      COALESCE(bit_or(CASE WHEN p.units > 0 THEN 1 WHEN p.units < 0 THEN 2 ELSE 4 END) FILTER (WHERE p.status = 'WIN' AND p.odds = 0), 0)::int AS \"zeroOddsWinFlags\"\n    FROM picks p\n    JOIN w ON (w.wstart IS NULL OR (p.\"gradedAt\" IS NOT NULL AND p.\"gameTime\" >= w.wstart AND p.\"gameTime\" < w.wend))\n    \n    WHERE p.\"userId\" = $2 \n    GROUP BY w.win\n  ), tiles AS (\n    SELECT\n      w.win AS \"window\",\n      \n      p.category AS \"category\",\n      (count(*) FILTER (WHERE p.status = 'WIN'))::int AS \"wins\",\n      (count(*) FILTER (WHERE p.status = 'LOSS'))::int AS \"losses\",\n      (count(*) FILTER (WHERE p.status = 'PUSH'))::int AS \"pushes\"\n    FROM picks p\n    JOIN w ON (w.wstart IS NULL OR (p.\"gradedAt\" IS NOT NULL AND p.\"gameTime\" >= w.wstart AND p.\"gameTime\" < w.wend))\n    \n    WHERE p.\"userId\" = $3 \n      AND p.status IN ('WIN', 'LOSS', 'PUSH')\n      AND p.category IS NOT NULL\n      AND p.category = ANY($4::text[])\n    GROUP BY w.win,p.category\n  ), series AS (\n    WITH s AS MATERIALIZED (\n      SELECT\n        (row_number() OVER o - 1)::int AS idx,\n        round(extract(epoch FROM p.\"gameTime\") * 1000)::bigint AS t,\n        sum(CASE WHEN p.status = 'WIN' THEN COALESCE(p.units * (CASE WHEN p.odds > 0 THEN p.odds::float8 / 100::float8 ELSE 100::float8 / NULLIF(abs(p.odds), 0)::float8 END), 0::float8)\n                 WHEN p.status = 'LOSS' THEN 0::float8 - p.units\n                 ELSE 0::float8 END) OVER o AS run,\n        COALESCE(bit_or(CASE WHEN p.status = 'WIN' AND p.odds = 0\n                             THEN (CASE WHEN p.units > 0 THEN 1 WHEN p.units < 0 THEN 2 ELSE 4 END)\n                             ELSE 0 END) OVER o, 0)::int AS flags\n      FROM picks p\n      WHERE p.\"userId\" = $5  AND p.status IN ('WIN', 'LOSS', 'PUSH')\n      WINDOW o AS (ORDER BY p.\"gameTime\", p.\"createdAt\", p.id COLLATE \"C\" ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)\n    ),\n    c AS MATERIALIZED (\n      SELECT s.idx, s.t, s.run, s.flags,\n             ((CASE WHEN (s.run * 100::float8) - floor((s.run * 100::float8)) >= 0.5::float8 THEN ceil((s.run * 100::float8)) ELSE floor((s.run * 100::float8)) END) / 100::float8) AS cum,\n             count(*) OVER () AS n,\n             bool_or(s.flags <> 0) OVER () AS anyflag\n      FROM s\n    ),\n    bk AS (\n      SELECT COALESCE(max(n) > $6::int AND NOT bool_or(anyflag), false) AS \"on\",\n             max(n)::int AS n,\n             ((max(n) - 2)::float8 / $7::float8) AS bs\n      FROM c\n    ),\n    -- Each interior row's bucket. Candidates b0-1..b0+1 around the analytic bucket, then the\n    -- EXACT float64 bounds decide membership, so a row JS's floor() arithmetic puts in no\n    -- bucket (or one) is treated identically here.\n    asg AS (\n      SELECT c.idx, c.cum, x.b\n      FROM c CROSS JOIN bk\n      CROSS JOIN LATERAL (\n        SELECT g AS b\n        FROM generate_series(\n          GREATEST(floor((c.idx - 1)::float8 / bk.bs)::int - 1, 0),\n          LEAST(floor((c.idx - 1)::float8 / bk.bs)::int + 1, $8::int - 1)\n        ) g\n        WHERE c.idx >= 1 + floor(g::float8 * bk.bs)::int\n          AND c.idx < 1 + floor((g + 1)::float8 * bk.bs)::int\n      ) x\n      WHERE bk.\"on\" AND c.idx >= 1 AND c.idx <= bk.n - 2\n    ),\n    ext AS (SELECT b, min(cum) AS mn, max(cum) AS mx FROM asg GROUP BY b),\n    sel AS (\n      SELECT min(a.idx) FILTER (WHERE a.cum = e.mn) AS lo_i,\n             min(a.idx) FILTER (WHERE a.cum = e.mx) AS hi_i\n      FROM asg a JOIN ext e ON e.b = a.b\n      GROUP BY a.b\n    ),\n    keep AS (\n      SELECT 0 AS idx FROM bk WHERE bk.\"on\"\n      UNION SELECT bk.n - 1 FROM bk WHERE bk.\"on\"\n      UNION SELECT lo_i FROM sel\n      UNION SELECT hi_i FROM sel\n    )\n    SELECT c.idx AS \"idx\", c.t AS \"t\", c.run AS \"run\", c.flags AS \"flags\"\n    FROM c CROSS JOIN bk\n    WHERE NOT bk.\"on\" OR c.idx IN (SELECT idx FROM keep)\n    ORDER BY c.idx\n  ), recent AS (\n    SELECT row_number() OVER (ORDER BY p.\"gameTime\" DESC, p.\"createdAt\" DESC, p.id COLLATE \"C\" DESC)::int AS \"rn\",\n           p.id AS \"id\", p.\"awayTeam\" AS \"awayTeam\", p.\"homeTeam\" AS \"homeTeam\",\n           p.\"betDetail\" AS \"betDetail\", p.\"betType\"::text AS \"betType\", p.line AS \"line\",\n           p.status::text AS \"status\", p.units AS \"units\", c.name AS \"capperName\"\n    FROM picks p\n    JOIN cappers c ON c.id = p.\"capperId\"\n    WHERE p.\"userId\" = $9\n    ORDER BY p.\"gameTime\" DESC, p.\"createdAt\" DESC, p.id COLLATE \"C\" DESC\n    LIMIT $10::int\n  ), pending AS (\n    SELECT (count(*) FILTER (WHERE p.status = 'PENDING'))::int AS \"pending\",\n           (count(*) FILTER (WHERE p.status = 'PENDING' AND p.\"gameTime\" < $11::timestamp))::int AS \"stale\"\n    FROM picks p\n    WHERE p.\"userId\" = $12\n  ), weekly AS (\n    SELECT 'posted'::text AS \"kind\", x.wk AS \"week\", count(*)::int AS \"n\",\n           0::int AS \"wins\", 0::int AS \"losses\", 0::int AS \"pushes\",\n           0::float8 AS \"unitsWon\", 0::float8 AS \"unitsLost\", 0::float8 AS \"unitsRisked\"\n    FROM (\n      SELECT floor(extract(epoch FROM p.\"datePosted\" - $13::timestamp) / $14::int)::int AS wk\n      FROM picks p\n      WHERE p.\"userId\" = $15 AND p.\"datePosted\" >= $16::timestamp AND p.\"datePosted\" < $17::timestamp\n    ) x\n    GROUP BY x.wk\n    UNION ALL\n    SELECT 'graded'::text, x.wk, count(*)::int,\n           (count(*) FILTER (WHERE x.st = 'WIN'))::int, (count(*) FILTER (WHERE x.st = 'LOSS'))::int, (count(*) FILTER (WHERE x.st = 'PUSH'))::int,\n           COALESCE(sum(x.win_units) FILTER (WHERE x.st = 'WIN' AND x.odds <> 0), 0)::float8,\n           COALESCE(sum(x.units) FILTER (WHERE x.st = 'LOSS'), 0)::float8,\n           COALESCE(sum(x.units), 0)::float8\n    FROM (\n      SELECT floor(extract(epoch FROM p.\"gameTime\" - $18::timestamp) / $19::int)::int AS wk, p.status::text AS st, p.units, p.odds, p.units * (CASE WHEN p.odds > 0 THEN p.odds::float8 / 100::float8 ELSE 100::float8 / NULLIF(abs(p.odds), 0)::float8 END) AS win_units\n      FROM picks p\n      WHERE p.\"userId\" = $20 AND p.status IN ('WIN', 'LOSS', 'PUSH') AND p.\"gameTime\" >= $21::timestamp AND p.\"gameTime\" < $22::timestamp\n    ) x\n    GROUP BY x.wk\n  ), roster AS (\n    SELECT count(*)::int AS \"count\",\n           (count(*) FILTER (WHERE c.\"createdAt\" >= $23::timestamp))::int AS \"newMonth\",\n           (SELECT jsonb_agg((SELECT count(*) FROM cappers r WHERE r.\"userId\" = $24 AND NOT r.\"isTest\" AND r.\"createdAt\" < e.t)::int ORDER BY e.k)\n            FROM (VALUES ($25::int, $26::timestamp),($27::int, $28::timestamp),($29::int, $30::timestamp),($31::int, $32::timestamp),($33::int, $34::timestamp),($35::int, $36::timestamp),($37::int, $38::timestamp),($39::int, $40::timestamp)) e(k, t)) AS \"tracked\"\n    FROM cappers c\n    WHERE c.\"userId\" = $41 AND NOT c.\"isTest\"\n  )\n    SELECT jsonb_build_object($42::text, COALESCE((SELECT jsonb_agg(to_jsonb(bundle_row)) FROM totals bundle_row), '[]'::jsonb), $43::text, COALESCE((SELECT jsonb_agg(to_jsonb(bundle_row)) FROM tiles bundle_row), '[]'::jsonb), $44::text, COALESCE((SELECT jsonb_agg(to_jsonb(bundle_row) ORDER BY idx) FROM series bundle_row), '[]'::jsonb), $45::text, COALESCE((SELECT jsonb_agg(to_jsonb(bundle_row) ORDER BY \"rn\") FROM recent bundle_row), '[]'::jsonb), $46::text, COALESCE((SELECT jsonb_agg(to_jsonb(bundle_row)) FROM pending bundle_row), '[]'::jsonb), $47::text, COALESCE((SELECT jsonb_agg(to_jsonb(bundle_row)) FROM weekly bundle_row), '[]'::jsonb), $48::text, COALESCE((SELECT jsonb_agg(to_jsonb(bundle_row)) FROM roster bundle_row), '[]'::jsonb)) AS out\n  ",
    "expectLabel": null,
    "expectFlags": []
  },
  {
    "name": "capper include, full row (pre-#277 board)",
    "run": "52a3260",
    "sql": "SELECT \"public\".\"cappers\".\"id\", \"public\".\"cappers\".\"userId\", \"public\".\"cappers\".\"name\", \"public\".\"cappers\".\"photoUrl\", \"public\".\"cappers\".\"source\"::text, \"public\".\"cappers\".\"customSource\", \"public\".\"cappers\".\"notes\", \"public\".\"cappers\".\"isFavorite\", \"public\".\"cappers\".\"isTest\", \"public\".\"cappers\".\"sportSpecialization\", \"public\".\"cappers\".\"colorTag\", \"public\".\"cappers\".\"createdAt\", \"public\".\"cappers\".\"updatedAt\" FROM \"public\".\"cappers\" WHERE \"public\".\"cappers\".\"id\" IN ($1,$2) OFFSET $3",
    "expectLabel": "Capper include",
    "expectFlags": []
  },
  {
    "name": "grading sport lookup (findUnique by name)",
    "run": "52a3260",
    "sql": "SELECT \"public\".\"sports\".\"id\", \"public\".\"sports\".\"name\" FROM \"public\".\"sports\" WHERE (\"public\".\"sports\".\"name\" = $1 AND 1=1) LIMIT $2 OFFSET $3",
    "expectLabel": "Grading sport lookup",
    "expectFlags": []
  },
  {
    "name": "retired A: fetchPicksByCapper",
    "run": "b1b7874 (pre-#128)",
    "sql": "SELECT \"public\".\"picks\".\"id\", \"public\".\"picks\".\"userId\", \"public\".\"picks\".\"capperId\", \"public\".\"picks\".\"sportId\", \"public\".\"picks\".\"leagueId\", \"public\".\"picks\".\"homeTeam\", \"public\".\"picks\".\"awayTeam\", \"public\".\"picks\".\"betType\"::text, \"public\".\"picks\".\"betDetail\", \"public\".\"picks\".\"odds\", \"public\".\"picks\".\"line\", \"public\".\"picks\".\"period\"::text, \"public\".\"picks\".\"sportsbook\", \"public\".\"picks\".\"units\", \"public\".\"picks\".\"datePosted\", \"public\".\"picks\".\"gameTime\", \"public\".\"picks\".\"notes\", \"public\".\"picks\".\"status\"::text, \"public\".\"picks\".\"gradedAt\", \"public\".\"picks\".\"gradedViaFuzzyMatch\", \"public\".\"picks\".\"pickedSide\"::text, \"public\".\"picks\".\"mlFavoredSide\"::text, \"public\".\"picks\".\"playerName\", \"public\".\"picks\".\"propMarket\"::text, \"public\".\"picks\".\"gameNumber\", \"public\".\"picks\".\"category\", \"public\".\"picks\".\"categoryVersion\", \"public\".\"picks\".\"createdAt\", \"public\".\"picks\".\"updatedAt\" FROM \"public\".\"picks\" WHERE (\"public\".\"picks\".\"userId\" = $1 AND \"public\".\"picks\".\"capperId\" IN ($2,$3,$4)) OFFSET $5",
    "expectLabel": null,
    "expectFlags": [
      "RETIRED_A",
      "UNLABELED_FULL_ROW"
    ]
  },
  {
    "name": "retired B: raw getSportCategoryPanelData",
    "run": "b1b7874 (pre-#128)",
    "sql": "SELECT \"public\".\"picks\".\"id\", \"public\".\"picks\".\"userId\", \"public\".\"picks\".\"capperId\", \"public\".\"picks\".\"sportId\", \"public\".\"picks\".\"leagueId\", \"public\".\"picks\".\"homeTeam\", \"public\".\"picks\".\"awayTeam\", \"public\".\"picks\".\"betType\"::text, \"public\".\"picks\".\"betDetail\", \"public\".\"picks\".\"odds\", \"public\".\"picks\".\"line\", \"public\".\"picks\".\"period\"::text, \"public\".\"picks\".\"sportsbook\", \"public\".\"picks\".\"units\", \"public\".\"picks\".\"datePosted\", \"public\".\"picks\".\"gameTime\", \"public\".\"picks\".\"notes\", \"public\".\"picks\".\"status\"::text, \"public\".\"picks\".\"gradedAt\", \"public\".\"picks\".\"gradedViaFuzzyMatch\", \"public\".\"picks\".\"pickedSide\"::text, \"public\".\"picks\".\"mlFavoredSide\"::text, \"public\".\"picks\".\"playerName\", \"public\".\"picks\".\"propMarket\"::text, \"public\".\"picks\".\"gameNumber\", \"public\".\"picks\".\"category\", \"public\".\"picks\".\"categoryVersion\", \"public\".\"picks\".\"createdAt\", \"public\".\"picks\".\"updatedAt\" FROM \"public\".\"picks\" LEFT JOIN \"public\".\"sports\" AS \"j1\" ON (\"j1\".\"id\") = (\"public\".\"picks\".\"sportId\") WHERE (\"public\".\"picks\".\"userId\" = $1 AND (\"j1\".\"name\" = $2 AND (\"j1\".\"id\" IS NOT NULL))) OFFSET $3",
    "expectLabel": null,
    "expectFlags": [
      "RETIRED_B",
      "UNLABELED_FULL_ROW"
    ]
  },
  {
    "name": "retired C: getPickRowsForStats",
    "run": "b1b7874 (pre-#128)",
    "sql": "SELECT \"public\".\"picks\".\"id\", \"public\".\"picks\".\"userId\", \"public\".\"picks\".\"capperId\", \"public\".\"picks\".\"sportId\", \"public\".\"picks\".\"leagueId\", \"public\".\"picks\".\"homeTeam\", \"public\".\"picks\".\"awayTeam\", \"public\".\"picks\".\"betType\"::text, \"public\".\"picks\".\"betDetail\", \"public\".\"picks\".\"odds\", \"public\".\"picks\".\"line\", \"public\".\"picks\".\"period\"::text, \"public\".\"picks\".\"sportsbook\", \"public\".\"picks\".\"units\", \"public\".\"picks\".\"datePosted\", \"public\".\"picks\".\"gameTime\", \"public\".\"picks\".\"notes\", \"public\".\"picks\".\"status\"::text, \"public\".\"picks\".\"gradedAt\", \"public\".\"picks\".\"gradedViaFuzzyMatch\", \"public\".\"picks\".\"pickedSide\"::text, \"public\".\"picks\".\"mlFavoredSide\"::text, \"public\".\"picks\".\"playerName\", \"public\".\"picks\".\"propMarket\"::text, \"public\".\"picks\".\"gameNumber\", \"public\".\"picks\".\"category\", \"public\".\"picks\".\"categoryVersion\", \"public\".\"picks\".\"createdAt\", \"public\".\"picks\".\"updatedAt\" FROM \"public\".\"picks\" WHERE \"public\".\"picks\".\"userId\" = $1 ORDER BY \"public\".\"picks\".\"gameTime\" DESC OFFSET $2",
    "expectLabel": null,
    "expectFlags": [
      "RETIRED_C",
      "UNLABELED_FULL_ROW"
    ]
  },
  {
    "name": "session user",
    "run": "52f483d",
    "sql": "SELECT \"public\".\"users\".\"id\", \"public\".\"users\".\"supabaseId\", \"public\".\"users\".\"email\", \"public\".\"users\".\"name\", \"public\".\"users\".\"profilePictureUrl\", \"public\".\"users\".\"themePreference\"::text, \"public\".\"users\".\"createdAt\", \"public\".\"users\".\"updatedAt\" FROM \"public\".\"users\" WHERE (\"public\".\"users\".\"supabaseId\" = $1 AND 1=1) LIMIT $2 OFFSET $3",
    "expectLabel": "Session user",
    "expectFlags": []
  },
  {
    "name": "capper roster (getCappersForUser)",
    "run": "52f483d",
    "sql": "SELECT \"public\".\"cappers\".\"id\", \"public\".\"cappers\".\"userId\", \"public\".\"cappers\".\"name\", \"public\".\"cappers\".\"photoUrl\", \"public\".\"cappers\".\"source\"::text, \"public\".\"cappers\".\"customSource\", \"public\".\"cappers\".\"notes\", \"public\".\"cappers\".\"isFavorite\", \"public\".\"cappers\".\"isTest\", \"public\".\"cappers\".\"sportSpecialization\", \"public\".\"cappers\".\"colorTag\", \"public\".\"cappers\".\"createdAt\", \"public\".\"cappers\".\"updatedAt\" FROM \"public\".\"cappers\" WHERE \"public\".\"cappers\".\"userId\" = $1 ORDER BY \"public\".\"cappers\".\"isFavorite\" DESC, \"public\".\"cappers\".\"name\" ASC OFFSET $2",
    "expectLabel": "Capper roster",
    "expectFlags": []
  },
  {
    "name": "capper include, full row (getPendingPicksForUser)",
    "run": "52f483d",
    "sql": "SELECT \"public\".\"cappers\".\"id\", \"public\".\"cappers\".\"userId\", \"public\".\"cappers\".\"name\", \"public\".\"cappers\".\"photoUrl\", \"public\".\"cappers\".\"source\"::text, \"public\".\"cappers\".\"customSource\", \"public\".\"cappers\".\"notes\", \"public\".\"cappers\".\"isFavorite\", \"public\".\"cappers\".\"isTest\", \"public\".\"cappers\".\"sportSpecialization\", \"public\".\"cappers\".\"colorTag\", \"public\".\"cappers\".\"createdAt\", \"public\".\"cappers\".\"updatedAt\" FROM \"public\".\"cappers\" WHERE \"public\".\"cappers\".\"id\" IN ($1,$2,$3,$4,$5) OFFSET $6",
    "expectLabel": "Capper include",
    "expectFlags": []
  },
  {
    "name": "capper include, projected (getPicksForGames)",
    "run": "52f483d",
    "sql": "SELECT \"public\".\"cappers\".\"id\", \"public\".\"cappers\".\"name\", \"public\".\"cappers\".\"colorTag\", \"public\".\"cappers\".\"isFavorite\" FROM \"public\".\"cappers\" WHERE \"public\".\"cappers\".\"id\" IN ($1,$2,$3) OFFSET $4",
    "expectLabel": "Capper include",
    "expectFlags": []
  },
  {
    "name": "cappers with pick counts",
    "run": "52f483d",
    "sql": "SELECT \"public\".\"cappers\".\"id\", \"public\".\"cappers\".\"name\", COALESCE(\"aggr_selection_0_Pick\".\"_aggr_count_picks\", 0) AS \"_aggr_count_picks\" FROM \"public\".\"cappers\" LEFT JOIN (SELECT \"public\".\"picks\".\"capperId\", COUNT(*) AS \"_aggr_count_picks\" FROM \"public\".\"picks\" WHERE 1=1 GROUP BY \"public\".\"picks\".\"capperId\") AS \"aggr_selection_0_Pick\" ON (\"public\".\"cappers\".\"id\" = \"aggr_selection_0_Pick\".\"capperId\") WHERE \"public\".\"cappers\".\"userId\" = $1 ORDER BY \"public\".\"cappers\".\"name\" ASC OFFSET $2",
    "expectLabel": "Cappers with pick counts",
    "expectFlags": []
  },
  {
    "name": "capper all-time W-L",
    "run": "52f483d",
    "sql": "SELECT COUNT(*), \"public\".\"picks\".\"capperId\", \"public\".\"picks\".\"status\"::text FROM \"public\".\"picks\" WHERE (\"public\".\"picks\".\"userId\" = $1 AND \"public\".\"picks\".\"capperId\" IN ($2,$3,$4) AND \"public\".\"picks\".\"status\" IN (CAST($5::text AS \"public\".\"PickStatus\"),CAST($6::text AS \"public\".\"PickStatus\"))) GROUP BY \"public\".\"picks\".\"capperId\", \"public\".\"picks\".\"status\" OFFSET $7",
    "expectLabel": "Capper all-time W-L",
    "expectFlags": []
  },
  {
    "name": "/picks final scores",
    "run": "52f483d",
    "sql": "SELECT \"public\".\"game_results\".\"id\", \"public\".\"game_results\".\"sportKey\", \"public\".\"game_results\".\"gameDate\", \"public\".\"game_results\".\"homeTeam\", \"public\".\"game_results\".\"awayTeam\", \"public\".\"game_results\".\"homeScore\", \"public\".\"game_results\".\"awayScore\", \"public\".\"game_results\".\"gameNumber\" FROM \"public\".\"game_results\" WHERE (\"public\".\"game_results\".\"sportKey\" IN ($1,$2) AND \"public\".\"game_results\".\"gameDate\" >= $3 AND \"public\".\"game_results\".\"gameDate\" < $4) OFFSET $5",
    "expectLabel": "/picks final scores",
    "expectFlags": []
  },
  {
    "name": "day consensus (SQL)",
    "run": "52f483d",
    "sql": "\n    SELECT b.\"homeTeam\", b.\"awayTeam\", b.\"gameTime\", b.bt, b.period, b.side, count(DISTINCT b.\"capperId\")::int AS n\n    FROM (\n      SELECT p.\"capperId\", p.\"homeTeam\", p.\"awayTeam\", p.\"gameTime\", p.\"betType\"::text AS bt, p.period::text AS period, CASE\n  WHEN p.\"betType\" IN ('MONEYLINE', 'SPREAD') THEN p.\"pickedSide\"::text\n  WHEN p.\"betType\" = 'TOTAL' AND p.category LIKE '%OVER' THEN 'OVER'\n  WHEN p.\"betType\" = 'TOTAL' AND p.category LIKE '%UNDER' THEN 'UNDER'\n  WHEN p.\"betType\" = 'NRFI' AND p.category IN ('NRFI', 'YRFI') THEN p.category\nEND AS side\n      FROM picks p\n      WHERE p.\"userId\" = $1 AND p.\"gameTime\" >= $2::timestamp AND p.\"gameTime\" < $3::timestamp\n    ) b\n    WHERE b.side IS NOT NULL\n    GROUP BY b.\"homeTeam\", b.\"awayTeam\", b.\"gameTime\", b.bt, b.period, b.side\n    HAVING count(DISTINCT b.\"capperId\") >= $4\n  ",
    "expectLabel": "Day consensus",
    "expectFlags": []
  },
  {
    "name": "zone model: game results",
    "run": "52f483d",
    "sql": "SELECT \"public\".\"game_results\".\"id\", \"public\".\"game_results\".\"homeTeam\", \"public\".\"game_results\".\"awayTeam\", \"public\".\"game_results\".\"homeScore\", \"public\".\"game_results\".\"awayScore\", \"public\".\"game_results\".\"favTeam\", \"public\".\"game_results\".\"totalLine\", \"public\".\"game_results\".\"gameDate\" FROM \"public\".\"game_results\" WHERE \"public\".\"game_results\".\"sportKey\" = $1 OFFSET $2",
    "expectLabel": "Zone model",
    "expectFlags": []
  },
  {
    "name": "zone model: tendency snapshots",
    "run": "52f483d",
    "sql": "SELECT \"public\".\"team_tendency_snapshots\".\"id\", \"public\".\"team_tendency_snapshots\".\"sportKey\", \"public\".\"team_tendency_snapshots\".\"teamName\", \"public\".\"team_tendency_snapshots\".\"snapshotDate\", \"public\".\"team_tendency_snapshots\".\"favWins\", \"public\".\"team_tendency_snapshots\".\"favLosses\", \"public\".\"team_tendency_snapshots\".\"favPushes\", \"public\".\"team_tendency_snapshots\".\"dogWins\", \"public\".\"team_tendency_snapshots\".\"dogLosses\", \"public\".\"team_tendency_snapshots\".\"dogPushes\", \"public\".\"team_tendency_snapshots\".\"overCount\", \"public\".\"team_tendency_snapshots\".\"underCount\", \"public\".\"team_tendency_snapshots\".\"totalPushCount\", \"public\".\"team_tendency_snapshots\".\"sourceId\", \"public\".\"team_tendency_snapshots\".\"scope\"::text, \"public\".\"team_tendency_snapshots\".\"createdAt\" FROM \"public\".\"team_tendency_snapshots\" WHERE \"public\".\"team_tendency_snapshots\".\"sportKey\" = $1 ORDER BY \"public\".\"team_tendency_snapshots\".\"snapshotDate\" ASC OFFSET $2",
    "expectLabel": "Zone model",
    "expectFlags": []
  },
  {
    "name": "zone model: team stat snapshots",
    "run": "52f483d",
    "sql": "SELECT \"public\".\"team_stat_snapshots\".\"id\", \"public\".\"team_stat_snapshots\".\"sportKey\", \"public\".\"team_stat_snapshots\".\"teamName\", \"public\".\"team_stat_snapshots\".\"snapshotDate\", \"public\".\"team_stat_snapshots\".\"wins\", \"public\".\"team_stat_snapshots\".\"losses\", \"public\".\"team_stat_snapshots\".\"winPct\", \"public\".\"team_stat_snapshots\".\"runDifferential\", \"public\".\"team_stat_snapshots\".\"battingAvg\", \"public\".\"team_stat_snapshots\".\"obp\", \"public\".\"team_stat_snapshots\".\"slg\", \"public\".\"team_stat_snapshots\".\"ops\", \"public\".\"team_stat_snapshots\".\"era\", \"public\".\"team_stat_snapshots\".\"whip\", \"public\".\"team_stat_snapshots\".\"homeWins\", \"public\".\"team_stat_snapshots\".\"homeLosses\", \"public\".\"team_stat_snapshots\".\"awayWins\", \"public\".\"team_stat_snapshots\".\"awayLosses\", \"public\".\"team_stat_snapshots\".\"last10Wins\", \"public\".\"team_stat_snapshots\".\"last10Losses\", \"public\".\"team_stat_snapshots\".\"streakType\", \"public\".\"team_stat_snapshots\".\"streakCount\", \"public\".\"team_stat_snapshots\".\"sourceId\", \"public\".\"team_stat_snapshots\".\"scope\"::text, \"public\".\"team_stat_snapshots\".\"createdAt\" FROM \"public\".\"team_stat_snapshots\" WHERE \"public\".\"team_stat_snapshots\".\"sportKey\" = $1 ORDER BY \"public\".\"team_stat_snapshots\".\"snapshotDate\" ASC OFFSET $2",
    "expectLabel": "Zone model",
    "expectFlags": []
  },
  {
    "name": "game results window (grading candidates)",
    "run": "52f483d",
    "sql": "SELECT \"public\".\"game_results\".\"id\", \"public\".\"game_results\".\"gameDate\", \"public\".\"game_results\".\"homeTeam\", \"public\".\"game_results\".\"awayTeam\", \"public\".\"game_results\".\"externalId\", \"public\".\"game_results\".\"homeScore\", \"public\".\"game_results\".\"awayScore\", \"public\".\"game_results\".\"firstFiveHomeScore\", \"public\".\"game_results\".\"firstFiveAwayScore\", \"public\".\"game_results\".\"firstInningHomeScore\", \"public\".\"game_results\".\"firstInningAwayScore\", \"public\".\"game_results\".\"linescoreJson\", \"public\".\"game_results\".\"gameNumber\" FROM \"public\".\"game_results\" WHERE (\"public\".\"game_results\".\"sportKey\" = $1 AND \"public\".\"game_results\".\"gameDate\" >= $2 AND \"public\".\"game_results\".\"gameDate\" < $3) OFFSET $4",
    "expectLabel": "Game results window",
    "expectFlags": []
  },
  {
    "name": "grading pending legs count()",
    "run": "52f483d",
    "sql": "SELECT COUNT(*) FROM (SELECT \"public\".\"legs\".\"id\" FROM \"public\".\"legs\" WHERE (\"public\".\"legs\".\"sportId\" = $1 AND \"public\".\"legs\".\"status\" = CAST($2::text AS \"public\".\"PickStatus\") AND \"public\".\"legs\".\"gameTime\" >= $3) OFFSET $4) AS \"sub\"",
    "expectLabel": "Grading pending legs",
    "expectFlags": []
  },
  {
    "name": "final-score state (SQL)",
    "run": "52f483d",
    "sql": "\n    SELECT \"externalId\",\n           \"firstFiveHomeScore\",\n           \"firstInningHomeScore\",\n           \"homeTurnovers\",\n           \"favTeam\",\n           (\"linescoreJson\" IS NULL OR \"linescoreJson\" = 'null'::jsonb) AS \"linescoreMissing\",\n           (\"quartersJson\" IS NULL OR \"quartersJson\" = 'null'::jsonb) AS \"quartersMissing\",\n           (\"scoringPlaysJson\" IS NULL OR \"scoringPlaysJson\" = 'null'::jsonb) AS \"scoringPlaysMissing\"\n    FROM game_results\n    WHERE \"sportKey\" = $1 AND \"externalId\" = ANY($2::text[])\n  ",
    "expectLabel": "Final-score state",
    "expectFlags": []
  },
  {
    "name": "odds for tendencies (SQL)",
    "run": "52f483d",
    "sql": "\n      SELECT \n         g.ord::int AS ord,\n         g.game->'homeTeam' AS \"homeTeam\",\n         g.game->'awayTeam' AS \"awayTeam\",\n         g.game->'commenceTime' AS \"commenceTime\",\n         (SELECT COALESCE(jsonb_agg(d.pair ORDER BY d.bord, d.oord), '[]'::jsonb)\n            FROM (\n              SELECT DISTINCT ON (o.oc->'name') b.bord, o.oord, CASE WHEN jsonb_exists(o.oc, 'price') THEN jsonb_build_array(o.oc->'name', o.oc->'price') ELSE jsonb_build_array(o.oc->'name') END AS pair\n                FROM jsonb_array_elements((CASE WHEN jsonb_typeof(g.game->'bookmakers') = 'array' THEN g.game->'bookmakers' ELSE '[]'::jsonb END)) WITH ORDINALITY AS b(bk, bord)\n                CROSS JOIN LATERAL (\n                  SELECT m.mk FROM jsonb_array_elements((CASE WHEN jsonb_typeof(b.bk->'markets') = 'array' THEN b.bk->'markets' ELSE '[]'::jsonb END)) WITH ORDINALITY AS m(mk, mord)\n                   WHERE m.mk->>'key' = 'h2h' ORDER BY m.mord LIMIT 1\n                ) fm\n                CROSS JOIN LATERAL jsonb_array_elements((CASE WHEN jsonb_typeof(fm.mk->'outcomes') = 'array' THEN fm.mk->'outcomes' ELSE '[]'::jsonb END)) WITH ORDINALITY AS o(oc, oord)\n               ORDER BY o.oc->'name', b.bord, o.oord\n            ) d\n         ) AS ml,\n         (SELECT jsonb_build_array(o.oc->'point')\n            FROM jsonb_array_elements((CASE WHEN jsonb_typeof(g.game->'bookmakers') = 'array' THEN g.game->'bookmakers' ELSE '[]'::jsonb END)) WITH ORDINALITY AS b(bk, bord)\n            CROSS JOIN LATERAL (\n              SELECT m.mk FROM jsonb_array_elements((CASE WHEN jsonb_typeof(b.bk->'markets') = 'array' THEN b.bk->'markets' ELSE '[]'::jsonb END)) WITH ORDINALITY AS m(mk, mord)\n               WHERE m.mk->>'key' = 'totals' ORDER BY m.mord LIMIT 1\n            ) fm\n            CROSS JOIN LATERAL jsonb_array_elements((CASE WHEN jsonb_typeof(fm.mk->'outcomes') = 'array' THEN fm.mk->'outcomes' ELSE '[]'::jsonb END)) WITH ORDINALITY AS o(oc, oord)\n           WHERE jsonb_exists(o.oc, 'point')\n           ORDER BY b.bord, o.oord LIMIT 1\n         ) AS pt\n      FROM odds_snapshots s\n      CROSS JOIN LATERAL jsonb_array_elements((CASE WHEN jsonb_typeof(s.data) = 'array' THEN s.data ELSE '[]'::jsonb END)) WITH ORDINALITY AS g(game, ord)\n      WHERE s.\"sportKey\" = $1\n      ORDER BY s.\"fetchDate\", g.ord",
    "expectLabel": "Odds for tendencies",
    "expectFlags": []
  },
  {
    "name": "tendency game results",
    "run": "52f483d",
    "sql": "SELECT \"public\".\"game_results\".\"id\", \"public\".\"game_results\".\"homeTeam\", \"public\".\"game_results\".\"awayTeam\", \"public\".\"game_results\".\"homeScore\", \"public\".\"game_results\".\"awayScore\", \"public\".\"game_results\".\"gameDate\" FROM \"public\".\"game_results\" WHERE (\"public\".\"game_results\".\"sportKey\" = $1 AND \"public\".\"game_results\".\"isPreseason\" = $2) OFFSET $3",
    "expectLabel": "Tendency game results",
    "expectFlags": []
  },
  {
    "name": "tendency upsert",
    "run": "52f483d",
    "sql": "INSERT INTO \"public\".\"team_tendencies\" (\"id\",\"sportKey\",\"teamName\",\"favWins\",\"favLosses\",\"favPushes\",\"dogWins\",\"dogLosses\",\"dogPushes\",\"overCount\",\"underCount\",\"totalPushCount\",\"sourceId\",\"scope\",\"updatedAt\") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,CAST($14::text AS \"public\".\"DataScope\"),$15) ON CONFLICT (\"sportKey\",\"teamName\") DO UPDATE SET \"favWins\" = $16, \"favLosses\" = $17, \"favPushes\" = $18, \"dogWins\" = $19, \"dogLosses\" = $20, \"dogPushes\" = $21, \"overCount\" = $22, \"underCount\" = $23, \"totalPushCount\" = $24, \"updatedAt\" = $25 WHERE ((\"public\".\"team_tendencies\".\"sportKey\" = $26 AND \"public\".\"team_tendencies\".\"teamName\" = $27) AND 1=1) RETURNING \"public\".\"team_tendencies\".\"id\", \"public\".\"team_tendencies\".\"sportKey\", \"public\".\"team_tendencies\".\"teamName\", \"public\".\"team_tendencies\".\"favWins\", \"public\".\"team_tendencies\".\"favLosses\", \"public\".\"team_tendencies\".\"favPushes\", \"public\".\"team_tendencies\".\"dogWins\", \"public\".\"team_tendencies\".\"dogLosses\", \"public\".\"team_tendencies\".\"dogPushes\", \"public\".\"team_tendencies\".\"overCount\", \"public\".\"team_tendencies\".\"underCount\", \"public\".\"team_tendencies\".\"totalPushCount\", \"public\".\"team_tendencies\".\"sourceId\", \"public\".\"team_tendencies\".\"scope\"::text, \"public\".\"team_tendencies\".\"updatedAt\"",
    "expectLabel": "Tendency upsert",
    "expectFlags": []
  },
  {
    "name": "tendencies by sport",
    "run": "52f483d",
    "sql": "SELECT \"public\".\"team_tendencies\".\"id\", \"public\".\"team_tendencies\".\"sportKey\", \"public\".\"team_tendencies\".\"teamName\", \"public\".\"team_tendencies\".\"favWins\", \"public\".\"team_tendencies\".\"favLosses\", \"public\".\"team_tendencies\".\"favPushes\", \"public\".\"team_tendencies\".\"dogWins\", \"public\".\"team_tendencies\".\"dogLosses\", \"public\".\"team_tendencies\".\"dogPushes\", \"public\".\"team_tendencies\".\"overCount\", \"public\".\"team_tendencies\".\"underCount\", \"public\".\"team_tendencies\".\"totalPushCount\", \"public\".\"team_tendencies\".\"sourceId\", \"public\".\"team_tendencies\".\"scope\"::text, \"public\".\"team_tendencies\".\"updatedAt\" FROM \"public\".\"team_tendencies\" WHERE \"public\".\"team_tendencies\".\"sportKey\" = $1 OFFSET $2",
    "expectLabel": "Tendencies by sport",
    "expectFlags": []
  },
  {
    "name": "tendency history (resolveTeamTendency)",
    "run": "52f483d",
    "sql": "SELECT \"public\".\"team_tendency_snapshots\".\"id\", \"public\".\"team_tendency_snapshots\".\"sportKey\", \"public\".\"team_tendency_snapshots\".\"teamName\", \"public\".\"team_tendency_snapshots\".\"snapshotDate\", \"public\".\"team_tendency_snapshots\".\"favWins\", \"public\".\"team_tendency_snapshots\".\"favLosses\", \"public\".\"team_tendency_snapshots\".\"favPushes\", \"public\".\"team_tendency_snapshots\".\"dogWins\", \"public\".\"team_tendency_snapshots\".\"dogLosses\", \"public\".\"team_tendency_snapshots\".\"dogPushes\", \"public\".\"team_tendency_snapshots\".\"overCount\", \"public\".\"team_tendency_snapshots\".\"underCount\", \"public\".\"team_tendency_snapshots\".\"totalPushCount\", \"public\".\"team_tendency_snapshots\".\"sourceId\", \"public\".\"team_tendency_snapshots\".\"scope\"::text, \"public\".\"team_tendency_snapshots\".\"createdAt\" FROM \"public\".\"team_tendency_snapshots\" WHERE (\"public\".\"team_tendency_snapshots\".\"sportKey\" = $1 AND \"public\".\"team_tendency_snapshots\".\"teamName\" = $2) ORDER BY \"public\".\"team_tendency_snapshots\".\"snapshotDate\" ASC OFFSET $3",
    "expectLabel": "Tendency history (model)",
    "expectFlags": []
  },
  {
    "name": "game observations",
    "run": "52f483d",
    "sql": "SELECT \"public\".\"game_results\".\"id\", \"public\".\"game_results\".\"gameDate\", \"public\".\"game_results\".\"favTeam\", \"public\".\"game_results\".\"homeTeam\", \"public\".\"game_results\".\"awayTeam\", \"public\".\"game_results\".\"homeScore\", \"public\".\"game_results\".\"awayScore\", \"public\".\"game_results\".\"totalLine\" FROM \"public\".\"game_results\" WHERE \"public\".\"game_results\".\"sportKey\" = $1 ORDER BY \"public\".\"game_results\".\"gameDate\" ASC OFFSET $2",
    "expectLabel": "Game observations (model)",
    "expectFlags": []
  },
  {
    "name": "decay-delta persisted ids",
    "run": "52f483d",
    "sql": "SELECT \"public\".\"decay_delta_predictions\".\"id\", \"public\".\"decay_delta_predictions\".\"gameResultId\" FROM \"public\".\"decay_delta_predictions\" WHERE (\"public\".\"decay_delta_predictions\".\"modelId\" = $1 AND \"public\".\"decay_delta_predictions\".\"gameResultId\" IS NOT NULL) OFFSET $2",
    "expectLabel": "Decay-delta persisted ids",
    "expectFlags": []
  },
  {
    "name": "team record snapshot read",
    "run": "52f483d",
    "sql": "SELECT \"public\".\"game_results\".\"id\", \"public\".\"game_results\".\"homeTeam\", \"public\".\"game_results\".\"awayTeam\", \"public\".\"game_results\".\"homeScore\", \"public\".\"game_results\".\"awayScore\", \"public\".\"game_results\".\"gameDate\", \"public\".\"game_results\".\"isPreseason\" FROM \"public\".\"game_results\" WHERE \"public\".\"game_results\".\"sportKey\" = $1 OFFSET $2",
    "expectLabel": "Team record snapshot",
    "expectFlags": []
  },
  {
    "name": "team record snapshot upsert",
    "run": "52f483d",
    "sql": "INSERT INTO \"public\".\"team_record_snapshots\" (\"id\",\"sportKey\",\"teamName\",\"snapshotDate\",\"wins\",\"losses\",\"ties\",\"winPct\",\"homeWins\",\"homeLosses\",\"awayWins\",\"awayLosses\",\"last10Wins\",\"last10Losses\",\"streakType\",\"streakCount\",\"gamesInRecord\",\"sourceId\",\"scope\",\"createdAt\") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,CAST($19::text AS \"public\".\"DataScope\"),$20) ON CONFLICT (\"sportKey\",\"teamName\",\"snapshotDate\") DO UPDATE SET \"sportKey\" = $21, \"teamName\" = $22, \"snapshotDate\" = $23, \"wins\" = $24, \"losses\" = $25, \"ties\" = $26, \"winPct\" = $27, \"homeWins\" = $28, \"homeLosses\" = $29, \"awayWins\" = $30, \"awayLosses\" = $31, \"last10Wins\" = $32, \"last10Losses\" = $33, \"streakType\" = $34, \"streakCount\" = $35, \"gamesInRecord\" = $36 WHERE ((\"public\".\"team_record_snapshots\".\"sportKey\" = $37 AND \"public\".\"team_record_snapshots\".\"teamName\" = $38 AND \"public\".\"team_record_snapshots\".\"snapshotDate\" = $39) AND 1=1) RETURNING \"public\".\"team_record_snapshots\".\"id\", \"public\".\"team_record_snapshots\".\"sportKey\", \"public\".\"team_record_snapshots\".\"teamName\", \"public\".\"team_record_snapshots\".\"snapshotDate\", \"public\".\"team_record_snapshots\".\"wins\", \"public\".\"team_record_snapshots\".\"losses\", \"public\".\"team_record_snapshots\".\"ties\", \"public\".\"team_record_snapshots\".\"winPct\", \"public\".\"team_record_snapshots\".\"homeWins\", \"public\".\"team_record_snapshots\".\"homeLosses\", \"public\".\"team_record_snapshots\".\"awayWins\", \"public\".\"team_record_snapshots\".\"awayLosses\", \"public\".\"team_record_snapshots\".\"last10Wins\", \"public\".\"team_record_snapshots\".\"last10Losses\", \"public\".\"team_record_snapshots\".\"streakType\", \"public\".\"team_record_snapshots\".\"streakCount\", \"public\".\"team_record_snapshots\".\"gamesInRecord\", \"public\".\"team_record_snapshots\".\"sourceId\", \"public\".\"team_record_snapshots\".\"scope\"::text, \"public\".\"team_record_snapshots\".\"createdAt\"",
    "expectLabel": "Team record snapshot",
    "expectFlags": []
  },
  {
    "name": "situational snapshot upsert",
    "run": "52f483d",
    "sql": "INSERT INTO \"public\".\"situational_rate_snapshots\" (\"id\",\"sportKey\",\"teamName\",\"questionKey\",\"snapshotDate\",\"wins\",\"total\",\"sourceId\",\"scope\",\"createdAt\") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CAST($9::text AS \"public\".\"DataScope\"),$10) ON CONFLICT (\"sportKey\",\"teamName\",\"questionKey\",\"snapshotDate\") DO UPDATE SET \"wins\" = $11, \"total\" = $12 WHERE ((\"public\".\"situational_rate_snapshots\".\"sportKey\" = $13 AND \"public\".\"situational_rate_snapshots\".\"teamName\" = $14 AND \"public\".\"situational_rate_snapshots\".\"questionKey\" = $15 AND \"public\".\"situational_rate_snapshots\".\"snapshotDate\" = $16) AND 1=1) RETURNING \"public\".\"situational_rate_snapshots\".\"id\", \"public\".\"situational_rate_snapshots\".\"sportKey\", \"public\".\"situational_rate_snapshots\".\"teamName\", \"public\".\"situational_rate_snapshots\".\"questionKey\", \"public\".\"situational_rate_snapshots\".\"snapshotDate\", \"public\".\"situational_rate_snapshots\".\"wins\", \"public\".\"situational_rate_snapshots\".\"total\", \"public\".\"situational_rate_snapshots\".\"sourceId\", \"public\".\"situational_rate_snapshots\".\"scope\"::text, \"public\".\"situational_rate_snapshots\".\"createdAt\"",
    "expectLabel": "Situational snapshot upsert",
    "expectFlags": []
  },
  {
    "name": "sport include follow-up (sports id IN)",
    "run": "52f483d",
    "sql": "SELECT \"public\".\"sports\".\"id\", \"public\".\"sports\".\"name\" FROM \"public\".\"sports\" WHERE \"public\".\"sports\".\"id\" IN ($1,$2,$3) OFFSET $4",
    "expectLabel": "Sports / leagues reference read",
    "expectFlags": []
  },
  {
    "name": "sport lookup ILIKE (getSportIdByNameInsensitive)",
    "run": "52f483d",
    "sql": "SELECT \"public\".\"sports\".\"id\", \"public\".\"sports\".\"name\" FROM \"public\".\"sports\" WHERE \"public\".\"sports\".\"name\" ILIKE $1 LIMIT $2 OFFSET $3",
    "expectLabel": "Sport lookup (board)",
    "expectFlags": []
  },
  {
    "name": "control: odds snapshot count (SQL)",
    "run": "52f483d",
    "sql": "SELECT count(*)::int AS n FROM odds_snapshots WHERE \"sportKey\" = $1",
    "expectLabel": null,
    "expectFlags": []
  },
  {
    "name": "control: decay-delta pending games",
    "run": "52f483d",
    "sql": "SELECT \"public\".\"game_results\".\"id\", \"public\".\"game_results\".\"favTeam\", \"public\".\"game_results\".\"homeTeam\", \"public\".\"game_results\".\"awayTeam\", \"public\".\"game_results\".\"homeScore\", \"public\".\"game_results\".\"awayScore\", \"public\".\"game_results\".\"gameDate\", \"public\".\"game_results\".\"totalLine\" FROM \"public\".\"game_results\" WHERE (\"public\".\"game_results\".\"sportKey\" = $1 AND \"public\".\"game_results\".\"favTeam\" IS NOT NULL AND \"public\".\"game_results\".\"totalLine\" IS NOT NULL AND 1=1) ORDER BY \"public\".\"game_results\".\"gameDate\" ASC, \"public\".\"game_results\".\"id\" ASC OFFSET $2",
    "expectLabel": null,
    "expectFlags": []
  },
  {
    "name": "control: pregame odds projection (SQL)",
    "run": "52f483d",
    "sql": "\n    SELECT \n         g.ord::int AS ord,\n         g.game->'homeTeam' AS \"homeTeam\",\n         g.game->'awayTeam' AS \"awayTeam\",\n         g.game->'commenceTime' AS \"commenceTime\",\n         (SELECT COALESCE(jsonb_agg(CASE WHEN jsonb_exists(o.oc, 'price') THEN jsonb_build_array(o.oc->'name', o.oc->'price') ELSE jsonb_build_array(o.oc->'name') END ORDER BY o.oord), '[]'::jsonb)\n            FROM (\n              SELECT m.mk FROM jsonb_array_elements((CASE WHEN jsonb_typeof(g.game->'bookmakers') = 'array' THEN g.game->'bookmakers' ELSE '[]'::jsonb END)) WITH ORDINALITY AS b(bk, bord)\n               CROSS JOIN LATERAL jsonb_array_elements((CASE WHEN jsonb_typeof(b.bk->'markets') = 'array' THEN b.bk->'markets' ELSE '[]'::jsonb END)) WITH ORDINALITY AS m(mk, mord)\n               WHERE m.mk->>'key' = 'h2h' ORDER BY b.bord, m.mord LIMIT 1\n            ) fm\n            CROSS JOIN LATERAL jsonb_array_elements((CASE WHEN jsonb_typeof(fm.mk->'outcomes') = 'array' THEN fm.mk->'outcomes' ELSE '[]'::jsonb END)) WITH ORDINALITY AS o(oc, oord)\n         ) AS ml,\n         (SELECT jsonb_build_array(o.oc->'point')\n            FROM (\n              SELECT m.mk FROM jsonb_array_elements((CASE WHEN jsonb_typeof(g.game->'bookmakers') = 'array' THEN g.game->'bookmakers' ELSE '[]'::jsonb END)) WITH ORDINALITY AS b(bk, bord)\n               CROSS JOIN LATERAL jsonb_array_elements((CASE WHEN jsonb_typeof(b.bk->'markets') = 'array' THEN b.bk->'markets' ELSE '[]'::jsonb END)) WITH ORDINALITY AS m(mk, mord)\n               WHERE m.mk->>'key' = 'totals' ORDER BY b.bord, m.mord LIMIT 1\n            ) fm\n            CROSS JOIN LATERAL jsonb_array_elements((CASE WHEN jsonb_typeof(fm.mk->'outcomes') = 'array' THEN fm.mk->'outcomes' ELSE '[]'::jsonb END)) WITH ORDINALITY AS o(oc, oord)\n           WHERE jsonb_exists(o.oc, 'point')\n           ORDER BY o.oord LIMIT 1\n         ) AS pt\n    FROM odds_snapshots s\n    CROSS JOIN LATERAL jsonb_array_elements((CASE WHEN jsonb_typeof(s.data) = 'array' THEN s.data ELSE '[]'::jsonb END)) WITH ORDINALITY AS g(game, ord)\n    WHERE s.\"sportKey\" = $1 AND s.\"fetchDate\" = $2\n    ORDER BY g.ord",
    "expectLabel": null,
    "expectFlags": []
  },
  {
    "name": "control: NFL situational read",
    "run": "52f483d",
    "sql": "SELECT \"public\".\"game_results\".\"id\", \"public\".\"game_results\".\"homeTeam\", \"public\".\"game_results\".\"awayTeam\", \"public\".\"game_results\".\"homeScore\", \"public\".\"game_results\".\"awayScore\", \"public\".\"game_results\".\"gameDate\", \"public\".\"game_results\".\"isPreseason\", \"public\".\"game_results\".\"quartersJson\", \"public\".\"game_results\".\"scoringPlaysJson\", \"public\".\"game_results\".\"homeTurnovers\", \"public\".\"game_results\".\"awayTurnovers\" FROM \"public\".\"game_results\" WHERE (\"public\".\"game_results\".\"sportKey\" = $1 AND \"public\".\"game_results\".\"isPreseason\" = $2 AND (\"public\".\"game_results\".\"quartersJson\" IS NOT NULL OR \"public\".\"game_results\".\"scoringPlaysJson\" IS NOT NULL OR \"public\".\"game_results\".\"homeTurnovers\" IS NOT NULL)) OFFSET $3",
    "expectLabel": null,
    "expectFlags": []
  },
  {
    "name": "tendency snapshot upsert",
    "run": "e769b64 (prod pg_stat_statements, 2026-10-19)",
    "sql": "INSERT INTO \"team_tendency_snapshots\" (\"id\",\"sportKey\",\"teamName\",\"snapshotDate\",\"favWins\",\"favLosses\",\"favPushes\",\"dogWins\",\"dogLosses\",\"dogPushes\",\"overCount\",\"underCount\",\"totalPushCount\",\"sourceId\",\"scope\",\"createdAt\") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,CAST($15::text AS \"DataScope\"),$16) ON CONFLICT (\"sportKey\",\"teamName\",\"snapshotDate\") DO UPDATE SET \"favWins\" = $17, \"favLosses\" = $18, \"favPushes\" = $19, \"dogWins\" = $20, \"dogLosses\" = $21, \"dogPushes\" = $22, \"overCount\" = $23, \"underCount\" = $24, \"totalPushCount\" = $25 WHERE ((\"team_tendency_snapshots\".\"sportKey\" = $26 AND \"team_tendency_snapshots\".\"teamName\" = $27 AND \"team_tendency_snapshots\".\"snapshotDate\" = $28) AND $29=$30) RETURNING \"team_tendency_snapshots\".\"id\", \"team_tendency_snapshots\".\"sportKey\", \"team_tendency_snapshots\".\"teamName\", \"team_tendency_snapshots\".\"snapshotDate\", \"team_tendency_snapshots\".\"favWins\", \"team_tendency_snapshots\".\"favLosses\", \"team_tendency_snapshots\".\"favPushes\", \"team_tendency_snapshots\".\"dogWins\", \"team_tendency_snapshots\".\"dogLosses\", \"team_tendency_snapshots\".\"dogPushes\", \"team_tendency_snapshots\".\"overCount\", \"team_tendency_snapshots\".\"underCount\", \"team_tendency_snapshots\".\"totalPushCount\", \"team_tendency_snapshots\".\"sourceId\", \"team_tendency_snapshots\".\"scope\"::text, \"team_tendency_snapshots\".\"createdAt\"",
    "expectLabel": "Tendency snapshot upsert",
    "expectFlags": []
  },
  {
    "name": "final-score upsert",
    "run": "e769b64 (prod pg_stat_statements, 2026-10-19)",
    "sql": "INSERT INTO \"game_results\" (\"id\",\"sportKey\",\"externalId\",\"homeTeam\",\"awayTeam\",\"homeScore\",\"awayScore\",\"firstFiveHomeScore\",\"firstFiveAwayScore\",\"firstInningHomeScore\",\"firstInningAwayScore\",\"homeTurnovers\",\"awayTurnovers\",\"gameNumber\",\"gameDate\",\"createdAt\",\"isPreseason\",\"favTeam\",\"totalLine\",\"lineSource\") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) ON CONFLICT (\"sportKey\",\"externalId\") DO UPDATE SET \"homeScore\" = $21, \"awayScore\" = $22 WHERE ((\"game_results\".\"sportKey\" = $23 AND \"game_results\".\"externalId\" = $24) AND $25=$26) RETURNING \"game_results\".\"id\", \"game_results\".\"sportKey\", \"game_results\".\"externalId\", \"game_results\".\"homeTeam\", \"game_results\".\"awayTeam\", \"game_results\".\"homeScore\", \"game_results\".\"awayScore\", \"game_results\".\"firstFiveHomeScore\", \"game_results\".\"firstFiveAwayScore\", \"game_results\".\"firstInningHomeScore\", \"game_results\".\"firstInningAwayScore\", \"game_results\".\"inningsJson\", \"game_results\".\"quartersJson\", \"game_results\".\"linescoreJson\", \"game_results\".\"scoringPlaysJson\", \"game_results\".\"homeTurnovers\", \"game_results\".\"awayTurnovers\", \"game_results\".\"gameNumber\", \"game_results\".\"gameDate\", \"game_results\".\"createdAt\", \"game_results\".\"isPreseason\", \"game_results\".\"favTeam\", \"game_results\".\"totalLine\", \"game_results\".\"lineSource\"",
    "expectLabel": "Final-score write (new/changed)",
    "expectFlags": []
  },
  {
    "name": "NFL team stat upsert",
    "run": "e769b64 (prod pg_stat_statements, 2026-10-19)",
    "sql": "INSERT INTO \"nfl_team_stat_snapshots\" (\"id\",\"gameId\",\"season\",\"week\",\"gameType\",\"gameDate\",\"team\",\"opponent\",\"homeAway\",\"completed\",\"points\",\"pointsAllowed\",\"totalYards\",\"totalYardsAllowed\",\"passingYards\",\"passingYardsAllowed\",\"rushingYards\",\"rushingYardsAllowed\",\"offensivePlays\",\"yardsPerPlay\",\"firstDowns\",\"thirdDownPct\",\"thirdDownPctAllowed\",\"timeOfPossessionSeconds\",\"turnovers\",\"takeaways\",\"turnoverMargin\",\"sacks\",\"sacksAllowed\",\"sackYardsLost\",\"penalties\",\"penaltyYards\",\"passingEpa\",\"rushingEpa\",\"receivingEpa\",\"offensiveEpa\",\"sourceId\",\"scope\",\"createdAt\",\"updatedAt\") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,CAST($38::text AS \"DataScope\"),$39,$40) ON CONFLICT (\"team\",\"gameId\") DO UPDATE SET \"gameId\" = $41, \"season\" = $42, \"week\" = $43, \"gameType\" = $44, \"gameDate\" = $45, \"team\" = $46, \"opponent\" = $47, \"homeAway\" = $48, \"completed\" = $49, \"points\" = $50, \"pointsAllowed\" = $51, \"totalYards\" = $52, \"totalYardsAllowed\" = $53, \"passingYards\" = $54, \"passingYardsAllowed\" = $55, \"rushingYards\" = $56, \"rushingYardsAllowed\" = $57, \"offensivePlays\" = $58, \"yardsPerPlay\" = $59, \"firstDowns\" = $60, \"thirdDownPct\" = $61, \"thirdDownPctAllowed\" = $62, \"timeOfPossessionSeconds\" = $63, \"turnovers\" = $64, \"takeaways\" = $65, \"turnoverMargin\" = $66, \"sacks\" = $67, \"sacksAllowed\" = $68, \"sackYardsLost\" = $69, \"penalties\" = $70, \"penaltyYards\" = $71, \"passingEpa\" = $72, \"rushingEpa\" = $73, \"receivingEpa\" = $74, \"offensiveEpa\" = $75, \"updatedAt\" = $76 WHERE ((\"nfl_team_stat_snapshots\".\"team\" = $77 AND \"nfl_team_stat_snapshots\".\"gameId\" = $78) AND $79=$80) RETURNING \"nfl_team_stat_snapshots\".\"id\", \"nfl_team_stat_snapshots\".\"gameId\", \"nfl_team_stat_snapshots\".\"season\", \"nfl_team_stat_snapshots\".\"week\", \"nfl_team_stat_snapshots\".\"gameType\", \"nfl_team_stat_snapshots\".\"gameDate\", \"nfl_team_stat_snapshots\".\"team\", \"nfl_team_stat_snapshots\".\"opponent\", \"nfl_team_stat_snapshots\".\"homeAway\", \"nfl_team_stat_snapshots\".\"completed\", \"nfl_team_stat_snapshots\".\"points\", \"nfl_team_stat_snapshots\".\"pointsAllowed\", \"nfl_team_stat_snapshots\".\"totalYards\", \"nfl_team_stat_snapshots\".\"totalYardsAllowed\", \"nfl_team_stat_snapshots\".\"passingYards\", \"nfl_team_stat_snapshots\".\"passingYardsAllowed\", \"nfl_team_stat_snapshots\".\"rushingYards\", \"nfl_team_stat_snapshots\".\"rushingYardsAllowed\", \"nfl_team_stat_snapshots\".\"offensivePlays\", \"nfl_team_stat_snapshots\".\"yardsPerPlay\", \"nfl_team_stat_snapshots\".\"firstDowns\", \"nfl_team_stat_snapshots\".\"thirdDownPct\", \"nfl_team_stat_snapshots\".\"thirdDownPctAllowed\", \"nfl_team_stat_snapshots\".\"timeOfPossessionSeconds\", \"nfl_team_stat_snapshots\".\"turnovers\", \"nfl_team_stat_snapshots\".\"takeaways\", \"nfl_team_stat_snapshots\".\"turnoverMargin\", \"nfl_team_stat_snapshots\".\"sacks\", \"nfl_team_stat_snapshots\".\"sacksAllowed\", \"nfl_team_stat_snapshots\".\"sackYardsLost\", \"nfl_team_stat_snapshots\".\"penalties\", \"nfl_team_stat_snapshots\".\"penaltyYards\", \"nfl_team_stat_snapshots\".\"passingEpa\", \"nfl_team_stat_snapshots\".\"rushingEpa\", \"nfl_team_stat_snapshots\".\"receivingEpa\", \"nfl_team_stat_snapshots\".\"offensiveEpa\", \"nfl_team_stat_snapshots\".\"sourceId\", \"nfl_team_stat_snapshots\".\"scope\"::text, \"nfl_team_stat_snapshots\".\"createdAt\", \"nfl_team_stat_snapshots\".\"updatedAt\"",
    "expectLabel": "NFL team stat upsert",
    "expectFlags": []
  },
  {
    "name": "capper roster, id + name (getCappersForUser, #297)",
    "run": "aacbcd6",
    "sql": "SELECT \"public\".\"cappers\".\"id\", \"public\".\"cappers\".\"name\" FROM \"public\".\"cappers\" WHERE \"public\".\"cappers\".\"userId\" = $1 ORDER BY \"public\".\"cappers\".\"isFavorite\" DESC, \"public\".\"cappers\".\"name\" ASC OFFSET $2",
    "expectLabel": "Capper roster",
    "expectFlags": []
  },
  {
    "name": "capper names scan (findOrCreateCapper, #297)",
    "run": "aacbcd6",
    "sql": "SELECT \"public\".\"cappers\".\"id\", \"public\".\"cappers\".\"name\" FROM \"public\".\"cappers\" WHERE \"public\".\"cappers\".\"userId\" = $1 OFFSET $2",
    "expectLabel": "Capper names (import / find-or-create)",
    "expectFlags": []
  },
  {
    "name": "roster cache read, NFL (readAll, #302)",
    "run": "aacbcd6",
    "sql": "SELECT \"public\".\"nfl_roster_players\".\"id\", \"public\".\"nfl_roster_players\".\"fullName\", \"public\".\"nfl_roster_players\".\"firstName\", \"public\".\"nfl_roster_players\".\"lastName\", \"public\".\"nfl_roster_players\".\"team\", \"public\".\"nfl_roster_players\".\"position\", \"public\".\"nfl_roster_players\".\"active\", \"public\".\"nfl_roster_players\".\"espnPlayerId\" FROM \"public\".\"nfl_roster_players\" WHERE 1=1 OFFSET $1",
    "expectLabel": "Roster cache (grading / import recovery)",
    "expectFlags": []
  },
  {
    "name": "roster cache read, MLB (readAll, #302)",
    "run": "aacbcd6",
    "sql": "SELECT \"public\".\"mlb_roster_players\".\"id\", \"public\".\"mlb_roster_players\".\"fullName\", \"public\".\"mlb_roster_players\".\"firstName\", \"public\".\"mlb_roster_players\".\"lastName\", \"public\".\"mlb_roster_players\".\"team\", \"public\".\"mlb_roster_players\".\"position\", \"public\".\"mlb_roster_players\".\"active\", \"public\".\"mlb_roster_players\".\"mlbPlayerId\" FROM \"public\".\"mlb_roster_players\" WHERE 1=1 OFFSET $1",
    "expectLabel": "Roster cache (grading / import recovery)",
    "expectFlags": []
  },
  {
    "name": "roster cache read, NHL (readAll, #302)",
    "run": "aacbcd6",
    "sql": "SELECT \"public\".\"nhl_roster_players\".\"id\", \"public\".\"nhl_roster_players\".\"fullName\", \"public\".\"nhl_roster_players\".\"firstName\", \"public\".\"nhl_roster_players\".\"lastName\", \"public\".\"nhl_roster_players\".\"team\", \"public\".\"nhl_roster_players\".\"position\", \"public\".\"nhl_roster_players\".\"active\", \"public\".\"nhl_roster_players\".\"espnPlayerId\" FROM \"public\".\"nhl_roster_players\" WHERE 1=1 OFFSET $1",
    "expectLabel": "Roster cache (grading / import recovery)",
    "expectFlags": []
  },
  {
    "name": "roster cache read, NBA (readAll, #302)",
    "run": "aacbcd6",
    "sql": "SELECT \"public\".\"nba_roster_players\".\"id\", \"public\".\"nba_roster_players\".\"fullName\", \"public\".\"nba_roster_players\".\"firstName\", \"public\".\"nba_roster_players\".\"lastName\", \"public\".\"nba_roster_players\".\"team\", \"public\".\"nba_roster_players\".\"position\", \"public\".\"nba_roster_players\".\"active\", \"public\".\"nba_roster_players\".\"espnPlayerId\" FROM \"public\".\"nba_roster_players\" WHERE 1=1 OFFSET $1",
    "expectLabel": "Roster cache (grading / import recovery)",
    "expectFlags": []
  },
  {
    "name": "roster refresh diff read, NFL (readForDiff)",
    "run": "aacbcd6",
    "sql": "SELECT \"public\".\"nfl_roster_players\".\"id\", \"public\".\"nfl_roster_players\".\"espnPlayerId\", \"public\".\"nfl_roster_players\".\"fullName\", \"public\".\"nfl_roster_players\".\"firstName\", \"public\".\"nfl_roster_players\".\"lastName\", \"public\".\"nfl_roster_players\".\"team\", \"public\".\"nfl_roster_players\".\"position\", \"public\".\"nfl_roster_players\".\"active\" FROM \"public\".\"nfl_roster_players\" WHERE 1=1 OFFSET $1",
    "expectLabel": "Roster refresh diff",
    "expectFlags": []
  },
  {
    "name": "roster refresh diff read, MLB (readForDiff)",
    "run": "aacbcd6",
    "sql": "SELECT \"public\".\"mlb_roster_players\".\"id\", \"public\".\"mlb_roster_players\".\"mlbPlayerId\", \"public\".\"mlb_roster_players\".\"fullName\", \"public\".\"mlb_roster_players\".\"firstName\", \"public\".\"mlb_roster_players\".\"lastName\", \"public\".\"mlb_roster_players\".\"team\", \"public\".\"mlb_roster_players\".\"position\", \"public\".\"mlb_roster_players\".\"active\" FROM \"public\".\"mlb_roster_players\" WHERE 1=1 OFFSET $1",
    "expectLabel": "Roster refresh diff",
    "expectFlags": []
  },
  {
    "name": "roster refresh diff read, NHL (readForDiff)",
    "run": "aacbcd6",
    "sql": "SELECT \"public\".\"nhl_roster_players\".\"id\", \"public\".\"nhl_roster_players\".\"espnPlayerId\", \"public\".\"nhl_roster_players\".\"fullName\", \"public\".\"nhl_roster_players\".\"firstName\", \"public\".\"nhl_roster_players\".\"lastName\", \"public\".\"nhl_roster_players\".\"team\", \"public\".\"nhl_roster_players\".\"position\", \"public\".\"nhl_roster_players\".\"active\" FROM \"public\".\"nhl_roster_players\" WHERE 1=1 OFFSET $1",
    "expectLabel": "Roster refresh diff",
    "expectFlags": []
  },
  {
    "name": "roster refresh diff read, NBA (readForDiff)",
    "run": "aacbcd6",
    "sql": "SELECT \"public\".\"nba_roster_players\".\"id\", \"public\".\"nba_roster_players\".\"espnPlayerId\", \"public\".\"nba_roster_players\".\"fullName\", \"public\".\"nba_roster_players\".\"firstName\", \"public\".\"nba_roster_players\".\"lastName\", \"public\".\"nba_roster_players\".\"team\", \"public\".\"nba_roster_players\".\"position\", \"public\".\"nba_roster_players\".\"active\" FROM \"public\".\"nba_roster_players\" WHERE 1=1 OFFSET $1",
    "expectLabel": "Roster refresh diff",
    "expectFlags": []
  },
  {
    "name": "NFL roster names (getCachedNflRosterFullNames)",
    "run": "aacbcd6",
    "sql": "SELECT \"public\".\"nfl_roster_players\".\"id\", \"public\".\"nfl_roster_players\".\"fullName\" FROM \"public\".\"nfl_roster_players\" WHERE \"public\".\"nfl_roster_players\".\"active\" = $1 OFFSET $2",
    "expectLabel": "NFL roster names (bulk import)",
    "expectFlags": []
  },
  {
    "name": "tendency history batch, bounded (createTendencyHistorySource, #310)",
    "run": "aacbcd6",
    "sql": "\n    SELECT t.* FROM team_tendency_snapshots t\n    WHERE t.\"sportKey\" = $1\n      AND t.\"teamName\" = ANY($2::text[])\n      AND t.\"snapshotDate\" <= $3\n      AND t.\"snapshotDate\" >= COALESCE((\n        SELECT max(s.\"snapshotDate\") FROM team_tendency_snapshots s\n        WHERE s.\"sportKey\" = t.\"sportKey\" AND s.\"teamName\" = t.\"teamName\" AND s.\"snapshotDate\" <= $4\n      ), '')\n    ORDER BY t.\"snapshotDate\" ASC",
    "expectLabel": "Tendency history (batch)",
    "expectFlags": []
  },
  {
    "name": "/picks date range, 18 columns (getFilteredPicksForUser, #301)",
    "run": "aacbcd6",
    "sql": "SELECT \"public\".\"picks\".\"id\", \"public\".\"picks\".\"capperId\", \"public\".\"picks\".\"sportId\", \"public\".\"picks\".\"homeTeam\", \"public\".\"picks\".\"awayTeam\", \"public\".\"picks\".\"betType\"::text, \"public\".\"picks\".\"betDetail\", \"public\".\"picks\".\"odds\", \"public\".\"picks\".\"line\", \"public\".\"picks\".\"period\"::text, \"public\".\"picks\".\"units\", \"public\".\"picks\".\"gameTime\", \"public\".\"picks\".\"status\"::text, \"public\".\"picks\".\"gradedAt\", \"public\".\"picks\".\"pickedSide\"::text, \"public\".\"picks\".\"propMarket\"::text, \"public\".\"picks\".\"gameNumber\", \"public\".\"picks\".\"category\" FROM \"public\".\"picks\" WHERE (\"public\".\"picks\".\"userId\" = $1 AND \"public\".\"picks\".\"gameTime\" >= $2 AND \"public\".\"picks\".\"gameTime\" < $3) ORDER BY \"public\".\"picks\".\"gameTime\" DESC OFFSET $4",
    "expectLabel": "/picks",
    "expectFlags": []
  },
  {
    "name": "grading sport lookup, id only (getSportIdByName, #311)",
    "run": "aacbcd6",
    "sql": "SELECT \"public\".\"sports\".\"id\" FROM \"public\".\"sports\" WHERE (\"public\".\"sports\".\"name\" = $1 AND 1=1) LIMIT $2 OFFSET $3",
    "expectLabel": "Grading sport lookup",
    "expectFlags": []
  },
  {
    "name": "/picks older, first click (no cursor)",
    "run": "3c6cb08",
    "sql": "SELECT \"public\".\"picks\".\"id\", \"public\".\"picks\".\"capperId\", \"public\".\"picks\".\"sportId\", \"public\".\"picks\".\"homeTeam\", \"public\".\"picks\".\"awayTeam\", \"public\".\"picks\".\"betType\"::text, \"public\".\"picks\".\"betDetail\", \"public\".\"picks\".\"odds\", \"public\".\"picks\".\"line\", \"public\".\"picks\".\"period\"::text, \"public\".\"picks\".\"units\", \"public\".\"picks\".\"gameTime\", \"public\".\"picks\".\"status\"::text, \"public\".\"picks\".\"gradedAt\", \"public\".\"picks\".\"pickedSide\"::text, \"public\".\"picks\".\"propMarket\"::text, \"public\".\"picks\".\"gameNumber\", \"public\".\"picks\".\"category\" FROM \"public\".\"picks\" WHERE (\"public\".\"picks\".\"userId\" = $1 AND \"public\".\"picks\".\"gameTime\" < $2) ORDER BY \"public\".\"picks\".\"gameTime\" DESC, \"public\".\"picks\".\"id\" DESC LIMIT $3 OFFSET $4",
    "expectLabel": "/picks older",
    "expectFlags": []
  },
  {
    "name": "/picks older, later click (cursor)",
    "run": "3c6cb08",
    "sql": "SELECT \"public\".\"picks\".\"id\", \"public\".\"picks\".\"capperId\", \"public\".\"picks\".\"sportId\", \"public\".\"picks\".\"homeTeam\", \"public\".\"picks\".\"awayTeam\", \"public\".\"picks\".\"betType\"::text, \"public\".\"picks\".\"betDetail\", \"public\".\"picks\".\"odds\", \"public\".\"picks\".\"line\", \"public\".\"picks\".\"period\"::text, \"public\".\"picks\".\"units\", \"public\".\"picks\".\"gameTime\", \"public\".\"picks\".\"status\"::text, \"public\".\"picks\".\"gradedAt\", \"public\".\"picks\".\"pickedSide\"::text, \"public\".\"picks\".\"propMarket\"::text, \"public\".\"picks\".\"gameNumber\", \"public\".\"picks\".\"category\" FROM \"public\".\"picks\" WHERE (\"public\".\"picks\".\"userId\" = $1 AND \"public\".\"picks\".\"gameTime\" < $2 AND \"public\".\"picks\".\"gameTime\" <= $3 AND (\"public\".\"picks\".\"gameTime\" < $4 OR (\"public\".\"picks\".\"gameTime\" = $5 AND \"public\".\"picks\".\"id\" < $6))) ORDER BY \"public\".\"picks\".\"gameTime\" DESC, \"public\".\"picks\".\"id\" DESC LIMIT $7 OFFSET $8",
    "expectLabel": "/picks older",
    "expectFlags": []
  },
  {
    "name": "/picks older, capper + sport + status + Total (cursor)",
    "run": "3c6cb08",
    "sql": "SELECT \"public\".\"picks\".\"id\", \"public\".\"picks\".\"capperId\", \"public\".\"picks\".\"sportId\", \"public\".\"picks\".\"homeTeam\", \"public\".\"picks\".\"awayTeam\", \"public\".\"picks\".\"betType\"::text, \"public\".\"picks\".\"betDetail\", \"public\".\"picks\".\"odds\", \"public\".\"picks\".\"line\", \"public\".\"picks\".\"period\"::text, \"public\".\"picks\".\"units\", \"public\".\"picks\".\"gameTime\", \"public\".\"picks\".\"status\"::text, \"public\".\"picks\".\"gradedAt\", \"public\".\"picks\".\"pickedSide\"::text, \"public\".\"picks\".\"propMarket\"::text, \"public\".\"picks\".\"gameNumber\", \"public\".\"picks\".\"category\" FROM \"public\".\"picks\" WHERE (\"public\".\"picks\".\"userId\" = $1 AND \"public\".\"picks\".\"capperId\" = $2 AND \"public\".\"picks\".\"sportId\" = $3 AND \"public\".\"picks\".\"status\" = CAST($4::text AS \"public\".\"PickStatus\") AND \"public\".\"picks\".\"gameTime\" < $5 AND \"public\".\"picks\".\"gameTime\" <= $6 AND (\"public\".\"picks\".\"gameTime\" < $7 OR (\"public\".\"picks\".\"gameTime\" = $8 AND \"public\".\"picks\".\"id\" < $9)) AND \"public\".\"picks\".\"betType\" = CAST($10::text AS \"public\".\"BetType\") AND \"public\".\"picks\".\"period\" <> CAST($11::text AS \"public\".\"Period\")) ORDER BY \"public\".\"picks\".\"gameTime\" DESC, \"public\".\"picks\".\"id\" DESC LIMIT $12 OFFSET $13",
    "expectLabel": "/picks older",
    "expectFlags": []
  },
  {
    "name": "/picks older, player prop market",
    "run": "3c6cb08",
    "sql": "SELECT \"public\".\"picks\".\"id\", \"public\".\"picks\".\"capperId\", \"public\".\"picks\".\"sportId\", \"public\".\"picks\".\"homeTeam\", \"public\".\"picks\".\"awayTeam\", \"public\".\"picks\".\"betType\"::text, \"public\".\"picks\".\"betDetail\", \"public\".\"picks\".\"odds\", \"public\".\"picks\".\"line\", \"public\".\"picks\".\"period\"::text, \"public\".\"picks\".\"units\", \"public\".\"picks\".\"gameTime\", \"public\".\"picks\".\"status\"::text, \"public\".\"picks\".\"gradedAt\", \"public\".\"picks\".\"pickedSide\"::text, \"public\".\"picks\".\"propMarket\"::text, \"public\".\"picks\".\"gameNumber\", \"public\".\"picks\".\"category\" FROM \"public\".\"picks\" WHERE (\"public\".\"picks\".\"userId\" = $1 AND \"public\".\"picks\".\"gameTime\" < $2 AND \"public\".\"picks\".\"betType\" = CAST($3::text AS \"public\".\"BetType\") AND (\"public\".\"picks\".\"propMarket\" = CAST($4::text AS \"public\".\"PropMarket\") OR \"public\".\"picks\".\"propMarket\" IS NULL)) ORDER BY \"public\".\"picks\".\"gameTime\" DESC, \"public\".\"picks\".\"id\" DESC LIMIT $5 OFFSET $6",
    "expectLabel": "/picks older",
    "expectFlags": []
  },
  {
    "name": "/picks older, F5 moneyline",
    "run": "3c6cb08",
    "sql": "SELECT \"public\".\"picks\".\"id\", \"public\".\"picks\".\"capperId\", \"public\".\"picks\".\"sportId\", \"public\".\"picks\".\"homeTeam\", \"public\".\"picks\".\"awayTeam\", \"public\".\"picks\".\"betType\"::text, \"public\".\"picks\".\"betDetail\", \"public\".\"picks\".\"odds\", \"public\".\"picks\".\"line\", \"public\".\"picks\".\"period\"::text, \"public\".\"picks\".\"units\", \"public\".\"picks\".\"gameTime\", \"public\".\"picks\".\"status\"::text, \"public\".\"picks\".\"gradedAt\", \"public\".\"picks\".\"pickedSide\"::text, \"public\".\"picks\".\"propMarket\"::text, \"public\".\"picks\".\"gameNumber\", \"public\".\"picks\".\"category\" FROM \"public\".\"picks\" WHERE (\"public\".\"picks\".\"userId\" = $1 AND \"public\".\"picks\".\"gameTime\" < $2 AND \"public\".\"picks\".\"betType\" = CAST($3::text AS \"public\".\"BetType\") AND \"public\".\"picks\".\"period\" = CAST($4::text AS \"public\".\"Period\")) ORDER BY \"public\".\"picks\".\"gameTime\" DESC, \"public\".\"picks\".\"id\" DESC LIMIT $5 OFFSET $6",
    "expectLabel": "/picks older",
    "expectFlags": []
  },
  {
    "name": "/picks older, one row reloaded",
    "run": "3c6cb08",
    "sql": "SELECT \"public\".\"picks\".\"id\", \"public\".\"picks\".\"capperId\", \"public\".\"picks\".\"sportId\", \"public\".\"picks\".\"homeTeam\", \"public\".\"picks\".\"awayTeam\", \"public\".\"picks\".\"betType\"::text, \"public\".\"picks\".\"betDetail\", \"public\".\"picks\".\"odds\", \"public\".\"picks\".\"line\", \"public\".\"picks\".\"period\"::text, \"public\".\"picks\".\"units\", \"public\".\"picks\".\"gameTime\", \"public\".\"picks\".\"status\"::text, \"public\".\"picks\".\"gradedAt\", \"public\".\"picks\".\"pickedSide\"::text, \"public\".\"picks\".\"propMarket\"::text, \"public\".\"picks\".\"gameNumber\", \"public\".\"picks\".\"category\" FROM \"public\".\"picks\" WHERE (\"public\".\"picks\".\"id\" = $1 AND \"public\".\"picks\".\"userId\" = $2) LIMIT $3 OFFSET $4",
    "expectLabel": "/picks older",
    "expectFlags": []
  },
  {
    "name": "/picks older final scores, a window per pick day",
    "run": "3c6cb08",
    "sql": "SELECT \"public\".\"game_results\".\"id\", \"public\".\"game_results\".\"sportKey\", \"public\".\"game_results\".\"gameDate\", \"public\".\"game_results\".\"homeTeam\", \"public\".\"game_results\".\"awayTeam\", \"public\".\"game_results\".\"homeScore\", \"public\".\"game_results\".\"awayScore\", \"public\".\"game_results\".\"gameNumber\" FROM \"public\".\"game_results\" WHERE (\"public\".\"game_results\".\"sportKey\" IN ($1) AND ((\"public\".\"game_results\".\"gameDate\" >= $2 AND \"public\".\"game_results\".\"gameDate\" < $3) OR (\"public\".\"game_results\".\"gameDate\" >= $4 AND \"public\".\"game_results\".\"gameDate\" < $5))) OFFSET $6",
    "expectLabel": "/picks final scores",
    "expectFlags": []
  },
  {
    "name": "grading pending count() (due candidates, #B)",
    "run": "egress/grade-failure-backoff (local capture 2026-10-26)",
    "sql": "SELECT COUNT(*) FROM (SELECT \"public\".\"picks\".\"id\" FROM \"public\".\"picks\" LEFT JOIN \"public\".\"pick_grade_failures\" AS \"j1\" ON (\"j1\".\"pickId\") = (\"public\".\"picks\".\"id\") LEFT JOIN \"public\".\"pick_grade_failures\" AS \"j2\" ON (\"j2\".\"pickId\") = (\"public\".\"picks\".\"id\") WHERE (\"public\".\"picks\".\"sportId\" = $1 AND \"public\".\"picks\".\"status\" = CAST($2::text AS \"public\".\"PickStatus\") AND \"public\".\"picks\".\"gameTime\" >= $3 AND \"public\".\"picks\".\"gameTime\" <= $4 AND ((\"j1\".\"pickId\" IS NULL) OR ((\"j2\".\"nextAttemptAt\" IS NULL OR \"j2\".\"nextAttemptAt\" <= $5) AND (\"j2\".\"pickId\" IS NOT NULL)))) OFFSET $6) AS \"sub\"",
    "expectLabel": "Grading pending",
    "expectFlags": []
  },
  {
    "name": "grading pending findMany (due candidates, projected, #B)",
    "run": "egress/grade-failure-backoff (local capture 2026-10-26)",
    "sql": "SELECT \"public\".\"picks\".\"id\", \"public\".\"picks\".\"userId\", \"public\".\"picks\".\"gameTime\", \"public\".\"picks\".\"homeTeam\", \"public\".\"picks\".\"awayTeam\", \"public\".\"picks\".\"betDetail\", \"public\".\"picks\".\"betType\"::text, \"public\".\"picks\".\"period\"::text, \"public\".\"picks\".\"line\", \"public\".\"picks\".\"pickedSide\"::text, \"public\".\"picks\".\"gameNumber\", \"public\".\"picks\".\"propMarket\"::text, \"public\".\"picks\".\"playerName\" FROM \"public\".\"picks\" LEFT JOIN \"public\".\"pick_grade_failures\" AS \"j1\" ON (\"j1\".\"pickId\") = (\"public\".\"picks\".\"id\") LEFT JOIN \"public\".\"pick_grade_failures\" AS \"j2\" ON (\"j2\".\"pickId\") = (\"public\".\"picks\".\"id\") WHERE (\"public\".\"picks\".\"sportId\" = $1 AND \"public\".\"picks\".\"status\" = CAST($2::text AS \"public\".\"PickStatus\") AND \"public\".\"picks\".\"gameTime\" >= $3 AND \"public\".\"picks\".\"gameTime\" <= $4 AND ((\"j1\".\"pickId\" IS NULL) OR ((\"j2\".\"nextAttemptAt\" IS NULL OR \"j2\".\"nextAttemptAt\" <= $5) AND (\"j2\".\"pickId\" IS NOT NULL)))) ORDER BY \"public\".\"picks\".\"gameTime\" ASC LIMIT $6 OFFSET $7",
    "expectLabel": "Grading pending",
    "expectFlags": []
  },
  {
    "name": "grade-failure write (SQL, backoff)",
    "run": "egress/grade-failure-backoff (local capture 2026-10-26)",
    "sql": "\n      INSERT INTO pick_grade_failures (\"pickId\", reason, \"gameResultId\", \"finalSeenAt\", \"firstSeenAt\", \"lastSeenAt\", attempts, \"nextAttemptAt\")\n      SELECT t.pick_id, t.reason, t.game_result_id, t.final_seen_at::timestamp(3), now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC', 1, now() AT TIME ZONE 'UTC'\n      FROM unnest(\n        $1::text[],\n        $2::text[],\n        $3::text[],\n        $4::text[]\n      ) AS t(pick_id, reason, game_result_id, final_seen_at)\n      JOIN picks p ON p.id = t.pick_id\n      ON CONFLICT (\"pickId\") DO UPDATE SET\n        reason = EXCLUDED.reason,\n        \"gameResultId\" = EXCLUDED.\"gameResultId\",\n        \"finalSeenAt\" = EXCLUDED.\"finalSeenAt\",\n        \"lastSeenAt\" = EXCLUDED.\"lastSeenAt\",\n        attempts = pick_grade_failures.attempts + 1,\n        \"nextAttemptAt\" = CASE\n          WHEN pick_grade_failures.attempts + 1 >= $5::int THEN $6::timestamp\n          ELSE (now() AT TIME ZONE 'UTC') + make_interval(secs => (CASE\n            WHEN pick_grade_failures.attempts + 1 < $7::int THEN 0\n            WHEN pick_grade_failures.attempts + 1 < $8::int THEN $9::int\n            ELSE $10::int\n          END)::float8)\n        END\n    ",
    "expectLabel": "Grade-failure write",
    "expectFlags": []
  },
  {
    "name": "grade-failure clear (SQL)",
    "run": "egress/grade-failure-backoff (local capture 2026-10-26)",
    "sql": "DELETE FROM pick_grade_failures WHERE \"pickId\" = ANY($1::text[])",
    "expectLabel": "Grade-failure clear (graded pick)",
    "expectFlags": []
  },
  {
    "name": "grade-failure reset (SQL)",
    "run": "egress/grade-failure-backoff (local capture 2026-10-26)",
    "sql": "\n      DELETE FROM pick_grade_failures WHERE \"pickId\" IN (\n        SELECT f.\"pickId\" FROM pick_grade_failures f\n        LEFT JOIN picks p ON p.id = f.\"pickId\"\n        WHERE f.\"gameResultId\" = ANY($1::text[])\n           OR ($2::boolean AND f.\"gameResultId\" IS NULL AND p.\"sportId\" = $3\n               AND p.\"gameTime\" >= $4::timestamp AND p.\"gameTime\" < $5::timestamp)\n      )\n    ",
    "expectLabel": "Grade-failure reset (new/changed game data)",
    "expectFlags": []
  },
  {
    "name": "capper roster, 4 columns (getCapperRoster, egress batch 2 D)",
    "run": "15525ac+D",
    "sql": "SELECT \"public\".\"cappers\".\"id\", \"public\".\"cappers\".\"name\", \"public\".\"cappers\".\"colorTag\", \"public\".\"cappers\".\"isFavorite\" FROM \"public\".\"cappers\" WHERE \"public\".\"cappers\".\"userId\" = $1 ORDER BY \"public\".\"cappers\".\"isFavorite\" DESC, \"public\".\"cappers\".\"name\" ASC OFFSET $2",
    "expectLabel": "Capper roster",
    "expectFlags": []
  },
  {
    "name": "cappers with pick counts, user-scoped raw SQL (loadCappersWithPickCounts, egress batch 2 D)",
    "run": "15525ac+D",
    "sql": "\n    SELECT c.id, c.name, COALESCE(p.n, 0)::int AS \"pickCount\"\n    FROM cappers c\n    LEFT JOIN (SELECT \"capperId\", count(*)::int AS n FROM picks WHERE \"userId\" = $1 GROUP BY \"capperId\") p\n      ON p.\"capperId\" = c.id\n    WHERE c.\"userId\" = $2\n    ORDER BY c.name ASC",
    "expectLabel": "Cappers with pick counts",
    "expectFlags": []
  },
  {
    "name": "Heavy Consensus rate, one viewer's settled markets (getHeavyConsensusRate)",
    "run": "95c88d8+per-user",
    "sql": "SELECT \"public\".\"heavy_consensus_markets\".\"id\", \"public\".\"heavy_consensus_markets\".\"userId\", \"public\".\"heavy_consensus_markets\".\"cappers\", \"public\".\"heavy_consensus_markets\".\"outcome\" FROM \"public\".\"heavy_consensus_markets\" WHERE (\"public\".\"heavy_consensus_markets\".\"userId\" = $1 AND \"public\".\"heavy_consensus_markets\".\"cappers\" >= $2 AND \"public\".\"heavy_consensus_markets\".\"outcome\" IS NOT NULL) OFFSET $3",
    "expectLabel": "Heavy Consensus rate (per user)",
    "expectFlags": []
  },
  {
    "name": "Heavy Consensus history, nightly window (loadHeavyConsensusInstances)",
    "run": "95c88d8+per-user",
    "sql": "SELECT \"public\".\"picks\".\"id\", \"public\".\"picks\".\"userId\", \"public\".\"picks\".\"capperId\", \"public\".\"picks\".\"homeTeam\", \"public\".\"picks\".\"awayTeam\", \"public\".\"picks\".\"betType\"::text, \"public\".\"picks\".\"betDetail\", \"public\".\"picks\".\"period\"::text, \"public\".\"picks\".\"pickedSide\"::text, \"public\".\"picks\".\"gameTime\", \"public\".\"picks\".\"gameNumber\", \"public\".\"picks\".\"status\"::text, \"public\".\"picks\".\"datePosted\", \"public\".\"picks\".\"sportId\" FROM \"public\".\"picks\" LEFT JOIN \"public\".\"cappers\" AS \"j1\" ON (\"j1\".\"id\") = (\"public\".\"picks\".\"capperId\") WHERE (\"public\".\"picks\".\"period\" = CAST($1::text AS \"public\".\"Period\") AND \"public\".\"picks\".\"betType\" IN (CAST($2::text AS \"public\".\"BetType\"),CAST($3::text AS \"public\".\"BetType\"),CAST($4::text AS \"public\".\"BetType\")) AND \"public\".\"picks\".\"status\" <> CAST($5::text AS \"public\".\"PickStatus\") AND \"public\".\"picks\".\"gameTime\" < $6 AND \"public\".\"picks\".\"gameTime\" >= $7 AND (\"j1\".\"isTest\" = $8 AND (\"j1\".\"id\" IS NOT NULL))) OFFSET $9",
    "expectLabel": "Heavy Consensus history (nightly / backfill)",
    "expectFlags": []
  },
  {
    "name": "Heavy Consensus stored ids, window (recomputeHeavyConsensusMarkets)",
    "run": "95c88d8+per-user",
    "sql": "SELECT \"public\".\"heavy_consensus_markets\".\"id\", \"public\".\"heavy_consensus_markets\".\"userId\", \"public\".\"heavy_consensus_markets\".\"worldKey\" FROM \"public\".\"heavy_consensus_markets\" WHERE \"public\".\"heavy_consensus_markets\".\"gameDate\" >= $1 OFFSET $2",
    "expectLabel": "Heavy Consensus stored ids",
    "expectFlags": []
  },
  {
    "name": "Heavy Consensus upsert (recomputeHeavyConsensusMarkets)",
    "run": "95c88d8+per-user",
    "sql": "INSERT INTO \"public\".\"heavy_consensus_markets\" (\"id\",\"userId\",\"worldKey\",\"sport\",\"gameDate\",\"gameTime\",\"market\",\"heavySide\",\"cappers\",\"heavyCappers\",\"sharePct\",\"band\",\"outcome\",\"computedAt\") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (\"userId\",\"worldKey\") DO UPDATE SET \"sport\" = $15, \"gameDate\" = $16, \"gameTime\" = $17, \"market\" = $18, \"heavySide\" = $19, \"cappers\" = $20, \"heavyCappers\" = $21, \"sharePct\" = $22, \"band\" = $23, \"outcome\" = $24, \"computedAt\" = $25 WHERE ((\"public\".\"heavy_consensus_markets\".\"userId\" = $26 AND \"public\".\"heavy_consensus_markets\".\"worldKey\" = $27) AND 1=1) RETURNING \"public\".\"heavy_consensus_markets\".\"id\", \"public\".\"heavy_consensus_markets\".\"userId\", \"public\".\"heavy_consensus_markets\".\"worldKey\", \"public\".\"heavy_consensus_markets\".\"sport\", \"public\".\"heavy_consensus_markets\".\"gameDate\", \"public\".\"heavy_consensus_markets\".\"gameTime\", \"public\".\"heavy_consensus_markets\".\"market\", \"public\".\"heavy_consensus_markets\".\"heavySide\", \"public\".\"heavy_consensus_markets\".\"cappers\", \"public\".\"heavy_consensus_markets\".\"heavyCappers\", \"public\".\"heavy_consensus_markets\".\"sharePct\", \"public\".\"heavy_consensus_markets\".\"band\", \"public\".\"heavy_consensus_markets\".\"outcome\", \"public\".\"heavy_consensus_markets\".\"computedAt\"",
    "expectLabel": "Heavy Consensus upsert",
    "expectFlags": []
  },
  {
    "name": "Heavy Consensus history, all history (backfill script)",
    "run": "95c88d8+per-user",
    "sql": "SELECT \"public\".\"picks\".\"id\", \"public\".\"picks\".\"userId\", \"public\".\"picks\".\"capperId\", \"public\".\"picks\".\"homeTeam\", \"public\".\"picks\".\"awayTeam\", \"public\".\"picks\".\"betType\"::text, \"public\".\"picks\".\"betDetail\", \"public\".\"picks\".\"period\"::text, \"public\".\"picks\".\"pickedSide\"::text, \"public\".\"picks\".\"gameTime\", \"public\".\"picks\".\"gameNumber\", \"public\".\"picks\".\"status\"::text, \"public\".\"picks\".\"datePosted\", \"public\".\"picks\".\"sportId\" FROM \"public\".\"picks\" LEFT JOIN \"public\".\"cappers\" AS \"j1\" ON (\"j1\".\"id\") = (\"public\".\"picks\".\"capperId\") WHERE (\"public\".\"picks\".\"period\" = CAST($1::text AS \"public\".\"Period\") AND \"public\".\"picks\".\"betType\" IN (CAST($2::text AS \"public\".\"BetType\"),CAST($3::text AS \"public\".\"BetType\"),CAST($4::text AS \"public\".\"BetType\")) AND \"public\".\"picks\".\"status\" <> CAST($5::text AS \"public\".\"PickStatus\") AND \"public\".\"picks\".\"gameTime\" < $6 AND (\"j1\".\"isTest\" = $7 AND (\"j1\".\"id\" IS NOT NULL))) OFFSET $8",
    "expectLabel": "Heavy Consensus history (nightly / backfill)",
    "expectFlags": []
  },
  {
    "name": "getSportsWithLeagues, sports read",
    "run": "local-2026-10-27",
    "sql": "SELECT \"public\".\"sports\".\"id\", \"public\".\"sports\".\"name\" FROM \"public\".\"sports\" WHERE 1=1 ORDER BY \"public\".\"sports\".\"name\" ASC OFFSET $1",
    "expectLabel": "Sports / leagues reference read",
    "expectFlags": []
  },
  {
    "name": "getSportsWithLeagues, leagues follow-up",
    "run": "local-2026-10-27",
    "sql": "SELECT \"public\".\"leagues\".\"id\", \"public\".\"leagues\".\"name\", \"public\".\"leagues\".\"sportId\" FROM \"public\".\"leagues\" WHERE \"public\".\"leagues\".\"sportId\" IN ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) OFFSET $12",
    "expectLabel": "Sports / leagues reference read",
    "expectFlags": []
  },
  {
    "name": "prisma migrate deploy (prod DB Monitor text, 2026-10-27)",
    "run": "prod-2026-10-27",
    "sql": "SELECT * FROM \"_prisma_migrations\" ORDER BY \"started_at\" ASC",
    "expectLabel": "Migrate deploy (build-time)",
    "expectFlags": []
  },
  {
    "name": "mergeCappers pick read (prod DB Monitor text, 2026-10-27)",
    "run": "prod-2026-10-27",
    "sql": "SELECT \"public\".\"picks\".\"id\" FROM \"public\".\"picks\" WHERE (\"public\".\"picks\".\"userId\" = $1 AND \"public\".\"picks\".\"capperId\" = $2) ORDER BY \"public\".\"picks\".\"id\" ASC OFFSET $3",
    "expectLabel": "Capper merge (pick read)",
    "expectFlags": []
  }
];
