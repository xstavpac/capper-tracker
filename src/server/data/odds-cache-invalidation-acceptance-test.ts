// Proof for the three OddsSnapshot write-path invalidation predicates
// (odds.ts's oddsWriteInvalidatesCache/backfillWriteInvalidatesCache,
// nfl-prop-odds.ts's nflPropWriteInvalidatesCache) and for cacheKeys.odds's
// key shape. All pure and separated from revalidateTag itself specifically
// so they're provable without a Next.js request context (revalidateTag
// throws outside one; none of this needs it). See T1 (ticker caching fix)
// and its follow-up round (closing the backfill/NFL-prop-enrichment
// invalidation gaps + the dated cache key) - every one of the three
// OddsSnapshot write paths depends on its own predicate only ever being
// true for a real write, and on the cache key actually varying by both
// sport and Eastern fetch date. Run with:
//   npx tsx src/server/data/odds-cache-invalidation-acceptance-test.ts
import { oddsWriteInvalidatesCache, backfillWriteInvalidatesCache } from "./odds";
import { nflPropWriteInvalidatesCache } from "./nfl-prop-odds";
import { cacheKeys } from "@/lib/cache-keys";
import { LIVE_SPORTS } from "./odds";
import type { OddsFetchStatus, BackfillStatus } from "@/lib/odds-cron-status";
import type { NflPropSeedStatus } from "./nfl-prop-odds";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = actual === expected;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${expected}, got ${actual})`);
  if (!pass) failures++;
}

// --- seedOddsSnapshot's gate ---
// Every OddsFetchStatus value, named explicitly (not looped over an
// arbitrary list) so adding a new status to the type without updating this
// test is a visible gap, not a silent one.
const ODDS_FETCH_EXPECTED: Record<OddsFetchStatus, boolean> = {
  seeded: true, // a real OddsSnapshot row was just written - the only case that should invalidate
  cached: false, // read the existing row, wrote nothing
  off_season: false, // never touched the DB at all
  no_api_key: false, // never touched the DB at all
  fetch_failed: false, // upstream failure - deliberately NOT cached (see getOddsForSportUncached), nothing to invalidate
};
for (const [status, expected] of Object.entries(ODDS_FETCH_EXPECTED) as [OddsFetchStatus, boolean][]) {
  check(`oddsWriteInvalidatesCache("${status}")`, oddsWriteInvalidatesCache(status), expected);
}

// --- backfillOddsForSport's gate ---
const BACKFILL_EXPECTED: Record<BackfillStatus, boolean> = {
  added: true, // the only status where oddsSnapshot.update actually ran
  off_season: false,
  no_base_row: false,
  no_api_key: false,
  all_started: false,
  fetch_failed: false,
  nothing_missing: false,
};
for (const [status, expected] of Object.entries(BACKFILL_EXPECTED) as [BackfillStatus, boolean][]) {
  check(`backfillWriteInvalidatesCache("${status}")`, backfillWriteInvalidatesCache(status), expected);
}

// --- seedNflPropOddsForToday's gate ---
const NFL_PROP_EXPECTED: Record<NflPropSeedStatus, boolean> = {
  seeded: true, // the only status where oddsSnapshot.update actually ran
  no_api_key: false,
  no_snapshot: false,
  no_games_to_fetch: false,
};
for (const [status, expected] of Object.entries(NFL_PROP_EXPECTED) as [NflPropSeedStatus, boolean][]) {
  check(`nflPropWriteInvalidatesCache("${status}")`, nflPropWriteInvalidatesCache(status), expected);
}

// --- cacheKeys.odds: date rollover ---
// A different fetchDate for the same sport must produce a different key -
// this is what makes a day rollover "naturally age out" instead of relying
// on the TTL to notice the old day's entry is stale (see cacheKeys.odds's
// own comment).
check(
  "cacheKeys.odds varies by fetchDate for the same sport",
  cacheKeys.odds("baseball_mlb", "2026-09-15") === cacheKeys.odds("baseball_mlb", "2026-09-16"),
  false
);
check(
  "cacheKeys.odds is stable for the same (sport, date) pair",
  cacheKeys.odds("baseball_mlb", "2026-09-15") === cacheKeys.odds("baseball_mlb", "2026-09-15"),
  true
);

// --- cacheKeys.odds: separate sports never share an entry ---
// Every pair of LIVE_SPORTS keys, same date, must be distinct.
{
  const sameDate = "2026-09-15";
  const keys = LIVE_SPORTS.map((s) => cacheKeys.odds(s.key, sameDate));
  const unique = new Set(keys);
  check("every LIVE_SPORTS entry produces a distinct cache key on the same date", unique.size, keys.length);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
