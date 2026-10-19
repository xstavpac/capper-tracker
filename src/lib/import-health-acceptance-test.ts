// Imports tab (ops console): the ambiguity log's validation, the red dot, the
// Copy for Claude report, and the wiring - bulkImportPicksAction records one
// import run with its no-matched-game picks, the import form sends how each
// ambiguous name was settled, the dot rides in the combined status statement,
// and the Skipped Lines report's old URL redirects (gated) to its new one.
//
// Pure, no DB. Run with:
//   npx tsx src/lib/import-health-acceptance-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AMBIGUITY_METHODS, alertCounts, importsAlert, importsReport, sanitizeAmbiguityLog, type ImportsView } from "@/lib/import-health";
import type { ResolutionMethod } from "@/lib/ambiguous-hierarchy";
import { formatAdminReport } from "@/lib/admin-report";
import { IMPORT_ALERT_STAGES, IMPORT_LIST_LIMIT, IMPORT_LISTED_STAGES, IMPORT_WINDOW_HOURS } from "@/lib/admin-thresholds";
import { ADMIN_TABS } from "@/lib/admin-tabs";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}
const root = join(__dirname, "..", "..");
const src = (p: string) => readFileSync(join(root, p), "utf8");
const T = (iso: string) => new Date(iso);
const now = T("2026-10-19T20:00:00Z");

// ---- 1. Thresholds as agreed; methods match the hierarchy's ----
{
  expect("window 24h, list 30", [IMPORT_WINDOW_HOURS, IMPORT_LIST_LIMIT], [24, 30]);
  expect("dot stages", [...IMPORT_ALERT_STAGES], ["GAME_UNMATCHED", "PARSE_UNRESOLVED", "RECOVERY_UNRESOLVED"]);
  expect("listed-only stages", [...IMPORT_LISTED_STAGES], ["PARSE_SILENT", "PROP_UNSUPPORTED"]);
  // Compile-time: every hierarchy method is an accepted method and back.
  const all: ResolutionMethod[] = [...AMBIGUITY_METHODS];
  const back: (typeof AMBIGUITY_METHODS)[number][] = ["schedule", "season", "pick_context", "remembered", "user", "plausibility", "league_activity"] satisfies ResolutionMethod[];
  expect("ambiguity methods = ResolutionMethod", all.slice().sort(), back.slice().sort());
}

// ---- 2. sanitizeAmbiguityLog: the browser's log is untrusted ----
{
  expect("not an array -> empty", [sanitizeAmbiguityLog(undefined), sanitizeAmbiguityLog("x"), sanitizeAmbiguityLog({ key: "a" })], [[], [], []]);
  expect(
    "keeps well-formed entries only",
    sanitizeAmbiguityLog([
      { key: "cardinals", sport: "MLB", method: "schedule", count: 3 },
      { key: "giants", sport: "NFL", method: "user", count: 1 },
      { key: "jets", sport: "NFL", method: "guess", count: 1 }, // unknown method
      { key: "kings", sport: "NHL", method: "season", count: 0 }, // not positive
      { key: "kings", sport: "NHL", method: "season", count: 1.5 }, // not an integer
      { key: "   ", sport: "NHL", method: "season", count: 1 }, // blank key
      { key: 5, sport: "NHL", method: "season", count: 1 }, // not a string
      null,
      "cardinals",
    ]),
    [
      { key: "cardinals", sport: "MLB", method: "schedule", count: 3 },
      { key: "giants", sport: "NFL", method: "user", count: 1 },
    ]
  );
  const [clipped] = sanitizeAmbiguityLog([{ key: "k".repeat(200), sport: "s".repeat(200), method: "user", count: 99999, extra: "dropped" }]);
  expect("clipped: key 60, sport 40, count 10000, no extra fields", [clipped.key.length, clipped.sport.length, clipped.count, Object.keys(clipped)], [60, 40, 10000, ["key", "sport", "method", "count"]]);
  expect("capped at 100 entries", sanitizeAmbiguityLog(Array.from({ length: 150 }, () => ({ key: "a", sport: "MLB", method: "season", count: 1 }))).length, 100);
}

