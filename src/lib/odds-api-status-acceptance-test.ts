// Odds API tab (ops console): credit and snapshot-staleness rules, the red
// dot, the Copy for Claude report, and the wiring - every usage-log write now
// records its HTTP status and caller, the status read rides in the one
// combined statement, and nothing reads the snapshot blob.
//
// Pure, no DB. Run with:
//   npx tsx src/lib/odds-api-status-acceptance-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  creditPct,
  creditsProblem,
  seedDueAt,
  snapshotHealth,
  staleProblem,
  oddsApiAlert,
  oddsApiReport,
  type LatestUsage,
  type LatestSnapshot,
} from "@/lib/odds-api-status";
import { formatAdminReport } from "@/lib/admin-report";
import { ODDS_CREDITS_ALERT_PCT, ODDS_CREDITS_LOW_REMAINING, ODDS_SNAPSHOT_SEED_GRACE_HOURS } from "@/lib/admin-thresholds";
import { isSportInSeason } from "@/lib/sport-seasons";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}
const root = join(__dirname, "..", "..");
const src = (p: string) => readFileSync(join(root, p), "utf8");
const T = (iso: string) => new Date(iso);
const usage = (used: number | null, remaining: number | null): LatestUsage => ({
  sportKey: "baseball_mlb",
  pollTimestamp: T("2026-10-19T05:06:00Z"),
  creditsUsed: used,
  creditsRemaining: remaining,
  httpStatus: 200,
  caller: "odds-seed",
});

// ---- 1. Thresholds are the app's own ----
{
  expect("alert % = CREDIT_ALERT_THRESHOLD in odds-api-usage.ts", new RegExp(`export const CREDIT_ALERT_THRESHOLD = ${ODDS_CREDITS_ALERT_PCT};`).test(src("src/server/data/odds-api-usage.ts")), true);
  expect(
    "low-credit watermark = odds.ts's (same env var, same default)",
    [/Number\(process\.env\.ODDS_API_CREDITS_LOW_WATERMARK\) \|\| 1000/.test(src("src/server/data/odds.ts")), ODDS_CREDITS_LOW_REMAINING],
    [true, Number(process.env.ODDS_API_CREDITS_LOW_WATERMARK) || 1000]
  );
  expect("seed grace 2h", ODDS_SNAPSHOT_SEED_GRACE_HOURS, 2);
}

// ---- 2. Credits ----
{
  expect("pct", [creditPct(usage(850, 150)), creditPct(usage(null, 5)), creditPct(null)], [0.85, null, null]);
  expect("85% used -> flag", creditsProblem(usage(17000, 3000)), "Odds API credits 85% used (3000 left)");
  expect("84% used, 3,200 left -> fine", creditsProblem(usage(16800, 3200)), null);
  expect("under 1,000 left (20% used) -> low", creditsProblem(usage(200, 800)), "Odds API credits low: 800 left");
  expect("headers missing -> no flag", creditsProblem(usage(null, null)), null);
  expect("no calls logged -> no flag", creditsProblem(null), null);
}

