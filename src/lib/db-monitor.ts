import { Prisma } from "@prisma/client";
import { DB_ROW_THRESHOLD_DEFAULT, EXPECTED_HEAVY_MAX_AVG_ROWS, EXPECTED_HEAVY_NOTE } from "@/lib/admin-thresholds";

// Pure half of the admin DB Monitor (/admin/db-monitor): reads pg_stat_statements
// rows (fetched by src/server/data/db-monitor.ts in one statement) and turns them
// into what the page and the "Copy for Claude" report show - the statement text
// from FROM onward, a friendly label, red flags, and a rough byte estimate.
//
// Everything matches on the statement TEXT, the only thing pg_stat_statements
// keeps. That text is what Prisma / $queryRaw sent, with literal constants
// replaced by $n, so nothing below keys on a literal value.

export const DEFAULT_ROW_THRESHOLD = DB_ROW_THRESHOLD_DEFAULT;
export const TOP_STATEMENT_LIMIT = 30;

// ---------------------------------------------------------------------------
// Statement shape
// ---------------------------------------------------------------------------

// One line, comments dropped, and the `"public".` schema prefix Prisma puts on
// every name removed (every app table is in public; it only adds noise). The
// comments have to go before whitespace collapses - a `--` comment left in a
// one-line string would swallow the rest of the statement.
export function normalizeSql(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/"public"\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Index of the first `keyword` (a word, matched case-insensitively) at
// parenthesis depth 0 and outside quotes, searching from `from`; -1 if none.
// Depth matters: `extract(epoch FROM p."createdAt")` and subqueries both carry
// a FROM that isn't the statement's own.
function topLevelIndexOf(sql: string, keyword: string, from = 0): number {
  const kw = keyword.toUpperCase();
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (
      i >= from &&
      depth === 0 &&
      sql.slice(i, i + kw.length).toUpperCase() === kw &&
      !/\w/.test(sql[i - 1] ?? " ") &&
      !/\w/.test(sql[i + kw.length] ?? " ")
    ) {
      return i;
    }
  }
  return -1;
}

// The first top-level index of any of `keywords` from `from`, or the end.
function topLevelEnd(sql: string, keywords: string[], from: number): number {
  const hits = keywords.map((k) => topLevelIndexOf(sql, k, from)).filter((i) => i >= 0);
  return hits.length ? Math.min(...hits) : sql.length;
}

export type StatementShape = {
  // normalizeSql(query)
  text: string;
  // What the monitor shows: a plain SELECT from its own FROM onward (the
  // column list is the long, uninteresting part). A WITH / INSERT / UPDATE /
  // DELETE is shown whole - a CTE statement's work is in its CTEs, before the
  // final FROM.
  tail: string;
  // Names after FROM / JOIN / UPDATE / INTO anywhere in the statement.
  tables: string[];
  // The table the outermost SELECT reads, when it reads one directly.
  primaryTable: string | null;
  // How many "picks"."col" entries the outermost SELECT list names.
  picksColumnsSelected: number;
  // The outermost WHERE clause (without the keyword), "" if none.
  where: string;
  hasLimit: boolean;
  // Any gameTime comparison (>=, >, <=, <) anywhere - a date bound.
  hasGameTimeBound: boolean;
};

