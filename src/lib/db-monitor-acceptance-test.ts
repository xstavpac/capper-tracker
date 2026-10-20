// DB Monitor (/admin/db-monitor): labels, red flags, FROM-onward text, byte
// estimate, the "Copy for Claude" report, and the admin gate wiring.
//
// The statements are real (db-monitor-fixtures.ts: query-log captures of each
// code path, including the three retired shapes at the commit before #128).
// Each is checked as Prisma sent it AND as pg_stat_statements would store it
// (literal constants swapped for $n).
//
// Pure, no DB. Run with:
//   npx tsx src/lib/db-monitor-acceptance-test.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  STATEMENT_LABELS,
  PICK_COLUMN_COUNT,
  APPROX_ROW_BYTES,
  DEFAULT_ROW_THRESHOLD,
  describeStatement,
  labelFor,
  redFlagsFor,
  isFullRowPicks,
  approxRowBytes,
  redactLiterals,
  buildMonitorView,
  formatClaudeReport,
  parseRowThreshold,
  formatDuration,
  type RawSnapshot,
} from "@/lib/db-monitor";
import { STATEMENT_FIXTURES } from "@/lib/db-monitor-fixtures";
import { DB_ROW_THRESHOLD_DEFAULT, EXPECTED_HEAVY_MAX_AVG_ROWS, EXPECTED_HEAVY_NOTE } from "@/lib/admin-thresholds";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

// What pg_stat_statements does to a statement's text: every literal constant
// (quoted strings, bare numbers outside identifiers and $n) becomes the next $n.
// Its lexer leaves comments alone; this stand-in skips comment lines so an
// apostrophe in one ("doesn't") isn't read as the start of a string.
function asPgStatStatements(sql: string): string {
  let n = 100;
  return sql
    .split("\n")
    .map((line) => {
      const c = line.indexOf("--");
      const code = c >= 0 ? line.slice(0, c) : line;
      const rest = c >= 0 ? line.slice(c) : "";
      return code.replace(/'(?:[^']|'')*'/g, () => `$${n++}`).replace(/(?<![\w$."])\b\d+(?:\.\d+)?\b(?!["\w])/g, () => `$${n++}`) + rest;
    })
    .join("\n");
}

function flagCodes(sql: string, avgRows = 1, threshold = DEFAULT_ROW_THRESHOLD) {
  const s = describeStatement(sql);
  return redFlagsFor(s, labelFor(s), avgRows, threshold).map((f) => f.code);
}

// ---- 1. Every real statement gets its own label and only the flags expected ----
for (const fx of STATEMENT_FIXTURES) {
  for (const [form, sql] of [
    ["as sent", fx.sql],
    ["as pg_stat_statements stores it", asPgStatStatements(fx.sql)],
  ] as const) {
    const s = describeStatement(sql);
    expect(`${fx.name} (${fx.run}, ${form}): label`, labelFor(s), fx.expectLabel);
    expect(`${fx.name} (${form}): red flags`, flagCodes(sql), fx.expectFlags);
    const matching = STATEMENT_LABELS.filter((l) => l.matches(s)).map((l) => l.label);
    expect(`${fx.name} (${form}): matches exactly ${fx.expectLabel ? "one fingerprint" : "no fingerprint"}`, matching, fx.expectLabel ? [fx.expectLabel] : []);
  }
}

// Every label the monitor knows is exercised by at least one real statement.
expect(
  "every fingerprint has a real statement behind it",
  STATEMENT_LABELS.map((l) => l.label).filter((l) => !STATEMENT_FIXTURES.some((f) => f.expectLabel === l)),
  []
);
expect(
  "the labels: the eight from #279, one per statement in the 2026-10-19 prod top 30, and the egress-plan reads (2026-10-20)",
  STATEMENT_LABELS.map((l) => l.label).sort(),
  [
    "/picks",
    "/picks final scores",
    "Board window",
    "Capper all-time W-L",
    "Capper comparison",
    "Capper include",
    "Capper names (import / find-or-create)",
    "Capper roster",
    "Cappers with pick counts",
    "Category panel",
    "Day consensus",
    "Decay-delta persisted ids",
    "Final-score state",
    "Final-score upsert",
    "Fuzzy grading",
    "Game observations (model)",
    "Game results window",
    "Grading pending",
    "Grading pending legs",
    "Grading sport lookup",
    "NFL roster names (bulk import)",
    "NFL team stat upsert",
    "Odds for tendencies",
    "Record bundle",
    "Roster cache (grading / import recovery)",
    "Roster refresh diff",
    "Session user",
    "Situational snapshot upsert",
    "Slip id IN",
    "Team record snapshot",
    "Tendencies by sport",
    "Tendency game results",
    "Tendency history (batch)",
    "Tendency history (model)",
    "Tendency snapshot upsert",
    "Tendency upsert",
    "Zone model",
  ]
);
expect("label names are unique", new Set(STATEMENT_LABELS.map((l) => l.label)).size, STATEMENT_LABELS.length);
expect("every label names its code path", STATEMENT_LABELS.filter((l) => !l.source.trim()).map((l) => l.label), []);