// ---- 3. Snapshot staleness ----
{
  // EDT: ET midnight = 04:00Z; refresh-odds fires 05:05Z.
  expect("just after ET midnight, before today's seed fired: nothing due", seedDueAt(T("2026-10-19T04:30:00Z")), null);
  expect("after the 05:05 seed: due 07:05", seedDueAt(T("2026-10-19T06:00:00Z"))?.toISOString(), "2026-10-19T07:05:00.000Z");
  // EST: ET midnight = 05:00Z, still before the 05:05 fire.
  expect("EST: due 07:05 too", seedDueAt(T("2026-11-20T12:00:00Z"))?.toISOString(), "2026-11-20T07:05:00.000Z");

  const nfl = "americanfootball_nfl";
  const now = T("2026-10-19T08:00:00Z");
  expect("NFL is in season on 2026-10-19 (fixture premise)", isSportInSeason(nfl, now), true);
  const snap = (fetchDate: string, createdAt: string): LatestSnapshot => ({ sportKey: nfl, fetchDate, createdAt: T(createdAt) });

  const fresh = snapshotHealth([nfl], [snap("2026-10-19", "2026-10-19T05:05:40Z")], now);
  expect("today's row -> not stale, age from the seed", [fresh[0].stale, fresh[0].ageMs], [false, now.getTime() - T("2026-10-19T05:05:40Z").getTime()]);
  const old = snapshotHealth([nfl], [snap("2026-10-18", "2026-10-18T05:05:40Z")], now);
  expect("yesterday's row past 07:05 -> stale", old[0].stale, true);
  expect("yesterday's row at 06:30 (before due) -> not stale", snapshotHealth([nfl], [snap("2026-10-18", "2026-10-18T05:05:40Z")], T("2026-10-19T06:30:00Z"))[0].stale, false);
  expect("no rows at all past due -> stale, with nulls", snapshotHealth([nfl], [], now)[0], { sportKey: nfl, fetchDate: null, createdAt: null, ageMs: null, inSeason: true, stale: true });
  const offDate = T("2026-07-01T12:00:00Z");
  expect("NFL off season on 2026-07-01 -> never stale", [isSportInSeason(nfl, offDate), snapshotHealth([nfl], [], offDate)[0].stale], [false, false]);
  expect("stale reason names the sports and the due time", staleProblem(old, now), "americanfootball_nfl: no odds snapshot for 2026-10-19 (seed due 07:05 UTC)");

  expect("dot: healthy -> none", oddsApiAlert(usage(1000, 19000), fresh, now), null);
  expect("dot: both problems joined", oddsApiAlert(usage(19000, 1000), old, now), "Odds API credits 95% used (1000 left); americanfootball_nfl: no odds snapshot for 2026-10-19 (seed due 07:05 UTC)");

  const report = formatAdminReport(
    oddsApiReport({
      now,
      latest: usage(19000, 1000),
      callsToday: [
        { sportKey: "baseball_mlb", caller: "odds-seed", httpStatus: 200, calls: 1 },
        { sportKey: nfl, caller: "nfl-prop-odds", httpStatus: 200, calls: 4 },
        { sportKey: nfl, caller: "odds-seed", httpStatus: 401, calls: 1 },
      ],
      callsMonth: 120,
      snapshots: old,
    })
  ).split("\n");
  expect("report: header", report.slice(0, 5), [
    "Odds API report - odds_api_usage_log + odds_snapshots",
    "As of 2026-10-19 08:00 UTC (ET day 2026-10-19).",
    "Credits (x-requests-used / x-requests-remaining on the latest call, 2026-10-19 05:06 UTC): used 19000, remaining 1000 (95% used).",
    "Calls today: 6. Calls this month: 120.",
    "[FLAG] Odds API credits 95% used (1000 left)",
  ]);
  expect("report: an HTTP error is flagged under its sport", [report.includes("2. [FLAG] americanfootball_nfl - 5 calls"), report.includes("   [FLAG] 1 x HTTP 401 (odds-seed)")], [true, true]);
  expect("report: stale snapshot flagged with its last seed", [report.includes("1. [FLAG] americanfootball_nfl"), report.includes("   fetchDate 2026-10-18, seeded 2026-10-18 05:05 UTC (27h ago)")], [true, true]);
}

// ---- 4. Wiring (source-level) ----
{
  const sites = ["src/server/data/odds.ts", "src/server/data/alt-line-odds.ts", "src/server/data/fanduel-link.ts", "src/server/data/nfl-prop-odds.ts"];
  for (const p of sites) {
    const s = src(p);
    const calls = s.split("persistOddsApiUsage(").slice(1).map((c) => c.slice(0, c.indexOf("})")));
    expect(`${p}: every usage-log write records httpStatus and caller`, calls.length > 0 && calls.every((c) => /httpStatus/.test(c) && /caller/.test(c)), true);
  }
  expect("nfl + nhl event-prop targets each name their caller", [/caller: "nfl-prop-odds"/.test(src("src/server/data/nfl-prop-odds.ts")), /caller: "nhl-goal-scorer-odds"/.test(src("src/server/data/nhl-goal-scorer-odds.ts"))], [true, true]);
  expect("bulk listing: seed and backfill log under their own caller", [/"odds-seed"\);/.test(src("src/server/data/odds.ts")), /"odds-backfill"\);/.test(src("src/server/data/odds.ts"))], [true, true]);

  const reads = src("src/server/data/odds-api-status.ts");
  expect("reads never touch odds_snapshots.data", /\bdata\b/.test(reads.replace(/\/\/[^\n]*/g, "").replace(/^import .*$/gm, "")), false);
  const status = src("src/server/data/admin-status.ts");
  expect("red dot: odds check inside the combined statement", [/tab: "odds-api"/.test(status), /FROM \(\$\{LATEST_USAGE_SQL\}\) u\) AS "oddsLatest"/.test(status), /FROM \(\$\{LATEST_SNAPSHOTS_SQL\}\) s\) AS "oddsSnapshots"/.test(status)], [true, true, true]);
  const page = src("src/app/(app)/admin/odds-api/page.tsx");
  expect("page: gated, uncached, Copy for Claude", [/await requireAdminOpsPage\(\)/.test(page), /cachedByTag|unstable_cache/.test(page), /<CopyReportButton report=\{report\} \/>/.test(page)], [true, false, true]);
}

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nOdds API status checks passed.");
