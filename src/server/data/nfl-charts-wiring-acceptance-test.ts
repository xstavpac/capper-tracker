// Structural checks for the NFL Charts wiring: the variable catalog is
// cleanly split by sport, every NFL built-in resolves through a registered
// provider, the NFL team-stat column mapping is complete, and the NFL
// tendency ids reach the shared rate reader. Run with:
//   npx tsx src/server/data/nfl-charts-wiring-acceptance-test.ts
// No DB, no HTTP - pure catalog/mapping assertions.
//
// Exits non-zero if any assertion fails.
import { MODEL_VARIABLES, NFL_TEAM_STATS_API, INTERNAL_TENDENCIES } from "@/lib/model-builder";
import { getAllNflTeamNames } from "@/server/data/nfl-team-stats";
import { getAllMlbTeamNames } from "@/server/data/mlb-stats";
import { resolveNflTeamStatFromSnapshot } from "@/server/data/providers/nfl-team-stats-provider";
import { readRate } from "@/server/data/providers/tendency-provider";
import type { NflTeamStatSnapshot } from "@prisma/client";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = actual === expected;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} - expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  if (!pass) failures++;
}

const mlb = MODEL_VARIABLES.filter((v) => v.sport === "baseball_mlb");
const nfl = MODEL_VARIABLES.filter((v) => v.sport === "americanfootball_nfl");

// --- 1. catalog split ------------------------------------------------------

expect("every built-in has a sport", MODEL_VARIABLES.every((v) => v.sport === "baseball_mlb" || v.sport === "americanfootball_nfl"), true);
expect("MLB catalog non-empty", mlb.length > 0, true);
expect("NFL catalog non-empty", nfl.length > 0, true);
expect(
  "MLB and NFL variable ids are disjoint",
  mlb.some((m) => nfl.some((n) => n.id === m.id)),
  false
);
expect("all NFL variable ids are unique", new Set(nfl.map((v) => v.id)).size, nfl.length);

// --- 2. no permanently-null metrics leaked into the catalog --------------

const bannedFragments = ["third_down", "thirddown", "time_of_possession", "possession", "redzone", "red_zone"];
expect(
  "no NFL variable references third-down / time-of-possession / red-zone (all null in our source)",
  nfl.some((v) => bannedFragments.some((f) => v.id.toLowerCase().includes(f))),
  false
);

// --- 3. every NFL built-in resolves through a registered provider -------

const NFL_SOURCE_IDS = new Set([NFL_TEAM_STATS_API, INTERNAL_TENDENCIES]);
expect(
  "every NFL variable's sourceId is one we route (nfl_team_stats_api or internal_tendencies)",
  nfl.every((v) => NFL_SOURCE_IDS.has(v.sourceId)),
  true
);
expect(
  "NFL team_stats entries all use NFL_TEAM_STATS_API",
  nfl.filter((v) => v.category === "team_stats").every((v) => v.sourceId === NFL_TEAM_STATS_API),
  true
);
expect(
  "NFL team_tendencies entries all use INTERNAL_TENDENCIES",
  nfl.filter((v) => v.category === "team_tendencies").every((v) => v.sourceId === INTERNAL_TENDENCIES),
  true
);

// --- 4. resolveNflTeamStatFromSnapshot covers every nfl_team_stats id ---

const row: NflTeamStatSnapshot = {
  id: "x", gameId: "2025_01_KC_LAC", season: 2025, week: 1, gameType: "REG", gameDate: "2025-09-05",
  team: "Kansas City Chiefs", opponent: "Los Angeles Chargers", homeAway: "away", completed: true,
  points: 21, pointsAllowed: 27, totalYards: 347, totalYardsAllowed: 394, passingYards: 258,
  passingYardsAllowed: 318, rushingYards: 98, rushingYardsAllowed: 90, offensivePlays: 58, yardsPerPlay: 5.98,
  firstDowns: 17, thirdDownPct: null, thirdDownPctAllowed: null, timeOfPossessionSeconds: null,
  turnovers: 1, takeaways: 2, turnoverMargin: 1, sacks: 3, sacksAllowed: 2, sackYardsLost: 9,
  penalties: 10, penaltyYards: 71, passingEpa: 3.4, rushingEpa: 8.9, receivingEpa: 5.5, offensiveEpa: 12.3,
  sourceId: "nflverse", scope: "GLOBAL", createdAt: new Date(), updatedAt: new Date(),
};

for (const v of nfl.filter((x) => x.sourceId === NFL_TEAM_STATS_API)) {
  const resolved = resolveNflTeamStatFromSnapshot(row, v.id);
  const known = resolved !== null || v.id === "nfl_points" || v.id === "nfl_points_allowed";
  expect(`resolveNflTeamStatFromSnapshot maps "${v.id}" to a column`, known && resolved !== undefined, true);
}
// spot-check a few exact mappings + the semantics that are easy to get wrong
expect("nfl_points -> points", resolveNflTeamStatFromSnapshot(row, "nfl_points"), 21);
expect("nfl_points_allowed -> pointsAllowed", resolveNflTeamStatFromSnapshot(row, "nfl_points_allowed"), 27);
expect("nfl_sacks -> defensive sacks", resolveNflTeamStatFromSnapshot(row, "nfl_sacks"), 3);
expect("nfl_sacks_allowed -> sacksAllowed (not def sacks)", resolveNflTeamStatFromSnapshot(row, "nfl_sacks_allowed"), 2);
expect("nfl_turnover_margin -> turnoverMargin", resolveNflTeamStatFromSnapshot(row, "nfl_turnover_margin"), 1);
expect("nfl_offensive_epa -> offensiveEpa", resolveNflTeamStatFromSnapshot(row, "nfl_offensive_epa"), 12.3);
expect("unknown id -> null", resolveNflTeamStatFromSnapshot(row, "nfl_bogus"), null);
// null passthrough for a not-yet-final game
expect("nfl_points is null when the row's points is null", resolveNflTeamStatFromSnapshot({ ...row, points: null }, "nfl_points"), null);

// --- 5. NFL tendency ids reach readRate --------------------------------

const rates = { favWinPct: 0.6, favSampleSize: 30, dogWinPct: 0.4, dogSampleSize: 30, overRate: 0.55, underRate: 0.45, totalSampleSize: 40 };
expect("readRate('nfl_tendency_fav_win_pct')", readRate(rates, "nfl_tendency_fav_win_pct"), 0.6);
expect("readRate('nfl_tendency_dog_win_pct')", readRate(rates, "nfl_tendency_dog_win_pct"), 0.4);
expect("readRate('nfl_tendency_over_rate')", readRate(rates, "nfl_tendency_over_rate"), 0.55);
expect("readRate('nfl_tendency_under_rate')", readRate(rates, "nfl_tendency_under_rate"), 0.45);
expect("readRate still handles the MLB ids", readRate(rates, "tendency_fav_win_pct"), 0.6);

// --- 6. team catalogs ------------------------------------------------------

const nflTeams = getAllNflTeamNames();
expect("32 NFL teams", nflTeams.length, 32);
expect("NFL team list is sorted", JSON.stringify(nflTeams), JSON.stringify([...nflTeams].sort()));
expect("NFL teams are full 'City Nickname' form", nflTeams.includes("Kansas City Chiefs") && nflTeams.includes("Washington Commanders"), true);
expect("NFL and MLB team name lists don't overlap", getAllMlbTeamNames().some((m) => nflTeams.includes(m)), false);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
if (failures > 0) process.exit(1);