const fixture = (name: string) => {
  const f = STATEMENT_FIXTURES.find((x) => x.name.startsWith(name));
  if (!f) throw new Error("no fixture " + name);
  return f.sql;
};

// ---- 2. Shape details the flags rest on ----
{
  const a = describeStatement(fixture("retired A"));
  const b = describeStatement(fixture("retired B"));
  const c = describeStatement(fixture("retired C"));
  expect("retired shapes are full-row reads of the 29-column schema of their day", [a, b, c].map((s) => s.picksColumnsSelected), [29, 29, 29]);
  expect("full row = within 3 of today's column count", [PICK_COLUMN_COUNT >= 29, [a, b, c].every(isFullRowPicks)], [true, true]);
  expect("today's full-row board read counts as full row", isFullRowPicks(describeStatement(fixture("board window, main"))), true);
  expect("#277's projected board read (18 columns) does not", [describeStatement(fixture("board window, #277")).picksColumnsSelected, isFullRowPicks(describeStatement(fixture("board window, #277")))], [18, false]);
  expect("capper comparison's 15-column read does not", isFullRowPicks(describeStatement(fixture("capper comparison"))), false);
  expect("retired C's WHERE is userId alone", c.where, '"picks"."userId" = $1');

  // Capper comparison has everything the loose description of C has (userId,
  // ORDER BY gameTime, no bound, no LIMIT) - the capperId predicate keeps it out.
  const cmp = describeStatement(fixture("capper comparison"));
  expect("capper comparison: userId, ORDER BY gameTime, no bound, no LIMIT", [/"userId" = /.test(cmp.where), /ORDER BY "picks"\."gameTime"/.test(cmp.text), cmp.hasGameTimeBound, cmp.hasLimit], [true, true, false, false]);
  expect("... and still not retired shape C", flagCodes(fixture("capper comparison")).includes("RETIRED_C"), false);

  // Each retired shape stops matching once it gets a date bound or (for C) a LIMIT.
  const bounded = (sql: string) => sql.replace(/\) OFFSET \$(\d+)$/, ` AND "public"."picks"."gameTime" >= $99) OFFSET $$$1`);
  expect("A with a gameTime bound is not A", flagCodes(bounded(fixture("retired A"))).includes("RETIRED_A"), false);
  expect("B with a gameTime bound is not B", flagCodes(fixture("retired B").replace('("j1"."id" IS NOT NULL)', '("j1"."id" IS NOT NULL) AND "public"."picks"."gameTime" >= $9')).includes("RETIRED_B"), false);
  expect("C with a LIMIT is not C", flagCodes(fixture("retired C").replace(/OFFSET \$2$/, "LIMIT $2 OFFSET $3")).includes("RETIRED_C"), false);
  expect("C with a gameTime bound is not C", flagCodes(fixture("retired C").replace('WHERE "public"."picks"."userId" = $1', 'WHERE ("public"."picks"."userId" = $1 AND "public"."picks"."gameTime" >= $3)')).includes("RETIRED_C"), false);
}

