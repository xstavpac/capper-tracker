import { Prisma } from "@prisma/client";

// Pure half of the admin DB Monitor (/admin/db-monitor): reads pg_stat_statements
// rows (fetched by src/server/data/db-monitor.ts in one statement) and turns them
// into what the page and the "Copy for Claude" report show - the statement text
// from FROM onward, a friendly label, red flags, and a rough byte estimate.
//
// Everything matches on the statement TEXT, the only thing pg_stat_statements
// keeps. That text is what Prisma / $queryRaw sent, with literal constants
// replaced by $n, so nothing below keys on a literal value.

export const DEFAULT_ROW_THRESHOLD = 500;
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

// First match wins. Each fingerprint was taken from the statement its code
// path actually sends (captured with a query log against the local DB - see
// db-monitor-fixtures.ts); db-monitor-acceptance-test.ts pins that every
// fixture gets its own label and no other.
export const STATEMENT_LABELS: { label: string; source: string; matches: (s: StatementShape) => boolean }[] = [
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
];

export function labelFor(s: StatementShape): string | null {
  return STATEMENT_LABELS.find((l) => l.matches(s))?.label ?? null;
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
  if (avgRows > threshold) {
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
    return {
      queryid: st.queryid,
      label,
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
      `${i + 1}. ${r.flags.length ? "[FLAG] " : ""}${r.label ?? "Unlabeled"} - calls ${formatNumber(r.calls)}, rows ${formatNumber(r.rows)}, avg ${formatAvg(r.avgRows)} rows/call, exec ${formatNumber(r.totalExecMs)} ms`
    );
    for (const f of r.flags) lines.push(`   [FLAG] ${f.reason}`);
    lines.push(`   ${r.text}`);
  });
  return lines.join("\n");
}
