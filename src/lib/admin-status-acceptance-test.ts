// Ops console red dots and the shared "Copy for Claude" format: the pure
// rules (admin-status.ts), the report formatter (admin-report.ts), and the
// wiring (cached summary read after the gate; dot with its reason on hover),
// checked at source level.
//
// Pure, no DB. Run with:
//   npx tsx src/lib/admin-status-acceptance-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkFailedAlert, dbMonitorAlert } from "@/lib/admin-status";
import { formatAdminReport, maskIdentifiers, shortId } from "@/lib/admin-report";
import { buildMonitorView, type RawSnapshot } from "@/lib/db-monitor";
import { STATEMENT_FIXTURES } from "@/lib/db-monitor-fixtures";
import { ADMIN_STATUS_CACHE_SECONDS, DB_ROW_THRESHOLD_DEFAULT } from "@/lib/admin-thresholds";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}
const fixture = (name: string) => STATEMENT_FIXTURES.find((f) => f.name.startsWith(name))!.sql;

// ---- 1. DB Monitor dot ----
{
  const snap = (top: RawSnapshot["top"]): RawSnapshot => ({ statsReset: null, dealloc: 0, totalRows: 0, statementCount: top.length, top });
  const view = (top: RawSnapshot["top"]) => buildMonitorView(snap(top), DB_ROW_THRESHOLD_DEFAULT, new Date());

  // The 2026-10-19 prod shape: three expected-heavy cron reads well over 500
  // avg rows, everything else small - no dot.
  const prodLike = view([
    { queryid: "1", query: fixture("odds for tendencies"), calls: 6, rows: 9881, totalExecMs: 1950 },
    { queryid: "2", query: fixture("game observations"), calls: 2, rows: 3028, totalExecMs: 8 },
    { queryid: "3", query: fixture("decay-delta persisted ids"), calls: 1, rows: 1250, totalExecMs: 21 },
    { queryid: "4", query: fixture("capper roster"), calls: 26, rows: 4810, totalExecMs: 37 },
  ]);
  expect("prod-like snapshot: expected-heavy reads under their ceiling -> no dot", dbMonitorAlert(prodLike), null);

  const flagged = view([
    { queryid: "1", query: fixture("tendency game results"), calls: 2, rows: 1400, totalExecMs: 9 },
    { queryid: "2", query: fixture("retired C"), calls: 1, rows: 10, totalExecMs: 1 },
  ]);
  expect(
    "flagged statements -> count plus the first one's label and reason",
    dbMonitorAlert(flagged),
    "2 flagged statements; first: Tendency game results - Averages 700 rows/call (threshold 500)"
  );
  expect(
    "one flagged statement reads singular",
    dbMonitorAlert(view([{ queryid: "1", query: fixture("retired A"), calls: 1, rows: 3, totalExecMs: 1 }]))?.startsWith("1 flagged statement; first: Unlabeled - Retired shape A"),
    true
  );
  expect("empty list -> no dot", dbMonitorAlert(view([])), null);
  expect("a thrown check -> a dot that says so", checkFailedAlert(new Error("first line\nconnection refused")), "Status check failed: connection refused");
}

// ---- 2. Report format ----
{
  const text = formatAdminReport({
    title: "Grading report - test",
    header: ["Pending: 3", "Stuck: 1"],
    sections: [
      {
        heading: "Stuck pending",
        items: [
          { title: "NFL MONEYLINE - Opm Home Hawks ML", flags: ["final 4h ago, still PENDING"], lines: ["pick " + shortId("clx9k2m3n4p5q6r7s8t9u0v1w"), "reason: player not found in box score"] },
          { title: "MLB TOTAL - Over 8.5" },
        ],
      },
      { heading: "Fuzzy graded, 14 days", items: [], empty: "none" },
    ],
  });
  expect("report: DB Monitor shape", text.split("\n"), [
    "Grading report - test",
    "Pending: 3",
    "Stuck: 1",
    "",
    "Stuck pending:",
    "1. [FLAG] NFL MONEYLINE - Opm Home Hawks ML",
    "   [FLAG] final 4h ago, still PENDING",
    "   pick …9u0v1w",
    "   reason: player not found in box score",
    "2. MLB TOTAL - Over 8.5",
    "",
    "Fuzzy graded, 14 days:",
    "   none",
  ]);
  expect("shortId keeps 6 characters", shortId("clx9k2m3n4p5q6r7s8t9u0v1w"), "…9u0v1w");
  expect(
    "maskIdentifiers: emails, cuids, uuids; bet text otherwise untouched",
    maskIdentifiers("Yankees -1.5 (+120) by someone@example.com id clx9k2m3n4p5q6r7s8t9u0v1w ref 3f2b8c1e-9d4a-4b6f-8e2a-1c3d5e7f9a0b 2u 12345678"),
    "Yankees -1.5 (+120) by <redacted> id <redacted> ref <redacted> 2u 12345678"
  );
  expect("... applied to the whole report", formatAdminReport({ title: "t", header: ["x@y.io"], sections: [] }), "t\n<redacted>");
}

// ---- 3. Wiring (source-level) ----
{
  const root = join(__dirname, "..", "..");
  const src = (p: string) => readFileSync(join(root, p), "utf8");

  const layout = src("src/app/(app)/admin/layout.tsx");
  const gateAt = layout.indexOf("await requireAdminOpsPage()");
  const statusAt = layout.indexOf("await getAdminStatus()");
  expect("layout: the status summary is read, after the gate", [gateAt >= 0, statusAt > gateAt], [true, true]);
  expect("layout: passes it to the tab row", /<AdminTabs alerts=\{alerts\} \/>/.test(layout), true);

  const status = src("src/server/data/admin-status.ts");
  expect(
    "summary: one cached entry under cacheKeys.adminStatus() for ADMIN_STATUS_CACHE_SECONDS",
    /cachedByTag\(cacheKeys\.adminStatus\(\), ADMIN_STATUS_CACHE_SECONDS, loadAdminStatus\)/.test(status),
    true
  );
  expect("summary: cache TTL is a few minutes", ADMIN_STATUS_CACHE_SECONDS >= 60 && ADMIN_STATUS_CACHE_SECONDS <= 300, true);
  expect("summary: each check is caught on its own", /catch \(err\) \{\s*return \[c\.tab, checkFailedAlert\(err\)\]/.test(status), true);
  expect("summary: the DB Monitor check judges at the default threshold", /buildMonitorView\(result\.snapshot, DB_ROW_THRESHOLD_DEFAULT,/.test(status), true);

  const tabs = src("src/components/admin/admin-tabs.tsx");
  expect("dot: hover shows the reason (title), screen readers get it too", [/title=\{alert\}/.test(tabs), /needs attention: \{alert\}/.test(tabs)], [true, true]);

  const dbPage = src("src/app/(app)/admin/db-monitor/page.tsx");
  expect("DB Monitor uses the shared Copy for Claude controls", /from "@\/components\/admin\/report-controls"/.test(dbPage), true);
}

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nAdmin status checks passed.");
