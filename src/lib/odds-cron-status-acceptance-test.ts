// Proof for the odds-cron verdict classification - run with:
//   npx tsx src/lib/odds-cron-status-acceptance-test.ts
//
// No test framework in this repo (see parse-catalog-acceptance-test.ts's
// header). console.logs PASS/FAIL, exits non-zero on any failure.
//
// classifyRefreshOddsRun / classifyBackfillOddsRun decide the ok/status/HTTP
// code the seed + backfill cron routes return. The point of the whole change:
// a real Odds API failure must surface as HTTP 500 (trips a monitor) instead
// of the old blanket { ok: true } that hid the free-tier exhaustion outages.
import { classifyRefreshOddsRun, classifyBackfillOddsRun } from "./odds-cron-status";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

// ---------- refresh-odds (seed) ----------

check("refresh: every sport seeded with games -> ok / 200", classifyRefreshOddsRun([
  { status: "seeded", games: 15 },
  { status: "cached", games: 8 },
  { status: "off_season", games: 0 },
]), { ok: true, status: "ok", httpStatus: 200 });

check("refresh: one sport fetch_failed -> error / 500", classifyRefreshOddsRun([
  { status: "seeded", games: 15 },
  { status: "fetch_failed", games: 0 },
]), { ok: false, status: "error", httpStatus: 500 });

check("refresh: no_api_key -> error / 500", classifyRefreshOddsRun([
  { status: "no_api_key", games: 0 },
]), { ok: false, status: "error", httpStatus: 500 });

check("refresh: every IN-SEASON sport came back empty (no explicit failure) -> warning / 200, ok:false", classifyRefreshOddsRun([
  { status: "seeded", games: 0 },
  { status: "cached", games: 0 },
  { status: "off_season", games: 0 },
]), { ok: false, status: "warning", httpStatus: 200 });

check("refresh: at least one in-season sport HAS games -> ok (not all-empty)", classifyRefreshOddsRun([
  { status: "seeded", games: 0 },
  { status: "cached", games: 3 },
]), { ok: true, status: "ok", httpStatus: 200 });

check("refresh: deep offseason, nothing in season at all -> ok (no in-season sports to be empty)", classifyRefreshOddsRun([
  { status: "off_season", games: 0 },
  { status: "off_season", games: 0 },
]), { ok: true, status: "ok", httpStatus: 200 });

check("refresh: a real failure outranks the all-empty warning", classifyRefreshOddsRun([
  { status: "fetch_failed", games: 0 },
  { status: "seeded", games: 0 },
]), { ok: false, status: "error", httpStatus: 500 });

// ---------- backfill-odds ----------

check("backfill: every sport nothing_missing -> ok / 200 (the normal steady state, NOT a warning)", classifyBackfillOddsRun([
  { status: "nothing_missing" },
  { status: "nothing_missing" },
  { status: "off_season" },
]), { ok: true, status: "ok", httpStatus: 200 });

check("backfill: something was added -> ok", classifyBackfillOddsRun([
  { status: "added" },
  { status: "nothing_missing" },
]), { ok: true, status: "ok", httpStatus: 200 });

check("backfill: all_started everywhere -> ok", classifyBackfillOddsRun([
  { status: "all_started" },
  { status: "all_started" },
]), { ok: true, status: "ok", httpStatus: 200 });

check("backfill: fetch_failed -> error / 500", classifyBackfillOddsRun([
  { status: "nothing_missing" },
  { status: "fetch_failed" },
]), { ok: false, status: "error", httpStatus: 500 });

check("backfill: no_api_key -> error / 500", classifyBackfillOddsRun([
  { status: "no_api_key" },
]), { ok: false, status: "error", httpStatus: 500 });

check("backfill: no_base_row (today's seed never landed) -> warning / 200", classifyBackfillOddsRun([
  { status: "nothing_missing" },
  { status: "no_base_row" },
]), { ok: false, status: "warning", httpStatus: 200 });

check("backfill: fetch_failure outranks the missing-seed warning", classifyBackfillOddsRun([
  { status: "no_base_row" },
  { status: "fetch_failed" },
]), { ok: false, status: "error", httpStatus: 500 });

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
