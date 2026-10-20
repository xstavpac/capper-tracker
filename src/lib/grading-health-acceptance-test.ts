// Grading tab (ops console): the stuck-pending wording and red dot, the Copy
// for Claude report, and the wiring - gradePickPool records every miss with
// its reason, the stuck predicate is limited to auto-graded sports inside the
// regrade lookback, and the red dot rides in the combined status statement.
//
// Pure, no DB. Run with:
//   npx tsx src/lib/grading-health-acceptance-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gradingAlert, gradingReport, stuckSince, type StuckPick } from "@/lib/grading-health";
import { formatAdminReport } from "@/lib/admin-report";
import { GRADING_FUZZY_WINDOW_DAYS, GRADING_STUCK_AFTER_FINAL_HOURS, GRADING_STUCK_LIST_LIMIT, GRADING_STUCK_NO_RESULT_HOURS } from "@/lib/admin-thresholds";

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

const stuck = (over: Partial<StuckPick>): StuckPick => ({
  id: "clx9k2m3n4p5q6r7s8t9u0v1w",
  sport: "MLB",
  betType: "PLAYER_PROP",
  period: "FULL_GAME",
  betDetail: "Aaron Judge over 1.5 total bases",
  homeTeam: "New York Yankees",
  awayTeam: "Boston Red Sox",
  gameTime: T("2026-10-19T11:00:00Z"),
  reason: "Aaron Judge not found in the MLB box score",
  finalSeenAt: T("2026-10-19T15:00:00Z"),
  lastSeenAt: T("2026-10-19T19:45:00Z"),
  attempts: 19,
  ...over,
});

// ---- 1. Thresholds as agreed ----
expect("stuck after 3h final / 8h no result, fuzzy 14 days, list 50", [GRADING_STUCK_AFTER_FINAL_HOURS, GRADING_STUCK_NO_RESULT_HOURS, GRADING_FUZZY_WINDOW_DAYS, GRADING_STUCK_LIST_LIMIT], [3, 8, 14, 50]);

// ---- 2. Wording and the dot ----
{
  expect("stuck since: the final", stuckSince(stuck({}), now), "final 5h ago");
  expect("stuck since: no final found", stuckSince(stuck({ finalSeenAt: null, gameTime: T("2026-10-19T10:00:00Z") }), now), "started 10h ago, no final found");
  expect("dot: none when nothing is stuck", gradingAlert(0, null, now), null);
  expect(
    "dot: count, the oldest pick, why, and its reason",
    gradingAlert(3, stuck({}), now),
    "3 stuck pending picks; oldest: MLB PLAYER_PROP - Aaron Judge over 1.5 total bases (final 5h ago) - Aaron Judge not found in the MLB box score"
  );
  expect("dot: one, a period, no reason recorded yet", gradingAlert(1, stuck({ betType: "TOTAL", period: "FIRST_HALF", betDetail: "F5 over 4.5", reason: null }), now), "1 stuck pending pick; oldest: MLB TOTAL FIRST_HALF - F5 over 4.5 (final 5h ago)");
}

