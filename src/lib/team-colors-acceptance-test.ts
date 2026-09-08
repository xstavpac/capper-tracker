// Proof for lib/team-colors.ts - run with:
//   npx tsx src/lib/team-colors-acceptance-test.ts
//
// No test framework in this repo; this is a persisted pass/fail script.
//
// Focus is NCAAF_TEAM_COLORS, the large verified school -> primary-brand-color
// map added for the /live game-card pick-list section-header dots. The two
// things that must stay true over time:
//   1. every value is a well-formed #RRGGBB hex
//   2. the key set is EXACTLY the canonical school list in parse-catalog.ts
//      (NCAAF_CANONICAL_SUFFIX's distinct values) - no missing school, no
//      stray key. If parse-catalog gains/loses/renames an FBS school this
//      test fails until team-colors.ts is updated to match, so the two lists
//      can't silently drift apart.
// Plus a couple of getTeamColor wiring checks for every mapped league.

import { getTeamColor, NCAAF_TEAM_COLORS } from "./team-colors";
import { NCAAF_CANONICAL_SUFFIX } from "./parse-catalog";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}
function checkTrue(label: string, actual: boolean) {
  console.log(`${actual ? "PASS" : "FAIL"}: ${label}`);
  if (!actual) failures++;
}

const HEX = /^#[0-9A-F]{6}$/;

// ---------------------------------------------------------------------------
console.log("########## NCAAF_TEAM_COLORS: every value is a #RRGGBB hex ##########");
{
  const bad = Object.entries(NCAAF_TEAM_COLORS).filter(([, v]) => !HEX.test(v));
  check("no malformed hex values", bad, []);
  checkTrue("all uppercase (canonical form)", Object.values(NCAAF_TEAM_COLORS).every((v) => v === v.toUpperCase()));
}

// ---------------------------------------------------------------------------
console.log("\n########## NCAAF_TEAM_COLORS keys == NCAAF_SCHOOLS canonical set ##########");
{
  const canonical = new Set(Object.values(NCAAF_CANONICAL_SUFFIX));
  const mapKeys = new Set(Object.keys(NCAAF_TEAM_COLORS));

  const missing = [...canonical].filter((c) => !mapKeys.has(c)).sort();
  const stray = [...mapKeys].filter((k) => !canonical.has(k)).sort();

  check("no canonical school missing a color (no silent gaps)", missing, []);
  check("no color-map key that isn't a real canonical school", stray, []);
  check("school count matches exactly", mapKeys.size, canonical.size);
  // Sanity floor so a future refactor that guts either list is obvious.
  checkTrue("covers the full FBS field (>= 130 schools)", mapKeys.size >= 130);
}

// ---------------------------------------------------------------------------
console.log("\n########## getTeamColor wiring ##########");
{
  // NCAAF: resolves off the full canonical name (and a schedule string that
  // ends with it), never off a bare mascot that collides across schools.
  check("NCAAF: exact canonical", getTeamColor("americanfootball_ncaaf", "Alabama Crimson Tide"), "#9E1B32");
  check("NCAAF: schedule string ending in the canonical", getTeamColor("americanfootball_ncaaf", "#3 Ohio State Buckeyes"), "#BA0C2F");
  check("NCAAF: LSU (short-form key would collide) resolves via full name", getTeamColor("americanfootball_ncaaf", "LSU Tigers"), "#461D7C");
  check("NCAAF: bare colliding mascot does NOT resolve", getTeamColor("americanfootball_ncaaf", "Tigers"), null);
  check("NCAAF: unmapped/unknown -> null (gray fallback)", getTeamColor("americanfootball_ncaaf", "Some FCS Team"), null);

  // Every canonical school resolves through the public API.
  const unresolved = Object.values(NCAAF_CANONICAL_SUFFIX)
    .filter((c, i, a) => a.indexOf(c) === i)
    .filter((c) => getTeamColor("americanfootball_ncaaf", c) === null);
  check("every canonical school resolves via getTeamColor", unresolved, []);

  // Other leagues still work and are unaffected.
  check("MLB still resolves", getTeamColor("baseball_mlb", "St. Louis Cardinals"), "#C41E3A");
  check("NFL still resolves", getTeamColor("americanfootball_nfl", "Kansas City Chiefs"), "#E31837");
  check("NBA still resolves", getTeamColor("basketball_nba", "Boston Celtics"), "#007A33");
  check("still-unmapped league -> null", getTeamColor("icehockey_nhl", "Boston Bruins"), null);
  check("unknown sport key -> null", getTeamColor("cricket_ipl", "Whoever"), null);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