// ---- 3. FROM-onward text ----
{
  const full = describeStatement(fixture("/picks date range"));
  expect("a plain SELECT is shown from its FROM", full.tail.startsWith('FROM "picks" WHERE ("picks"."userId" = $1'), true);
  expect("... with no SELECT list left in it", /"picks"\."homeTeam",/.test(full.tail), false);
  expect("... and ORDER BY / OFFSET kept", full.tail.endsWith('ORDER BY "picks"."gameTime" DESC OFFSET $4'), true);
  const nested = describeStatement('SELECT extract(epoch FROM p."createdAt") AS e, (SELECT 1 FROM sports) AS x FROM picks p WHERE p."userId" = $1 LIMIT $2');
  expect("a FROM inside parentheses is not the statement's FROM", nested.tail, 'FROM picks p WHERE p."userId" = $1 LIMIT $2');
  expect("... and LIMIT is found at the top level", [nested.hasLimit, nested.primaryTable], [true, "picks"]);
  const sub = describeStatement(fixture("grading pending count()"));
  expect("count() subquery: FROM (subquery) shown whole from FROM", sub.tail.startsWith('FROM (SELECT "picks"."id" FROM "picks" WHERE'), true);
  const cte = describeStatement(fixture("record bundle"));
  expect("a WITH statement is shown whole", cte.tail.startsWith("WITH base AS MATERIALIZED ( SELECT"), true);
  expect("SQL comments are dropped before the text goes on one line", [/--/.test(cte.text), /AND p\."capperId" = ANY\(\$2::text\[\]\)/.test(cte.text)], [false, true]);
  expect('the "public". prefix is dropped', /"public"\./.test(describeStatement(fixture("retired B")).tail), false);
}

// ---- 4. Row threshold, parsing ----
{
  const sql = fixture("capper comparison");
  expect("avg exactly at the threshold is not flagged", flagCodes(sql, 500, 500), []);
  expect("avg over the threshold is flagged", flagCodes(sql, 500.5, 500), ["ROW_THRESHOLD"]);
  expect("threshold is configurable", flagCodes(sql, 120, 100), ["ROW_THRESHOLD"]);
  expect("the default threshold comes from admin-thresholds.ts", DEFAULT_ROW_THRESHOLD, DB_ROW_THRESHOLD_DEFAULT);
  expect("parseRowThreshold",[parseRowThreshold(undefined), parseRowThreshold("250"), parseRowThreshold(["40", "9"]), parseRowThreshold("0"), parseRowThreshold("-5"), parseRowThreshold("1.5"), parseRowThreshold("abc")], [500, 250, 40, 500, 500, 500, 500]);
}

// ---- 4b. Expected-heavy cron reads (rows 1, 5, 8 of the 2026-10-19 prod top 30, and the roster refresh) ----
{
  expect(
    "exactly the four daily full-history reads are expected-heavy, at the configured ceiling",
    STATEMENT_LABELS.filter((l) => l.expected).map((l) => [l.label, l.expected!.maxAvgRows, l.expected!.note]),
    [
      ["Odds for tendencies", EXPECTED_HEAVY_MAX_AVG_ROWS, EXPECTED_HEAVY_NOTE],
      ["Game observations (model)", EXPECTED_HEAVY_MAX_AVG_ROWS, EXPECTED_HEAVY_NOTE],
      ["Decay-delta persisted ids", EXPECTED_HEAVY_MAX_AVG_ROWS, EXPECTED_HEAVY_NOTE],
      ["Roster refresh diff", EXPECTED_HEAVY_MAX_AVG_ROWS, EXPECTED_HEAVY_NOTE],
    ]
  );
  expect("ceiling 5,000, note as agreed", [EXPECTED_HEAVY_MAX_AVG_ROWS, EXPECTED_HEAVY_NOTE], [5000, "expected (daily cron, full history)"]);
  // Prod's averages that day: 1,647 / 1,514 / 1,250 rows per call.
  for (const [name, avg] of [["odds for tendencies", 1647], ["game observations", 1514], ["decay-delta persisted ids", 1250]] as const) {
    const sql = fixture(name);
    expect(`${name}: ${avg} avg rows is not flagged`, flagCodes(sql, avg), []);
    expect(`${name}: at the ceiling is not flagged`, flagCodes(sql, 5000), []);
    expect(`${name}: over the ceiling is flagged`, flagCodes(sql, 5000.5), ["ROW_THRESHOLD"]);
    expect(`${name}: ... and a lower ?threshold= doesn't apply to it`, flagCodes(asPgStatStatements(sql), 1000, 100), []);
  }
  expect("an ordinary label still uses the threshold", flagCodes(fixture("tendency game results"), 501), ["ROW_THRESHOLD"]);

  const view = buildMonitorView(
    {
      statsReset: null,
      dealloc: 0,
      totalRows: 0,
      statementCount: 3,
      top: [
        { queryid: "1", query: asPgStatStatements(fixture("odds for tendencies")), calls: 6, rows: 9881, totalExecMs: 1950 },
        { queryid: "2", query: fixture("game observations"), calls: 1, rows: 6000, totalExecMs: 9 },
        { queryid: "3", query: fixture("tendency game results"), calls: 6, rows: 2529, totalExecMs: 160 },
      ],
    },
    500,
    new Date()
  );
  expect("view: under the ceiling -> note, no flag; over -> flag, no note", view.rows.map((r) => [r.expected, r.flags.map((f) => f.code)]), [
    [EXPECTED_HEAVY_NOTE, []],
    [null, ["ROW_THRESHOLD"]],
    [null, []],
  ]);
  expect("view: only the over-ceiling row counts as flagged", view.flaggedCount, 1);
  const lines = formatClaudeReport(view).split("\n");
  expect("report: the expected note follows the label", lines.includes("1. Odds for tendencies [expected (daily cron, full history)] - calls 6, rows 9,881, avg 1,647 rows/call, exec 1,950 ms"), true);
  expect("report: over-ceiling reason", lines.includes("   [FLAG] Averages 6,000 rows/call, above its expected-read ceiling of 5,000"), true);
}

