// Proof for sport-seasons' Odds API key selection - run with:
//   npx tsx src/lib/sport-seasons-acceptance-test.ts
//
// No test framework in this repo (see parse-catalog-acceptance-test.ts's
// header). console.logs PASS/FAIL, exits non-zero on any failure.
//
// Focus: oddsApiRequestKeys, and specifically the NFL preseason ->
// regular-season handoff. NFL preseason odds live under a separate Odds API
// key; the last preseason game is ~2026-08-29 but Week 1 is 2026-09-09, and
// for that ~10-day gap the preseason key is already empty while the regular
// key already carries Week 1 lines. The old date-only cutoff routed the whole
// gap to the empty preseason key (the "NFL odds board blank early September"
// bug). The fix queries BOTH keys for the whole pre-regular-season window and
// merges, so no SPORT_SEASON_CONFIG date has to line up exactly with the day
// preseason ends.
import { oddsApiRequestKeys, isSportInSeason, isPreseasonGame } from "./sport-seasons";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const d = (iso: string) => new Date(iso + "T16:00:00Z"); // mid-day UTC -> unambiguous Eastern date

const NFL = "americanfootball_nfl";
const NFL_PRE = "americanfootball_nfl_preseason";

// --- NFL: deep offseason, before the preseason window even opens ---
check("2026-07-01 (offseason): NFL -> regular key only", oddsApiRequestKeys(NFL, d("2026-07-01")), [NFL]);

// --- NFL: real preseason (games under the preseason key) ---
check("2026-08-15 (mid-preseason): NFL -> [regular, preseason] merged", oddsApiRequestKeys(NFL, d("2026-08-15")), [NFL, NFL_PRE]);
check("2026-08-06 (seasonStart, first day of window): both keys", oddsApiRequestKeys(NFL, d("2026-08-06")), [NFL, NFL_PRE]);

// --- NFL: THE BUG BOUNDARY - preseason games done (~Aug 29), Week 1 not yet
// (Sep 9). The regular key must be queried here or Week 1 lines are invisible. ---
check("2026-09-01 (gap: preseason done, Week 1 pending): both keys, so Week 1 lines ARE fetched", oddsApiRequestKeys(NFL, d("2026-09-01")), [NFL, NFL_PRE]);
check("2026-09-05 (the actual date the blank-board bug was caught): both keys", oddsApiRequestKeys(NFL, d("2026-09-05")), [NFL, NFL_PRE]);
check("2026-09-08 (day before Week 1): still both keys", oddsApiRequestKeys(NFL, d("2026-09-08")), [NFL, NFL_PRE]);

// --- NFL: regular season - preseason key no longer queried at all ---
check("2026-09-09 (regularSeasonStart, Week 1): regular key only", oddsApiRequestKeys(NFL, d("2026-09-09")), [NFL]);
check("2026-11-15 (mid-season): regular key only", oddsApiRequestKeys(NFL, d("2026-11-15")), [NFL]);
check("2027-01-20 (playoffs): regular key only", oddsApiRequestKeys(NFL, d("2027-01-20")), [NFL]);

// --- Element 0 is always the authoritative (regular-season / real) key ---
check("during the merge window, element 0 is the real sportKey (authoritative)", oddsApiRequestKeys(NFL, d("2026-09-05"))[0], NFL);

// --- Sports with no preseason-specific key are always a plain single element ---
for (const [key, date] of [
  ["baseball_mlb", "2026-07-01"],
  ["basketball_nba", "2026-11-01"],
  ["icehockey_nhl", "2026-11-01"],
  ["basketball_wnba", "2026-07-01"],
  ["americanfootball_ncaaf", "2026-09-05"],
] as [string, string][]) {
  check(`${key} on ${date}: single key, no preseason handling`, oddsApiRequestKeys(key, d(date)), [key]);
}

// An unknown sportKey is returned untouched as its own single element.
check("unknown sport key: passthrough", oddsApiRequestKeys("handball_bundesliga", d("2026-09-05")), ["handball_bundesliga"]);

// --- Sanity: the merge window sits entirely inside the season window, so
// isSportInSeason is true throughout it (getOddsForSportUncached gates on
// that before ever calling oddsApiRequestKeys). ---
check("NFL in season on 2026-09-05 (so the fetch path is actually reached)", isSportInSeason(NFL, d("2026-09-05")), true);

// --- isPreseasonGame: the NFL preseason window [seasonStart, regularSeasonStart) ---
check("NFL 2026-08-06 (seasonStart / first preseason day): preseason", isPreseasonGame(NFL, d("2026-08-06")), true);
check("NFL 2026-08-20 (mid-preseason): preseason", isPreseasonGame(NFL, d("2026-08-20")), true);
check("NFL 2026-09-08 (day before Week 1, still the gap): preseason", isPreseasonGame(NFL, d("2026-09-08")), true);
check("NFL 2026-09-09 (regularSeasonStart / Week 1): NOT preseason", isPreseasonGame(NFL, d("2026-09-09")), false);
check("NFL 2026-11-15 (mid regular season): NOT preseason", isPreseasonGame(NFL, d("2026-11-15")), false);
check("NFL 2027-01-20 (playoffs): NOT preseason", isPreseasonGame(NFL, d("2027-01-20")), false);
check("NFL 2026-07-01 (deep offseason, before the window opens): NOT preseason", isPreseasonGame(NFL, d("2026-07-01")), false);
check("NFL 2026-01-10 (LAST season's playoffs, well before this seasonStart): NOT preseason", isPreseasonGame(NFL, d("2026-01-10")), false);

// --- Every other sport has no preseason window configured -> always false,
//     even on a date that IS that sport's real-world preseason. ---
check("MLB 2026-03-18 (spring training): NOT flagged - MLB has no regularSeasonStart configured", isPreseasonGame("baseball_mlb", d("2026-03-18")), false);
check("NBA 2026-10-10 (NBA preseason): NOT flagged", isPreseasonGame("basketball_nba", d("2026-10-10")), false);
check("NHL 2026-09-25 (NHL preseason): NOT flagged", isPreseasonGame("icehockey_nhl", d("2026-09-25")), false);
check("WNBA 2026-05-05 (WNBA preseason): NOT flagged", isPreseasonGame("basketball_wnba", d("2026-05-05")), false);
check("NCAAF 2026-08-26 (has no preseason concept): NOT flagged", isPreseasonGame("americanfootball_ncaaf", d("2026-08-26")), false);
check("unknown sport: NOT flagged", isPreseasonGame("handball_bundesliga", d("2026-09-05")), false);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