// ---- 3. The dot ----
{
  expect("none when clean", importsAlert({ failed: 0, fallback: 0 }, 24), null);
  expect("lines only, singular", importsAlert({ failed: 1, fallback: 0 }, 24), "1 unmatched or unreadable line in the last 24h");
  expect("both, plural", importsAlert({ failed: 3, fallback: 2 }, 24), "3 unmatched or unreadable lines, 2 picks imported with no matched game in the last 24h");
  expect("fallback alone, singular", importsAlert({ failed: 0, fallback: 1 }, 24), "1 pick imported with no matched game in the last 24h");
  expect(
    "alertCounts: alert stages only (listed / other stages never count)",
    alertCounts({
      byStage: [
        { stage: "GAME_UNMATCHED", count: 2 },
        { stage: "PARSE_SILENT", count: 9 },
        { stage: "PROP_UNSUPPORTED", count: 4 },
        { stage: "DUPLICATE_SKIPPED", count: 7 },
        { stage: "RECOVERY_UNRESOLVED", count: 1 },
      ],
      runs: { runs: 3, items: 40, inserted: 30, skipped: 10, fallback: 2, ambiguousAuto: 0, ambiguousAsked: 0 },
    }),
    { failed: 3, fallback: 2 }
  );
}

// ---- 4. Report ----
{
  const view: ImportsView = {
    now,
    windowHours: 24,
    byStage: [
      { stage: "PARSE_SILENT", count: 2 },
      { stage: "GAME_UNMATCHED", count: 1 },
    ],
    lines: [
      { id: "clx1", stage: "GAME_UNMATCHED", capperName: "Sharp Sam", rawText: "Larks ML -120", guessedSport: "MLB", reason: "No scheduled game matched", createdAt: T("2026-10-19T18:30:00Z") },
      { id: "clx2", stage: "PARSE_SILENT", capperName: "Sharp Sam", rawText: "Kings -1.5", guessedSport: null, reason: "Read as a capper header but looks like a pick", createdAt: T("2026-10-19T18:00:00Z") },
    ],
    runs: { runs: 2, items: 12, inserted: 9, skipped: 3, fallback: 1, ambiguousAuto: 3, ambiguousAsked: 1 },
    fallbackPicks: [{ pickId: "clx9k2m3n4p5q6r7s8t9u0v1w", sport: "KBO", betDetail: "Doosan Bears ML" }],
    ambiguity: [
      { key: "cardinals", sport: "MLB", method: "schedule", count: 3 },
      { key: "giants", sport: "NFL", method: "user", count: 1 },
    ],
  };
  const text = formatAdminReport(importsReport(view));
  const lines = text.split("\n");
  expect("report: title", lines[0], "Imports report - last 24h (import_runs + import_skipped_lines)");
  expect("report: totals header", lines.includes("As of 2026-10-19 20:00 UTC. Imports: 2, lines submitted 12, picks inserted 9, skipped 3."), true);
  expect("report: no-matched-game + ambiguity header", lines.includes("No matched game: 1 inserted with the import time as game time, 1 refused (GAME_UNMATCHED). Ambiguous team names: 3 settled automatically, 1 asked."), true);
  expect("report: fallback pick with bet text, short id", [text.includes("KBO - Doosan Bears ML"), text.includes("pick …9u0v1w")], [true, true]);
  expect("report: raw lines included; alert stage flagged, listed stage not", [text.includes("GAME_UNMATCHED - Larks ML -120"), text.includes("[FLAG] No scheduled game matched"), text.includes("PARSE_SILENT - Kings -1.5"), text.includes("[FLAG] Read as a capper header")], [true, true, true, false]);
  expect("report: ambiguity rows", [text.includes('"cardinals" -> MLB'), text.includes("settled by schedule, 3 picks"), text.includes("asked the user, 1 pick")], [true, true, true]);
  expect("report: no full pick id", text.includes("clx9k2m3n4p5q6r7s8t9u0v1w"), false);
  const empty = formatAdminReport(importsReport({ ...view, byStage: [], lines: [], fallbackPicks: [], ambiguity: [], runs: { runs: 0, items: 0, inserted: 0, skipped: 0, fallback: 0, ambiguousAuto: 0, ambiguousAsked: 0 } }));
  expect("report: empty window says so", [empty.includes("Skipped lines by stage: none."), empty.includes("none")], [true, true]);
}

