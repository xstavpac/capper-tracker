// Proof for team-name-match.ts - run with:
//   npx tsx src/lib/team-name-match-acceptance-test.ts
//
// No test framework exists in this repo (see parse-catalog-acceptance-test.ts's
// header); this file console.logs PASS/FAIL and exits non-zero on any failure.
//
// The bug this guards: a score/schedule source (ESPN, MLB Stats API) and the
// odds source (The Odds API) disagree on a few team spellings, and every
// cross-source join compares full names. The two confirmed live during the
// NHL grading build are Montréal/Montreal and "St Louis"/"St. Louis" (and The
// Odds API is internally inconsistent - "St. Louis Cardinals" in its MLB feed,
// "St Louis Blues" in its NHL feed). normalizeTeamName must fold both away
// WITHOUT ever collapsing two genuinely different teams onto each other.

import { normalizeTeamName, teamNamesMatch } from "./team-name-match";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

// ---- the two confirmed cross-source divergences ----

check("Montréal (accented) matches Montreal (plain)", teamNamesMatch("Montréal Canadiens", "Montreal Canadiens"), true);
check("'St Louis Blues' matches 'St. Louis Blues'", teamNamesMatch("St Louis Blues", "St. Louis Blues"), true);
check("'St. Louis Cardinals' matches 'St Louis Cardinals'", teamNamesMatch("St. Louis Cardinals", "St Louis Cardinals"), true);

// ---- identical names: unchanged behaviour (=== would also be true) ----

check("identical name matches itself", teamNamesMatch("Winnipeg Jets", "Winnipeg Jets"), true);
check("identical name, different case still matches", teamNamesMatch("Boston Bruins", "boston bruins"), true);

// ---- must NOT create false matches between different teams ----

check("Boston Bruins != Boston Celtics", teamNamesMatch("Boston Bruins", "Boston Celtics"), false);
check("Boston Bruins != Boston Red Sox", teamNamesMatch("Boston Bruins", "Boston Red Sox"), false);
check("New York Rangers != New York Islanders", teamNamesMatch("New York Rangers", "New York Islanders"), false);
check("New York Rangers (NHL) != Texas Rangers (MLB)", teamNamesMatch("New York Rangers", "Texas Rangers"), false);
check("Los Angeles Kings != Sacramento Kings", teamNamesMatch("Los Angeles Kings", "Sacramento Kings"), false);
check("Carolina Panthers != Florida Panthers", teamNamesMatch("Carolina Panthers", "Florida Panthers"), false);
check("Utah Mammoth != Utah Jazz", teamNamesMatch("Utah Mammoth", "Utah Jazz"), false);
check("empty string only matches empty string", teamNamesMatch("", "Anaheim Ducks"), false);

// ---- normalizeTeamName output shape ----

check("normalizeTeamName folds é and lowercases", normalizeTeamName("Montréal Canadiens"), "montreal canadiens");
check("normalizeTeamName drops the period", normalizeTeamName("St. Louis Blues"), "st louis blues");
check("normalizeTeamName collapses whitespace and trims", normalizeTeamName("  Tampa   Bay  Lightning  "), "tampa bay lightning");
check("normalizeTeamName leaves an already-clean name alone", normalizeTeamName("Seattle Kraken"), "seattle kraken");

// ---- every current NHL team name round-trips distinctly (no two collide) ----
// The Odds API spellings (accented Montréal, period-less St Louis) on the left;
// each must normalize to something unique across the whole league.
{
  const oddsApiNhlNames = [
    "Anaheim Ducks", "Boston Bruins", "Buffalo Sabres", "Calgary Flames", "Carolina Hurricanes",
    "Chicago Blackhawks", "Colorado Avalanche", "Columbus Blue Jackets", "Dallas Stars", "Detroit Red Wings",
    "Edmonton Oilers", "Florida Panthers", "Los Angeles Kings", "Minnesota Wild", "Montréal Canadiens",
    "Nashville Predators", "New Jersey Devils", "New York Islanders", "New York Rangers", "Ottawa Senators",
    "Philadelphia Flyers", "Pittsburgh Penguins", "San Jose Sharks", "Seattle Kraken", "St Louis Blues",
    "Tampa Bay Lightning", "Toronto Maple Leafs", "Utah Mammoth", "Vancouver Canucks", "Vegas Golden Knights",
    "Washington Capitals", "Winnipeg Jets",
  ];
  const normalized = oddsApiNhlNames.map(normalizeTeamName);
  check("all 32 NHL names normalize to distinct strings", new Set(normalized).size, 32);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