export function describeStatement(query: string): StatementShape {
  const text = normalizeSql(query);
  const isSelect = /^SELECT\b/i.test(text);
  const fromIdx = isSelect ? topLevelIndexOf(text, "FROM") : -1;
  const tail = fromIdx >= 0 ? text.slice(fromIdx) : text;
  const selectList = fromIdx >= 0 ? text.slice(0, fromIdx) : "";

  const tables = Array.from(
    new Set(Array.from(text.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gi), (m) => m[1]))
  );
  const primary = fromIdx >= 0 ? /^FROM "?([A-Za-z_][A-Za-z0-9_]*)"?/i.exec(tail) : null;

  let where = "";
  if (fromIdx >= 0) {
    const w = topLevelIndexOf(tail, "WHERE");
    if (w >= 0) where = tail.slice(w + 5, topLevelEnd(tail, ["GROUP", "ORDER", "LIMIT", "OFFSET", "HAVING"], w)).trim();
  }

  return {
    text,
    tail,
    tables,
    primaryTable: primary ? primary[1] : null,
    picksColumnsSelected: (selectList.match(/"picks"\."/g) ?? []).length,
    where,
    hasLimit: topLevelIndexOf(tail, "LIMIT") >= 0,
    hasGameTimeBound: /"gameTime"\s*(?:>=|<=|>|<)/.test(text),
  };
}

// A Prisma findMany/findFirst with no `select` names every scalar column. The
// count comes from the generated client so it follows the schema; the slack
// covers statements recorded before the last few columns were added (the
// retired shapes were 29 columns, the schema is 30 today).
export const PICK_COLUMN_COUNT = Object.keys(Prisma.PickScalarFieldEnum).length;
const FULL_ROW_SLACK = 3;

export function isFullRowPicks(s: StatementShape): boolean {
  return s.picksColumnsSelected >= PICK_COLUMN_COUNT - FULL_ROW_SLACK;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const USER_EQ = /"picks"\."userId" = \$\d+/;
const SPORT_EQ = /"picks"\."sportId" = \$\d+/;
const STATUS_EQ = /"picks"\."status" = /;
const CAPPER_EQ = /"picks"\."capperId" = \$\d+/;
const CAPPER_IN = /"picks"\."capperId" IN \(/;
const ID_IN = /"picks"\."id" IN \(/;
const GAME_TIME_GTE = /"picks"\."gameTime" >= /;
const GAME_TIME_LT = /"picks"\."gameTime" <=? /;
const ORDER_GAME_TIME = /ORDER BY "picks"\."gameTime"/;
const ORDER_GAME_TIME_ASC = /ORDER BY "picks"\."gameTime" ASC/;
const ORDER_GAME_TIME_DESC = /ORDER BY "picks"\."gameTime" DESC/;

const touchesPicks = (s: StatementShape) => s.tables.includes("picks");
const has = (s: StatementShape, re: RegExp) => re.test(s.text);
const reads = (s: StatementShape, table: string) => s.primaryTable === table;
const inserts = (s: StatementShape, table: string) => s.text.startsWith(`INSERT INTO "${table}" `);
// The outermost WHERE with its grouping parentheses dropped, and the trailing
// always-true conjunct Prisma adds to a findUnique (`AND 1=1`, which
// pg_stat_statements stores as `AND $4=$5`) cut off.
const whereOf = (s: StatementShape) =>
  s.where
    .replace(/[()]/g, "")
    .replace(/ AND (?:1=1|\$\d+=\$\d+)$/, "")
    .trim();
const whereIs = (s: StatementShape, re: RegExp) => re.test(whereOf(s));
const GR_SPORT_ONLY = /^"game_results"\."sportKey" = \$\d+$/;
// A findMany with no `where` sends `WHERE 1=1` (pg_stat_statements: `$2=$3`).
const ALWAYS_TRUE = /^(?:1=1|\$\d+=\$\d+)$/;
const isRosterTable = (t: string | null) => t !== null && /^(?:nfl|mlb|nhl|nba)_roster_players$/.test(t);
// Both whole-table roster reads select the row id (Prisma adds the key); they
// differ in column order. The refresh's diff read names the league's player
// id right after it (roster-table-adapter.ts); the cache read names it last.
const ROSTER_DIFF_COLUMNS = /^SELECT "(?:nfl|mlb|nhl|nba)_roster_players"\."id", "(?:nfl|mlb|nhl|nba)_roster_players"\."(?:espn|mlb)PlayerId",/;

// A label whose statement reads a sport's whole history by design. Under
// maxAvgRows it is shown with `note` instead of a row-threshold flag.
export type ExpectedHeavy = { maxAvgRows: number; note: string };
const DAILY_FULL_HISTORY: ExpectedHeavy = { maxAvgRows: EXPECTED_HEAVY_MAX_AVG_ROWS, note: EXPECTED_HEAVY_NOTE };

export type StatementLabel = {
  label: string;
  source: string;
  matches: (s: StatementShape) => boolean;
  expected?: ExpectedHeavy;
};

// First match wins. Each fingerprint was taken from the statement its code
// path actually sends (captured with a query log against the local DB, or for
// three cron upserts that need live feeds, from production's
// pg_stat_statements - see db-monitor-fixtures.ts); db-monitor-acceptance-
// test.ts pins that every fixture gets its own label and no other.
export const STATEMENT_LABELS: StatementLabel[] = [
  {
    label: "Fuzzy grading",
    source: "regradeAllFuzzyMatchedPicks (grade-picks cron)",
    matches: (s) => touchesPicks(s) && has(s, /"picks"\."gradedViaFuzzyMatch" = /),
  },
  {
    // The findMany and its count() - both cross-user, sport + PENDING + lookback.
    label: "Grading pending",
    source: "gradeAllPendingPicks (grade-picks cron)",
    matches: (s) => touchesPicks(s) && has(s, SPORT_EQ) && has(s, STATUS_EQ) && has(s, GAME_TIME_GTE) && !has(s, USER_EQ),
  },
  {
    // getPicksForGame(s): one user's sport, a gameTime window. Matches both the
    // +-2-day full-row read and #277's +-6h projected one.
    label: "Board window",
    source: "getPicksForGames / getPicksForGame (/live board, game detail)",
    matches: (s) => touchesPicks(s) && has(s, USER_EQ) && has(s, SPORT_EQ) && has(s, GAME_TIME_GTE) && has(s, GAME_TIME_LT),
  },
  {
    label: "/picks",
    source: "getFilteredPicksForUser (date range) / getPendingPicksForUser",
    matches: (s) =>
      touchesPicks(s) &&
      has(s, USER_EQ) &&
      !has(s, SPORT_EQ) &&
      ((has(s, GAME_TIME_GTE) && has(s, GAME_TIME_LT) && has(s, ORDER_GAME_TIME_DESC)) ||
        (has(s, STATUS_EQ) && has(s, ORDER_GAME_TIME_ASC) && !s.hasGameTimeBound)),
  },
  {
    // "Load older picks": one keyset page (LIMIT 51) strictly before the
    // window, ordered gameTime DESC, id DESC - the id tiebreak is the
    // fingerprint. Also its one-row reload after a row's result changes,
    // which reads the 18 ledger columns (the full-row findFirst by id +
    // userId in updatePickStatus is a different statement).
    label: "/picks older",
    source: "getOlderPicks / reloadOlderLedgerRow (picks-older.ts, loadOlderPicksAction)",
    matches: (s) =>
      touchesPicks(s) &&
      s.hasLimit &&
      ((has(s, USER_EQ) && has(s, /ORDER BY "picks"\."gameTime" DESC, "picks"\."id" DESC/)) ||
        (whereIs(s, /^"picks"\."id" = \$\d+ AND "picks"\."userId" = \$\d+$/) && !isFullRowPicks(s))),
  },
  {
    label: "Slip id IN",
    source: "getSlipPickStatesAction (parlay slip)",
    matches: (s) => touchesPicks(s) && has(s, USER_EQ) && has(s, ID_IN),
  },
  {
    label: "Capper comparison",
    source: "getCapperComparison (/charts compare)",
    matches: (s) => touchesPicks(s) && has(s, USER_EQ) && has(s, CAPPER_EQ) && has(s, ORDER_GAME_TIME_ASC),
  },
  {
    label: "Record bundle",
    source: "getCapperLeagueRecords (league/category records SQL)",
    matches: (s) => /^WITH base AS MATERIALIZED \(/.test(s.text) && /"cardReq"/.test(s.text),
  },
  {
    // Anchored at the start, with the panel's own WHERE and window: the same
    // `WITH g AS (SELECT p."capperId" AS cid, p.category AS cat` opening is
    // the specialist-candidates CTE, which the /cappers bundle nests inside
    // itself.
    label: "Category panel",
    source: "getSportCategoryPanelData (SQL category panel, /live)",
    matches: (s) =>
      /^WITH g AS \( SELECT p\."capperId" AS cid, p\.category AS cat\b/.test(s.text) &&
      /\bp\.category IS NOT NULL\b/.test(s.text) &&
      /\bPARTITION BY cat\b/.test(s.text),
  },

  // ---- Page loads ----
  {
    label: "Session user",
    source: "getCurrentUser / requireUser (server/auth.ts), every signed-in request",
    matches: (s) => reads(s, "users") && whereIs(s, /^"users"\."supabaseId" = \$\d+$/),
  },
  {
    // id + name since #297; entries recorded before it read the whole row
    // (notes, photo url) and match too - the ORDER BY is the fingerprint.
    label: "Capper roster",
    source: "getCappersForUser (/picks, /charts, /picks/import, /live category panel)",
    matches: (s) => reads(s, "cappers") && has(s, /"cappers"\."userId" = \$\d+/) && has(s, /ORDER BY "cappers"\."isFavorite" DESC/),
  },
  {
    // The user's cappers by name, in no order: id + name since #297 / #312;
    // entries recorded before them (find-or-create, the parlay import) read the
    // whole row.
    label: "Capper names (import / find-or-create)",
    source: "findOrCreateCapper scan, resolveImportRefs, bulkImportPicksAction, bulkImportParlaysAction",
    matches: (s) => reads(s, "cappers") && whereIs(s, /^"cappers"\."userId" = \$\d+$/) && !has(s, /\bORDER BY\b/) && !has(s, /"_aggr_count_picks"/),
  },
  {
    // Prisma's follow-up read for `include: { capper: ... }` on a picks
    // findMany. Each IN-list length is its own pg_stat_statements entry.
    label: "Capper include",
    source: "picks findMany include capper (getPicksForGames, getPendingPicksForUser, /picks lists)",
    matches: (s) => reads(s, "cappers") && whereIs(s, /^"cappers"\."id" IN [$\d,]+$/),
  },
  {
    label: "Cappers with pick counts",
    source: "loadCappersWithPickCounts (/cappers, capper detail; 60s cache)",
    matches: (s) => reads(s, "cappers") && has(s, /"_aggr_count_picks"/),
  },
  {
    label: "Capper all-time W-L",
    source: "getCapperAllTimeRecords (picks-summary.ts, /picks)",
    matches: (s) => touchesPicks(s) && has(s, USER_EQ) && has(s, CAPPER_IN) && has(s, /GROUP BY "picks"\."capperId", "picks"\."status"/),
  },
  {
    label: "/picks final scores",
    source: "getFinalScoresForPicks (picks-summary.ts, /picks)",
    matches: (s) => reads(s, "game_results") && has(s, /"game_results"\."sportKey" IN \(/) && has(s, /"game_results"\."gameDate" >= /),
  },
  {
    // getMostBacked has the same HAVING but also bool_or(b.pending).
    label: "Day consensus",
    source: "getDayConsensus (picks-glance.ts, /picks at a glance)",
    matches: (s) => has(s, /HAVING count\(DISTINCT b\."capperId"\) >= /) && !has(s, /\bbool_or\(/),
  },
  {
    label: "Zone model",
    source: "computeZoneModel / computePendingZoneGames (zone-model.ts, /zone-model)",
    matches: (s) =>
      (reads(s, "game_results") && whereIs(s, GR_SPORT_ONLY) && has(s, /"game_results"\."favTeam"/) && !has(s, /ORDER BY/)) ||
      ((reads(s, "team_tendency_snapshots") || reads(s, "team_stat_snapshots")) && whereIs(s, /^"team_(?:tendency|stat)_snapshots"\."sportKey" = \$\d+$/)),
  },

  // ---- grade-picks cron (every 15 min; the page-load grading paths share these) ----
  {
    // findUnique by name: 4 per sport per run (picks, fuzzy regrade, legs, leg regrade).
    label: "Grading sport lookup",
    source: "gradeAllPendingPicks / regradeAllFuzzyMatchedPicks / gradeAllPendingLegs / regradeAllFuzzyMatchedLegs",
    matches: (s) => reads(s, "sports") && whereIs(s, /^"sports"\."name" = \$\d+$/) && s.hasLimit,
  },
  {
    label: "Game results window",
    source: "fetchCandidatePool / findMatchingGameResult (grading.ts), parlay-grading.ts candidate pools",
    matches: (s) =>
      reads(s, "game_results") &&
      whereIs(s, /^"game_results"\."sportKey" = \$\d+ AND "game_results"\."gameDate" >= \$\d+ AND "game_results"\."gameDate" < \$\d+$/),
  },
  {
    label: "Grading pending legs",
    source: "gradeAllPendingLegs (parlay-grading.ts)",
    matches: (s) => s.tables.includes("legs") && has(s, /"legs"\."sportId" = \$\d+/) && has(s, /"legs"\."status" = /) && has(s, /"legs"\."gameTime" >= /),
  },
  {
    label: "Final-score state",
    source: "fetchExistingResultState (persistFinalScores, grade-picks + refresh-scores)",
    matches: (s) => s.tail.startsWith('FROM game_results WHERE "sportKey" = ') && has(s, /"externalId" = ANY\(/),
  },
  {
    label: "Final-score upsert",
    source: "persistFinalScores (grading.ts); each update-field combination is its own entry",
    matches: (s) => inserts(s, "game_results") && has(s, /ON CONFLICT \("sportKey","externalId"\)/),
  },

  // ---- refresh-scores cron (daily) ----
  {
    label: "Odds for tendencies",
    source: "getOddsGamesForTendencies (recomputeTeamTendencies)",
    matches: (s) =>
      /^FROM odds_snapshots s CROSS JOIN LATERAL jsonb_array_elements\(/.test(s.tail) && /WHERE s\."sportKey" = \$\d+ ORDER BY s\."fetchDate", g\.ord$/.test(s.tail),
    expected: DAILY_FULL_HISTORY,
  },
  {
    label: "Tendency game results",
    source: "recomputeTeamTendencies (team-tendencies.ts)",
    matches: (s) => reads(s, "game_results") && whereIs(s, /^"game_results"\."sportKey" = \$\d+ AND "game_results"\."isPreseason" = \$\d+$/),
  },
  {
    label: "Tendency upsert",
    source: "recomputeTeamTendencies (team-tendencies.ts)",
    matches: (s) => inserts(s, "team_tendencies"),
  },
  {
    label: "Tendencies by sport",
    source: "snapshotTeamTendencies (team-tendencies.ts); zone-model.ts sends the same read",
    matches: (s) => reads(s, "team_tendencies") && whereIs(s, /^"team_tendencies"\."sportKey" = \$\d+$/),
  },
  {
    label: "Tendency snapshot upsert",
    source: "snapshotTeamTendencies (team-tendencies.ts)",
    matches: (s) => inserts(s, "team_tendency_snapshots"),
  },
  {
    // One team's whole history: since #310 only the per-team fallback (a team
    // or asOf outside a sync pass's batch); before it, every decay-delta input.
    label: "Tendency history (model)",
    source: "resolveTeamTendency (model-engine/resolver.ts, decay-delta sync)",
    matches: (s) =>
      reads(s, "team_tendency_snapshots") &&
      whereIs(s, /^"team_tendency_snapshots"\."sportKey" = \$\d+ AND "team_tendency_snapshots"\."teamName" = \$\d+$/) &&
      has(s, /ORDER BY "team_tendency_snapshots"\."snapshotDate" ASC/),
  },
  {
    // #310: one read per decay-delta sync pass for every team it can resolve,
    // bounded to the pass's asOf span (raw SQL with a per-team floor subquery).
    label: "Tendency history (batch)",
    source: "createTendencyHistorySource (model-engine/tendency-history.ts, decay-delta sync)",
    matches: (s) =>
      /^FROM team_tendency_snapshots t WHERE t\."sportKey" = \$\d+ AND t\."teamName" = ANY\(/.test(s.tail) &&
      has(s, /SELECT max\(s\."snapshotDate"\)/),
  },
  {
    label: "Game observations (model)",
    source: "resolveAllGameObservations (model-engine/observations.ts, decay-delta sync)",
    matches: (s) => reads(s, "game_results") && whereIs(s, GR_SPORT_ONLY) && has(s, /ORDER BY "game_results"\."gameDate" ASC OFFSET/),
    expected: DAILY_FULL_HISTORY,
  },
  {
    label: "Decay-delta persisted ids",
    source: "persistGradedDecayDeltaGames (model-engine/decay-delta-predictions.ts)",
    matches: (s) =>
      reads(s, "decay_delta_predictions") &&
      whereIs(s, /^"decay_delta_predictions"\."modelId" = \$\d+ AND "decay_delta_predictions"\."gameResultId" IS NOT NULL$/),
    expected: DAILY_FULL_HISTORY,
  },
  {
    label: "Team record snapshot",
    source: "captureTeamRecordSnapshots (team-record.ts, NFL)",
    matches: (s) =>
      inserts(s, "team_record_snapshots") ||
      (reads(s, "game_results") && whereIs(s, GR_SPORT_ONLY) && has(s, /"game_results"\."isPreseason" FROM/) && !has(s, /ORDER BY/)),
  },
  {
    label: "Situational snapshot upsert",
    source: "captureSituationalRateSnapshots (situational-snapshots.ts, NFL)",
    matches: (s) => inserts(s, "situational_rate_snapshots"),
  },
  {
    label: "NFL team stat upsert",
    source: "captureNflTeamStatSnapshots (stat-snapshots.ts)",
    matches: (s) => inserts(s, "nfl_team_stat_snapshots"),
  },

  // ---- roster tables (nfl / mlb / nhl / nba _roster_players) ----
  {
    // The whole table, no filter (WHERE 1=1): one league's grading + import
    // views. Behind the Data Cache since #302, so about once a day per league.
    label: "Roster cache (grading / import recovery)",
    source: "nfl/mlb/nhl/nba-roster-cache.ts readAll (prop grading fallback, recover-unresolved-picks)",
    matches: (s) => isRosterTable(s.primaryTable) && whereIs(s, ALWAYS_TRUE) && !has(s, ROSTER_DIFF_COLUMNS),
  },
  {
    // The same whole-table read in the refresh's column order: it diffs the
    // feed against it before writing. Daily, all rows by design.
    label: "Roster refresh diff",
    source: "roster-table-adapter.ts readForDiff (refresh-rosters cron, scripts/load-*-roster.ts)",
    matches: (s) => isRosterTable(s.primaryTable) && whereIs(s, ALWAYS_TRUE) && has(s, ROSTER_DIFF_COLUMNS),
    expected: DAILY_FULL_HISTORY,
  },
  {
    label: "NFL roster names (bulk import)",
    source: "getCachedNflRosterFullNames (nfl-roster-cache.ts, 1h Data Cache)",
    matches: (s) => reads(s, "nfl_roster_players") && whereIs(s, /^"nfl_roster_players"\."active" = \$\d+$/),
  },
];

export function labelEntryFor(s: StatementShape): StatementLabel | null {
  return STATEMENT_LABELS.find((l) => l.matches(s)) ?? null;
}

export function labelFor(s: StatementShape): string | null {
  return labelEntryFor(s)?.label ?? null;
}

// The expected-heavy allowance for a label, if it has one.
export function expectedFor(label: string | null): ExpectedHeavy | null {
  return (label && STATEMENT_LABELS.find((l) => l.label === label)?.expected) || null;
}

// ---------------------------------------------------------------------------
// Red flags
// ---------------------------------------------------------------------------

export type RedFlagCode = "RETIRED_A" | "RETIRED_B" | "RETIRED_C" | "UNLABELED_FULL_ROW" | "ROW_THRESHOLD";
export type RedFlag = { code: RedFlagCode; reason: string };

// Retired shape C was a WHERE on userId and nothing else (getPickRowsForStats:
// the user's whole history). Requiring "nothing else" is what keeps it apart
// from capper comparison, which is also userId + ORDER BY gameTime with no
// bound or LIMIT but is scoped to one capper on purpose.
function whereIsUserIdOnly(where: string): boolean {
  return /^"picks"\."userId" = \$\d+$/.test(where.replace(/[()]/g, "").trim());
}

export function redFlagsFor(s: StatementShape, label: string | null, avgRows: number, threshold: number): RedFlag[] {
  const flags: RedFlag[] = [];
  const picks = touchesPicks(s);

  if (picks && isFullRowPicks(s) && has(s, USER_EQ) && has(s, CAPPER_IN) && !s.hasGameTimeBound) {
    flags.push({ code: "RETIRED_A", reason: "Retired shape A: full-row picks by userId + capperId IN, no date bound (fetchPicksByCapper, replaced in #130)" });
  }
  const join = /\bFROM "picks" LEFT JOIN "sports" AS "(\w+)"/.exec(s.text);
  if (join && new RegExp(`"${join[1]}"\\."name" = `).test(s.text) && !s.hasGameTimeBound) {
    flags.push({ code: "RETIRED_B", reason: "Retired shape B: picks LEFT JOIN sports on sport name, no date bound (raw getSportCategoryPanelData, replaced in #128)" });
  }
  if (picks && whereIsUserIdOnly(s.where) && has(s, ORDER_GAME_TIME) && !s.hasGameTimeBound && !s.hasLimit) {
    flags.push({ code: "RETIRED_C", reason: "Retired shape C: picks by userId alone, ORDER BY gameTime, no date bound or LIMIT (getPickRowsForStats, replaced in #142)" });
  }
  if (!label && picks && isFullRowPicks(s)) {
    flags.push({ code: "UNLABELED_FULL_ROW", reason: `Unlabeled full-row picks read (${s.picksColumnsSelected} columns)` });
  }
  // An expected-heavy read is held to its own ceiling instead of the threshold.
  const expected = expectedFor(label);
  if (expected) {
    if (avgRows > expected.maxAvgRows) {
      flags.push({
        code: "ROW_THRESHOLD",
        reason: `Averages ${formatNumber(Math.round(avgRows))} rows/call, above its expected-read ceiling of ${formatNumber(expected.maxAvgRows)}`,
      });
    }
  } else if (avgRows > threshold) {
    flags.push({ code: "ROW_THRESHOLD", reason: `Averages ${formatNumber(Math.round(avgRows))} rows/call (threshold ${formatNumber(threshold)})` });
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Byte estimate
// ---------------------------------------------------------------------------

// Approximate bytes per row: avg(pg_column_size(t.*)) on a restore of the
// 2026-09-15 production dump (picks, cappers, users, leagues, sports,
// subscriptions, dismissed_duplicate_pairs) and on the local dev DB for
// game_results. A rough on-disk width, not the wire size - the header
// labels the total an estimate.
export const APPROX_ROW_BYTES: Record<string, number> = {
  picks: 275,
  users: 237,
  dismissed_duplicate_pairs: 136,
  cappers: 134,
  subscriptions: 114,
  leagues: 81,
  sports: 55,
  game_results: 681,
};
const DEFAULT_ROW_BYTES = 200;

export function approxRowBytes(s: StatementShape): number {
  const table = s.primaryTable ?? s.tables.find((t) => t in APPROX_ROW_BYTES) ?? null;
  return (table && APPROX_ROW_BYTES[table]) || DEFAULT_ROW_BYTES;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

// pg_stat_statements already replaces every literal with $n, so the text should
// never carry a user id, email or parameter value. This is the backstop for
// anything it couldn't normalize: a quoted literal that looks like an email, a
// cuid, a uuid or a long number is masked.
const SENSITIVE_LITERAL = /'(?:[^'@\s]+@[^'\s]+|c[a-z0-9]{20,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{6,})'/gi;

export function redactLiterals(sql: string): string {
  return sql.replace(SENSITIVE_LITERAL, "'<redacted>'");
}

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export type RawStatement = { queryid: string; query: string; calls: number; rows: number; totalExecMs: number };
export type RawSnapshot = {
  statsReset: Date | null;
  dealloc: number;
  totalRows: number;
  statementCount: number;
  top: RawStatement[];
};

export type MonitorRow = {
  queryid: string;
  label: string | null;
  // The expected-heavy note ("expected (daily cron, full history)") when the
  // label has one and the row stayed under its ceiling.
  expected: string | null;
  calls: number;
  rows: number;
  avgRows: number;
  totalExecMs: number;
  text: string;
  estBytes: number;
  flags: RedFlag[];
};

export type MonitorView = {
  statsReset: Date | null;
  sinceResetMs: number | null;
  dealloc: number;
  totalRows: number;
  statementCount: number;
  estBytesTop: number;
  threshold: number;
  rows: MonitorRow[];
  flaggedCount: number;
};

export function buildMonitorView(raw: RawSnapshot, threshold: number, now: Date): MonitorView {
  const rows = raw.top.map((st): MonitorRow => {
    const shape = describeStatement(st.query);
    const label = labelFor(shape);
    const avgRows = st.calls > 0 ? st.rows / st.calls : 0;
    const expected = expectedFor(label);
    return {
      queryid: st.queryid,
      label,
      expected: expected && avgRows <= expected.maxAvgRows ? expected.note : null,
      calls: st.calls,
      rows: st.rows,
      avgRows,
      totalExecMs: st.totalExecMs,
      text: redactLiterals(shape.tail),
      estBytes: st.rows * approxRowBytes(shape),
      flags: redFlagsFor(shape, label, avgRows, threshold),
    };
  });
  return {
    statsReset: raw.statsReset,
    sinceResetMs: raw.statsReset ? Math.max(0, now.getTime() - raw.statsReset.getTime()) : null,
    dealloc: raw.dealloc,
    totalRows: raw.totalRows,
    statementCount: raw.statementCount,
    estBytesTop: rows.reduce((sum, r) => sum + r.estBytes, 0),
    threshold,
    rows,
    flaggedCount: rows.filter((r) => r.flags.length > 0).length,
  };
}

// ?threshold= from the page's GET form: a positive whole number, else the default.
export function parseRowThreshold(param: string | string[] | undefined): number {
  const v = Number(Array.isArray(param) ? param[0] : param);
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_ROW_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Formatting (page + report)
// ---------------------------------------------------------------------------

export function formatNumber(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export function formatAvg(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: n < 10 ? 1 : 0 });
}

export function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb.toLocaleString("en-US", { maximumFractionDigits: mb < 10 ? 2 : 1 }) + " MB";
}

export function formatDuration(ms: number): string {
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

function formatUtc(d: Date): string {
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

// "Copy for Claude": plain text to paste into a chat or a Claude Code prompt.
// Statement text only - pg_stat_statements has no app user ids and no
// parameter values, and redactLiterals masks anything that looks like one.
export function formatClaudeReport(view: MonitorView): string {
  const lines: string[] = [];
  lines.push(`DB Monitor report - pg_stat_statements, statements touching public tables, top ${view.rows.length} by rows`);
  lines.push(
    view.statsReset && view.sinceResetMs !== null
      ? `Since last stats reset: ${formatDuration(view.sinceResetMs)} (reset ${formatUtc(view.statsReset)})`
      : "Since last stats reset: unknown"
  );
  lines.push(`Total rows, all statements in this database: ${formatNumber(view.totalRows)} (${formatNumber(view.statementCount)} statements)`);
  lines.push(`Estimated rows x approx row width, top ${view.rows.length}: ~${formatMb(view.estBytesTop)} (ESTIMATE)`);
  if (view.dealloc > 0) lines.push(`Note: ${formatNumber(view.dealloc)} statement entries were evicted since the reset, so totals undercount.`);
  lines.push(`Row threshold: ${formatNumber(view.threshold)} avg rows/call. Flagged: ${view.flaggedCount} of ${view.rows.length}.`);
  lines.push('Schema prefix "public". omitted from statement text.');

  view.rows.forEach((r, i) => {
    lines.push("");
    lines.push(
      `${i + 1}. ${r.flags.length ? "[FLAG] " : ""}${r.label ?? "Unlabeled"}${r.expected ? ` [${r.expected}]` : ""} - calls ${formatNumber(r.calls)}, rows ${formatNumber(r.rows)}, avg ${formatAvg(r.avgRows)} rows/call, exec ${formatNumber(r.totalExecMs)} ms`
    );
    for (const f of r.flags) lines.push(`   [FLAG] ${f.reason}`);
    lines.push(`   ${r.text}`);
  });
  return lines.join("\n");
}