// ---- 5. Wiring (source-level) ----
{
  const action = src("src/server/actions/bulk-picks.ts");
  const fn = action.slice(action.indexOf("export async function bulkImportPicksAction"), action.indexOf("// ---- MLP (moneyline parlay) import ----"));
  expect("action: takes the ambiguity log as its 3rd arg", /skippedDuplicates: SkippedDuplicateItem\[\] = \[\],[\s\S]*?ambiguity: unknown = \[\]\s*\n\): Promise<BulkImportResult>/.test(fn), true);
  expect("action: a fallback flag per queued row (no score source)", [/toInsert\.push\(\{[\s\S]*?\}\);\s*\n\s*fallback\.push\(!resolvable\);/.test(fn), (fn.match(/toInsert\.push\(/g) ?? []).length], [true, 1]);
  expect("action: fallback picks mapped through insertedIndexes -> created ids", /result\.insertedIndexes\.flatMap\(\(rowIndex, k\) =>\s*\n?\s*fallback\[rowIndex\] \? \[\{ pickId: result\.created\[k\]\.id/.test(fn), true);
  const record = fn.indexOf("await recordImportRun(");
  expect("action: one run recorded after the insert, before both success returns", [record > fn.indexOf("insertPicksDeduped(user.id, toInsert)"), record < fn.indexOf("if (!result.allowed) {\n    return"), (fn.match(/recordImportRun\(/g) ?? []).length], [true, true, 1]);
  expect("action: a refused import records 0 inserted", /const picksInserted = result\.allowed \? result\.created\.length : 0;/.test(fn), true);

  const runs = src("src/server/data/import-runs.ts");
  expect("record: validates the ambiguity log, best-effort", [/sanitizeAmbiguityLog\(input\.ambiguity\)/.test(runs), /catch \(err\)/.test(runs)], [true, true]);
  expect("page read: one statement", (runs.slice(runs.indexOf("export async function loadImportsView")).match(/\$queryRaw/g) ?? []).length, 1);

  const form = src("src/components/dashboard/bulk-import-form.tsx");
  expect("form: log reset from each parse's auto-resolution logs", /setAmbiguityLog\(outcome\.logs\.map\(\(l\) => \(\{ key: l\.ambiguousName, sport: l\.resolvedSport, method: l\.method, count: l\.pickCount \}\)\)\)/.test(form), true);
  expect("form: a user answer is appended", /setAmbiguityLog\(\(prev\) => \[\.\.\.prev, \{ key, sport: choice\.sport, method: "user", count: newlyResolved\.length \}\]\)/.test(form), true);
  expect("form: sent as the 3rd arg", /\}\)\),\s*\n\s*ambiguityLog\s*\n\s*\);/.test(form.slice(form.indexOf("await bulkImportPicksAction("))), true);
  expect("form: type-only import (no server code in the client bundle)", /import type \{ ImportAmbiguityEntry \} from "@\/lib\/import-health";/.test(form), true);

  const status = src("src/server/data/admin-status.ts");
  expect("red dot: imports check inside the combined statement", [/tab: "imports"/.test(status), /\$\{importsStatusSql\(now\)\} AS imports/.test(status)], [true, true]);

  expect("tab row: Imports last, Skipped Lines no longer a tab", [ADMIN_TABS.map((t) => t.key).at(-1), ADMIN_TABS.find((t) => t.key === "imports")?.href, ADMIN_TABS.some((t) => t.href.includes("skipped"))], ["imports", "/admin/imports", false]);

  const page = src("src/app/(app)/admin/imports/page.tsx");
  expect("page: gated, uncached, Copy for Claude, links to Skipped Lines", [/await requireAdminOpsPage\(\)/.test(page), /cachedByTag|unstable_cache/.test(page), /<CopyReportButton report=\{report\} \/>/.test(page), /href="\/admin\/imports\/skipped-lines"/.test(page)], [true, false, true, true]);

  const moved = src("src/app/(app)/admin/imports/skipped-lines/page.tsx");
  expect("skipped lines: moved under imports, still gated, same report", [/await requireAdminOpsPage\(\)/.test(moved), /getSkippedLineReport\(from, to\)/.test(moved)], [true, true]);
  const old = src("src/app/(app)/admin/import-skipped-lines/page.tsx");
  const gateAt = old.indexOf("await requireAdminOpsPage()");
  expect("old URL: gate first, then redirect keeping from/to", [gateAt > 0, old.indexOf("redirect(") > gateAt, /\["from", "to"\]/.test(old), /redirect\(`\/admin\/imports\/skipped-lines\$\{qs \? `\?\$\{qs\}` : ""\}`\)/.test(old)], [true, true, true, true]);
}

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nImport health checks passed.");
