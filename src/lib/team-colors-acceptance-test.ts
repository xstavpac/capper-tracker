// Proof for lib/team-colors.ts - run with:
//   npx tsx src/lib/team-colors-acceptance-test.ts
//
// No test framework in this repo; this is a persisted pass/fail script.
//
// Covers the verified primary-brand-color tables behind the /live game-card
// pick-list section-header dots. What must stay true over time:
//   1. every value is a well-formed #RRGGBB hex
//   2. NCAAF's key set is EXACTLY the canonical school list in parse-catalog.ts
//      (NCAAF_CANONICAL_SUFFIX's distinct values) - no missing school, no
//      stray key - so the two lists can't silently drift apart
//   3. NHL / WNBA cover their full leagues (WNBA minus the two 2026 expansion
//      teams whose brand hex values are not published yet)
// Plus getTeamColor wiring checks for every mapped league.

import { getTeamColor, NCAAF_TEAM_COLORS, NHL_TEAM_COLORS, WNBA_TEAM_COLORS } from "./team-colors";
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
console.log("########## every table value is a #RRGGBB hex ##########");
for (const [name, table] of [
  ["NCAAF", NCAAF_TEAM_COLORS],
  ["NHL", NHL_TEAM_COLORS],
  ["WNBA", WNBA_TEAM_COLORS],
] as const) {
  const bad = Object.entries(table).filter(([, v]) => !HEX.test(v));
  check(`${name}: no malformed hex values`, bad, []);
  checkTrue(`${name}: all uppercase (canonical form)`, Object.values(table).every((v) => v === v.toUpperCase()));
}

// ---------------------------------------------------------------------------
console.log("\n########## NHL / WNBA coverage ##########");
{
  // NHL: 32 franchises + the "coyotes" historical alias for the Utah team.
  check("NHL table has 33 keys (32 franchises + coyotes alias)", Object.keys(NHL_TEAM_COLORS).length, 33);
  checkTrue("NHL: coyotes and mammoth both present (same franchise, old + current name)", "coyotes" in NHL_TEAM_COLORS && "mammoth" in NHL_TEAM_COLORS);

  // WNBA: 15 teams in the 2026 league, minus Portland Fire ("fire") and
  // Toronto Tempo ("tempo"), whose brand hex values are not published yet.
  const wnbaKeys = new Set(Object.keys(WNBA_TEAM_COLORS));
  check("WNBA table has 13 keys (15 teams minus fire + tempo, pending)", wnbaKeys.size, 13);
  checkTrue("WNBA: fire + tempo intentionally absent (fall back to gray)", !wnbaKeys.has("fire") && !wnbaKeys.has("tempo"));
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

  // NHL / WNBA: bare nickname, suffix-matched against the schedule team name.
  check("NHL: Bruins primary is gold, not ESPN's near-black", getTeamColor("icehockey_nhl", "Boston Bruins"), "#FFB81C");
  check("NHL: two-word nickname", getTeamColor("icehockey_nhl", "Toronto Maple Leafs"), "#00205B");
  check("NHL: Utah Mammoth (current name)", getTeamColor("icehockey_nhl", "Utah Mammoth"), "#000000");
  check("NHL: unknown -> null", getTeamColor("icehockey_nhl", "Springfield Isotopes"), null);
  check("WNBA: New York Liberty seafoam", getTeamColor("basketball_wnba", "New York Liberty"), "#6ECEB2");
  check("WNBA: Portland Fire not mapped yet -> null (gray)", getTeamColor("basketball_wnba", "Portland Fire"), null);

  // Other leagues still work and are unaffected.
  check("MLB still resolves", getTeamColor("baseball_mlb", "St. Louis Cardinals"), "#C41E3A");
  check("NFL still resolves", getTeamColor("americanfootball_nfl", "Kansas City Chiefs"), "#E31837");
  check("NBA still resolves", getTeamColor("basketball_nba", "Boston Celtics"), "#007A33");
  check("unknown sport key -> null", getTeamColor("cricket_ipl", "Whoever"), null);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