// ---- 5. Byte estimate ----
{
  expect("picks rows use the picks width", approxRowBytes(describeStatement(fixture("retired C"))), APPROX_ROW_BYTES.picks);
  expect("a WITH statement uses the first known table it reads", approxRowBytes(describeStatement(fixture("record bundle"))), APPROX_ROW_BYTES.picks);
  expect("an unknown table falls back to 200 bytes", approxRowBytes(describeStatement('SELECT "x"."a" FROM "public"."odds_alt_line_fetches" WHERE 1 = 1')), 200);
  expect("formatDuration", [formatDuration(42 * 60000), formatDuration((5 * 60 + 7) * 60000), formatDuration((3 * 24 + 4) * 3600000)], ["42m", "5h 7m", "3d 4h"]);
}

// ---- 6. View + "Copy for Claude" report ----
{
  const raw: RawSnapshot = {
    statsReset: new Date("2026-10-19T02:00:00Z"),
    dealloc: 0,
    totalRows: 1234567,
    statementCount: 812,
    top: [
      { queryid: "1", query: fixture("retired A"), calls: 40, rows: 120000, totalExecMs: 5321.4 },
      { queryid: "2", query: fixture("board window, #277"), calls: 900, rows: 27000, totalExecMs: 812.2 },
      { queryid: "3", query: fixture("capper comparison"), calls: 3, rows: 2400, totalExecMs: 90 },
    ],
  };
  const view = buildMonitorView(raw, 500, new Date("2026-10-19T05:30:00Z"));
  expect("view: avg rows, labels, flagged count", [view.rows.map((r) => r.avgRows), view.rows.map((r) => r.label), view.flaggedCount], [[3000, 30, 800], [null, "Board window", "Capper comparison"], 2]);
  expect("view: estimate = sum(rows x width)", view.estBytesTop, (120000 + 27000 + 2400) * APPROX_ROW_BYTES.picks);
  expect("view: time since reset", formatDuration(view.sinceResetMs ?? -1), "3h 30m");

  const report = formatClaudeReport(view);
  const lines = report.split("\n");
  expect("report: header lines", lines.slice(0, 3), [
    "DB Monitor report - pg_stat_statements, statements touching public tables, top 3 by rows",
    "Since last stats reset: 3h 30m (reset 2026-10-19 02:00 UTC)",
    "Total rows, all statements in this database: 1,234,567 (812 statements)",
  ]);
  expect("report: MB estimate is labelled an estimate", /^Estimated rows x approx row width, top 3: ~39\.2 MB \(ESTIMATE\)$/.test(lines[3]), true);
  expect("report: flagged statement line", lines.includes("1. [FLAG] Unlabeled - calls 40, rows 120,000, avg 3,000 rows/call, exec 5,321 ms"), true);
  expect("report: each flag reason on its own [FLAG] line", lines.filter((l) => l.startsWith("   [FLAG] ")).length, 3 + 1);
  expect("report: unflagged statement has no [FLAG]", lines.includes("2. Board window - calls 900, rows 27,000, avg 30 rows/call, exec 812 ms"), true);
  expect("report: full FROM/WHERE/ORDER text, not the SELECT list", [report.includes('   FROM "picks" WHERE ("picks"."userId" = $1 AND "picks"."sportId" = $2 AND "picks"."gameTime" >= $3 AND "picks"."gameTime" <= $4) ORDER BY "picks"."gameTime" ASC, "picks"."createdAt" ASC, "picks"."id" ASC OFFSET $5'), /SELECT "picks"\."id"/.test(report)], [true, false]);
  expect("report: no queryids", /\bqueryid\b/i.test(report), false);

  const evicted = formatClaudeReport(buildMonitorView({ ...raw, dealloc: 17 }, 500, new Date()));
  expect("report: evictions are called out", evicted.includes("Note: 17 statement entries were evicted since the reset, so totals undercount."), true);
}

