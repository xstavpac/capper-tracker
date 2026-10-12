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

//
// 2026-10: some names no folding can reconcile ("App State" vs "Appalachian
// State", "LA Clippers" vs "Los Angeles Clippers"). Those are whole-name alias
// rows scoped to one league (CROSS_SOURCE_TEAM_ALIASES), applied only when the
// caller passes that league's sport key - see the last sections below.

import { normalizeTeamName, teamNamesMatch, CROSS_SOURCE_TEAM_ALIASES } from "./team-name-match";

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

// ---- league-scoped aliases: the names folding can't reconcile ----
// Left: the score feed's spelling (ESPN). Right: The Odds API's. Both read off
// the real feeds on 2026-10-12.
{
  const NCAAF = "americanfootball_ncaaf";
  const NBA = "basketball_nba";
  const pairs: [string, string, string][] = [
    [NCAAF, "Sam Houston Bearkats", "Sam Houston State Bearkats"],
    [NCAAF, "App State Mountaineers", "Appalachian State Mountaineers"],
    [NCAAF, "Massachusetts Minutemen", "UMass Minutemen"],
    [NCAAF, "Louisiana Ragin' Cajuns", "Louisiana Ragin Cajuns"],
    [NCAAF, "Southern Miss Golden Eagles", "Southern Mississippi Golden Eagles"],
    [NCAAF, "Hawai'i Rainbow Warriors", "Hawaii Rainbow Warriors"],
    [NBA, "LA Clippers", "Los Angeles Clippers"],
  ];
  for (const [sportKey, scoreFeed, oddsApi] of pairs) {
    check(`${sportKey}: "${scoreFeed}" matches "${oddsApi}"`, teamNamesMatch(scoreFeed, oddsApi, sportKey), true);
    check(`${sportKey}: ...and the other way round`, teamNamesMatch(oddsApi, scoreFeed, sportKey), true);
    check(`"${scoreFeed}" vs "${oddsApi}" with no league: no match (aliases are opt-in)`, teamNamesMatch(scoreFeed, oddsApi), false);
    const otherLeague = sportKey === NCAAF ? NBA : NCAAF;
    check(`"${scoreFeed}" vs "${oddsApi}" under ${otherLeague}: no match (aliases are per league)`, teamNamesMatch(scoreFeed, oddsApi, otherLeague), false);
  }
  check(
    "the list above is the whole alias table",
    Object.entries(CROSS_SOURCE_TEAM_ALIASES).flatMap(([sportKey, rows]) => rows.map(([a, b]) => [sportKey, a, b])),
    pairs
  );

  // The folding still works when a league is passed, including for the NHL
  // pair that needs no alias row.
  check("Montréal/Montreal still matches with the NHL key", teamNamesMatch("Montréal Canadiens", "Montreal Canadiens", "icehockey_nhl"), true);
  check("St Louis/St. Louis still matches with the NHL key", teamNamesMatch("St Louis Blues", "St. Louis Blues", "icehockey_nhl"), true);
  check("San José/San Jose State matches with or without the key", [
    teamNamesMatch("San José State Spartans", "San Jose State Spartans", NCAAF),
    teamNamesMatch("San José State Spartans", "San Jose State Spartans"),
  ], [true, true]);
  check("an unknown league key is the same as none", teamNamesMatch("LA Clippers", "Los Angeles Clippers", "soccer_epl"), false);

  // ---- Louisiana is three schools: an alias must never reach across them ----
  const louisiana = ["Louisiana Ragin' Cajuns", "Louisiana Ragin Cajuns"];
  const tech = "Louisiana Tech Bulldogs";
  const monroe = "UL Monroe Warhawks";
  for (const ul of louisiana) {
    check(`"${ul}" does not match Louisiana Tech`, [teamNamesMatch(ul, tech, NCAAF), teamNamesMatch(tech, ul, NCAAF)], [false, false]);
    check(`"${ul}" does not match UL Monroe`, [teamNamesMatch(ul, monroe, NCAAF), teamNamesMatch(monroe, ul, NCAAF)], [false, false]);
  }
  check("Louisiana Tech does not match UL Monroe", teamNamesMatch(tech, monroe, NCAAF), false);
  check("Louisiana Tech matches itself", teamNamesMatch(tech, tech, NCAAF), true);
  check("bare 'Louisiana' is not an alias for anyone", [
    teamNamesMatch("Louisiana", "Louisiana Ragin Cajuns", NCAAF),
    teamNamesMatch("Louisiana", tech, NCAAF),
  ], [false, false]);

  // ---- other near-neighbours the alias rows sit next to ----
  check("Sam Houston does not match Houston", teamNamesMatch("Sam Houston Bearkats", "Houston Cougars", NCAAF), false);
  check("App State does not match Arizona State", teamNamesMatch("App State Mountaineers", "Arizona State Sun Devils", NCAAF), false);
  check("Southern Miss does not match Ole Miss", teamNamesMatch("Southern Miss Golden Eagles", "Ole Miss Rebels", NCAAF), false);
  check("Southern Miss does not match Mississippi State", teamNamesMatch("Southern Mississippi Golden Eagles", "Mississippi State Bulldogs", NCAAF), false);
  check("LA Clippers does not match Los Angeles Lakers", teamNamesMatch("LA Clippers", "Los Angeles Lakers", NBA), false);
  check("Los Angeles Clippers does not match Los Angeles Lakers", teamNamesMatch("Los Angeles Clippers", "Los Angeles Lakers", NBA), false);

  // No alias spelling may collide with another team's real name: every
  // spelling in a league's rows normalizes to something unique.
  for (const [sportKey, rows] of Object.entries(CROSS_SOURCE_TEAM_ALIASES)) {
    const spellings = rows.flat().map(normalizeTeamName);
    check(`${sportKey}: no spelling appears in two alias rows`, new Set(spellings).size, spellings.length);
  }
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