// ---- 3. Report ----
{
  const lines = formatAdminReport(
    gradingReport({
      now,
      lookbackDays: 14,
      bySport: [
        { sport: "MLB", autoGraded: true, pending: 12, inLookback: 10, pastLookback: 2, stuck: 1 },
        { sport: "NCAAB", autoGraded: false, pending: 4, inLookback: 4, pastLookback: 0, stuck: 0 },
      ],
      stuckTotal: 1,
      stuck: [stuck({})],
      fuzzyGraded: 7,
    })
  ).split("\n");
  expect("report: header", lines.slice(0, 3), [
    "Grading report - pending picks, stuck pending, fuzzy-graded",
    "As of 2026-10-19 20:00 UTC. Stuck = PENDING in an auto-graded sport within the 14-day regrade lookback, and its game final 3h+ ago (or no final found 8h+ after it started).",
    "Pending: 16. Stuck: 1. Fuzzy-graded in the last 14 days: 7.",
  ]);
  expect("report: per sport, not-auto-graded marked", [lines.includes("1. [FLAG] MLB - 12 pending"), lines.includes("   [FLAG] 1 stuck"), lines.includes("2. NCAAB - 4 pending (not auto-graded)")], [true, true, true]);
  expect("report: stuck pick with bet text, short id, reason", [
    lines.includes("1. [FLAG] MLB PLAYER_PROP - Aaron Judge over 1.5 total bases"),
    lines.includes("   pick …9u0v1w: Boston Red Sox @ New York Yankees, game 2026-10-19 11:00 UTC"),
    lines.includes("   last grading failure: Aaron Judge not found in the MLB box score (19 attempts, last 2026-10-19 19:45 UTC)"),
  ], [true, true, true]);
  expect("report: no full pick id", lines.some((l) => l.includes("clx9k2m3n4p5q6r7s8t9u0v1w")), false);
}

// ---- 4. Wiring (source-level) ----
{
  const grading = src("src/server/data/grading.ts");
  const pool = grading.slice(grading.indexOf("export async function gradePickPool"), grading.indexOf("export async function regradeFuzzyPool"));
  expect("gradePickPool: a no-match is recorded", /failures\.push\(\{ pickId: pick\.id, reason: noMatchReason\(candidatesInPickWindow\(candidates, pick\)\)/.test(pool), true);
  expect("gradePickPool: props go through resolvePlayerProp for their reason", /await resolvePlayerProp\(pick, result\.game\.externalId, sportName\)/.test(pool), true);
  expect("gradePickPool: a matched-but-ungradeable miss keeps the game and its final time", [/gameResultId: result\.game\.id/.test(pool), /finalSeenAt: result\.game\.createdAt/.test(pool)], [true, true]);
  expect("gradePickPool: recorded once, after the chunks", /\}\);\s*\n\s*await recordGradeFailures\(failures\);\s*\n\s*return \{ graded, notMatched, changedUserIds \};/.test(pool), true);
  expect("candidate select carries id + createdAt", /CANDIDATE_GAME_RESULT_SELECT = \{[\s\S]*?id: true,\s*\n\s*createdAt: true,/.test(grading), true);

  const failuresSrc = src("src/server/data/grading-failures.ts");
  expect("failure writes: one upsert, joined to picks, best-effort", [/ON CONFLICT \("pickId"\) DO UPDATE/.test(failuresSrc), /JOIN picks p ON p\.id = t\.pick_id/.test(failuresSrc), /catch \(err\)/.test(failuresSrc)], [true, true, true]);

  const health = src("src/server/data/grading-health.ts");
  expect("stuck predicate: PENDING, auto-graded sports, inside the lookback", [/p\.status = 'PENDING'/.test(health), /s\.name = ANY\(\$\{AUTO_GRADED_SPORTS\}::text\[\]\)/.test(health), /p\."gameTime" >= \$\{ts\(c\.lookback\)\}/.test(health)], [true, true, true]);
  expect("stuck list: oldest first, capped", /ORDER BY p\."gameTime" ASC\s*\n\s*LIMIT \$\{GRADING_STUCK_LIST_LIMIT\}/.test(health), true);

  const status = src("src/server/data/admin-status.ts");
  expect("red dot: grading check inside the combined statement", [/tab: "grading"/.test(status), /\$\{grading\.count\} AS "stuckCount"/.test(status), /\$\{grading\.oldest\} AS "oldestStuck"/.test(status)], [true, true, true]);
  const page = src("src/app/(app)/admin/grading/page.tsx");
  expect("page: gated, uncached, Copy for Claude", [/await requireAdminOpsPage\(\)/.test(page), /cachedByTag|unstable_cache/.test(page), /<CopyReportButton report=\{report\} \/>/.test(page)], [true, false, true]);
}

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nGrading health checks passed.");