// ---- 7. No user ids or parameter values ----
{
  const leaky = `SELECT "a" FROM "public"."users" WHERE "email" = 'someone@example.com' AND "id" = 'clx9k2m3n4p5q6r7s8t9u0v1' AND "supabaseId" = '3f2b8c1e-9d4a-4b6f-8e2a-1c3d5e7f9a0b' AND "n" = '12345678' AND "status" = 'WIN'`;
  const out = redactLiterals(describeStatement(leaky).tail);
  expect("emails, cuids, uuids and long numbers are masked", (out.match(/'<redacted>'/g) ?? []).length, 4);
  expect("... an enum literal is left alone", out.includes(`"status" = 'WIN'`), true);
  const view = buildMonitorView({ statsReset: null, dealloc: 0, totalRows: 1, statementCount: 1, top: [{ queryid: "9", query: leaky, calls: 1, rows: 1, totalExecMs: 1 }] }, 500, new Date());
  const report = formatClaudeReport(view);
  expect("report carries none of them", [/someone@example\.com|clx9k2m|3f2b8c1e|12345678/.test(report), report.includes("Since last stats reset: unknown")], [false, true]);
  const fixtureText = STATEMENT_FIXTURES.map((f) => f.sql).join("\n");
  expect("fixtures carry no seeded ids or emails", /dbmon-|@/.test(fixtureText), false);
}

// ---- 8. Admin gate wiring (source-level) ----
{
  const root = join(__dirname, "..", "..");
  const src = (p: string) => readFileSync(join(root, p), "utf8");
  const walk = (dir: string): string[] =>
    readdirSync(join(root, dir)).flatMap((n) => (statSync(join(root, dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));

  const gate = src("src/server/admin-gate.ts");
  expect("gate: the direct, uncached flag check on admin_ops_console", [/isFeatureEnabledForUser\(ADMIN_OPS_CONSOLE_FLAG_KEY, user\.id\)/.test(gate), /getNavFeatureFlags|cachedByTag|unstable_cache/.test(gate)], [true, false]);

  const adminFiles = walk("src/app/(app)/admin").filter((f) => /(page|layout)\.tsx$/.test(f));
  expect("admin: layout + index + two tabs", adminFiles.length >= 4, true);
  for (const f of adminFiles) {
    const s = readFileSync(join(root, f), "utf8");
    expect(`${f.replace(/\\/g, "/")}: awaits requireAdminOpsPage, no other flag check`, [/await requireAdminOpsPage\(\)/.test(s), /isFeatureEnabledForUser|IMPORT_SKIPPED_LINES_FLAG_KEY/.test(s)], [true, false]);
  }

  const actions = src("src/server/actions/db-monitor.ts");
  const fns = actions.split(/(?=export async function )/).filter((p) => p.startsWith("export async function "));
  expect("admin actions: there is at least one", fns.length > 0, true);
  expect("admin actions: each one's first statement is await requireAdminOpsAction()", fns.map((f) => f.split("\n")[1]?.trim()), fns.map(() => "await requireAdminOpsAction();"));

  const data = src("src/server/data/db-monitor.ts");
  const load = data.slice(data.indexOf("export async function loadDbMonitorSnapshot"), data.indexOf("export async function resetPgStatStatements"));
  expect("monitor read: one statement, uncached", [(load.match(/\$queryRaw/g) ?? []).length, /cachedByTag|unstable_cache/.test(data)], [1, false]);
  const page = src("src/app/(app)/admin/db-monitor/page.tsx");
  expect("monitor page: no cache, no polling", /cachedByTag|unstable_cache|setInterval|revalidate =/.test(page), false);

  const migration = src("prisma/migrations/20261019120000_add_admin_ops_console_flag/migration.sql");
  expect("migration: flag seeded OFF, overrides for both admin emails", [/VALUES \('admin_ops_console', false/.test(migration), /'bishopdykes@gmail\.com'/.test(migration), /'xstavpac@gmail\.com'/.test(migration)], [true, true, true]);
}

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nAll DB Monitor checks passed.");
