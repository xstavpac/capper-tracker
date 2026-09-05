// Pure classification of what the odds-seeding / backfill crons actually did,
// so /api/cron/refresh-odds and /api/cron/backfill-odds can return a real
// ok/status/HTTP-code instead of a blanket { ok: true }. Kept dependency-free
// (no prisma, no fetch) so it runs under tsx in the acceptance test - the
// odds.ts module that produces these status strings imports the two enums
// FROM here rather than the other way around.
//
// Background: on the free Odds API tier the seed cron 401s for stretches of
// every month; the old routes still returned { ok: true }, so the Live/odds
// board going blank was invisible until someone noticed the UI. An "error"
// here returns HTTP 500 so a cron/uptime monitor trips; a softer "warning"
// stays HTTP 200 with ok:false in the body.

// One sport's outcome from getOddsForSportUncached / seedOddsSnapshot.
//   off_season  - not in season, not fetched (expected, healthy)
//   cached      - today's snapshot row already existed (healthy)
//   seeded      - fetched and wrote today's row (even if 0 games)
//   fetch_failed- the primary Odds API key errored, no row written
//   no_api_key  - ODDS_API_KEY not configured
export type OddsFetchStatus = "off_season" | "cached" | "no_api_key" | "fetch_failed" | "seeded";

// One sport's outcome from backfillOddsForSport. Most runs are
// `nothing_missing` for every sport - that is the healthy steady state.
//   no_base_row - today's seed snapshot doesn't exist yet (symptom of a
//                 failed/late seed when seen hours after the 8am cron)
//   all_started - every cached game has started, nothing left to add (healthy)
export type BackfillStatus =
  | "off_season"
  | "no_base_row"
  | "no_api_key"
  | "all_started"
  | "fetch_failed"
  | "nothing_missing"
  | "added";

export type CronRunVerdict = {
  ok: boolean;
  status: "ok" | "warning" | "error";
  httpStatus: 200 | 500;
};

const FETCH_FAILURE_STATUSES = new Set<OddsFetchStatus | BackfillStatus>(["fetch_failed", "no_api_key"]);

function verdict(status: "ok" | "warning" | "error"): CronRunVerdict {
  return { ok: status === "ok", status, httpStatus: status === "error" ? 500 : 200 };
}

// refresh-odds: a real Odds API failure on any sport is an error (HTTP 500 ->
// trips a monitor). Every in-season sport coming back with zero games and NO
// explicit failure is a "warning" - usually a stale/failed snapshot, just
// occasionally a genuinely gameless day, so it's ok:false but still HTTP 200.
export function classifyRefreshOddsRun(
  results: { status: OddsFetchStatus; games: number }[]
): CronRunVerdict {
  if (results.some((r) => FETCH_FAILURE_STATUSES.has(r.status))) return verdict("error");
  const inSeason = results.filter((r) => r.status !== "off_season");
  if (inSeason.length > 0 && inSeason.every((r) => r.games === 0)) return verdict("warning");
  return verdict("ok");
}

// backfill-odds: `nothing_missing` everywhere is the normal healthy outcome
// (the seed already got everything), so - unlike refresh-odds - an empty
// result is NOT a warning. Only a real fetch failure is an error.
// `no_base_row` for an in-season sport means today's seed never landed; this
// cron runs every 4h so it's the only thing that catches a seed that failed
// after the 8am window - surfaced as a warning.
export function classifyBackfillOddsRun(results: { status: BackfillStatus }[]): CronRunVerdict {
  if (results.some((r) => FETCH_FAILURE_STATUSES.has(r.status))) return verdict("error");
  if (results.some((r) => r.status === "no_base_row")) return verdict("warning");
  return verdict("ok");
}
