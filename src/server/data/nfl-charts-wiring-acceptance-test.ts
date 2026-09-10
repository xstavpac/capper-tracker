// Structural checks for the NFL Charts wiring: the variable catalog is
// cleanly split by sport, every NFL built-in resolves through a registered
// provider, the NFL team-stat column mapping is complete, and the NFL
// tendency ids reach the shared rate reader. Run with:
//   npx tsx src/server/data/nfl-charts-wiring-acceptance-test.ts
// No DB, no HTTP - pure catalog/mapping assertions.
//
// Exits non-zero if any assertion fails.
import {
  MODEL_VARIABLES,
  NFL_TEAM_STATS_API,
  NFL_TEAM_RECORD,
  NFL_SITUATIONAL,
  INTERNAL_TENDENCIES,
} from "@/lib/model-builder";
import { getAllNflTeamNames } from "@/server/data/nfl-team-stats";
import { getAllMlbTeamNames } from "@/server/data/mlb-stats";
import { resolveNflTeamStatFromSnapshot } from "@/server/data/providers/nfl-team-stats-provider";
import { resolveTeamRecordVariable, type TeamRecord } from "@/server/data/team-record";
import { SITUATIONAL_VARIABLE_QUESTION, situationalWinFraction } from "@/server/data/situational-snapshots";
import { NFL_SITUATIONAL_QUESTIONS } from "@/server/data/nfl-game-pulse-situations";
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

const NFL_SOURCE_IDS = new Set([NFL_TEAM_STATS_API, NFL_TEAM_RECORD, NFL_SITUATIONAL, INTERNAL_TENDENCIES]);
expect(
  "every NFL variable's sourceId is one historical-variables.ts registers a provider for",
  nfl.every((v) => NFL_SOURCE_IDS.has(v.sourceId)),
  true
);
// team_stats splits by source: nflverse box-score stats vs GameResult-derived
// record splits (win%, home/away/last-10, streak).
const nflRecordIds = new Set(["nfl_win_pct", "nfl_home_win_pct", "nfl_away_win_pct", "nfl_last10_win_pct", "nfl_streak"]);
expect(
  "NFL team_stats entries: record splits -> NFL_TEAM_RECORD, everything else -> NFL_TEAM_STATS_API",
  nfl
    .filter((v) => v.category === "team_stats")
    .every((v) => v.sourceId === (nflRecordIds.has(v.id) ? NFL_TEAM_RECORD : NFL_TEAM_STATS_API)),
  true
);
expect(
  "NFL team_tendencies entries: fav/dog/over/under -> INTERNAL_TENDENCIES, situational -> NFL_SITUATIONAL",
  nfl
    .filter((v) => v.category === "team_tendencies")
    .every((v) => v.sourceId === (v.id.startsWith("nfl_tendency_") ? INTERNAL_TENDENCIES : NFL_SITUATIONAL)),
  true
);
expect("all 5 record-split variables are in the catalog", nfl.filter((v) => nflRecordIds.has(v.id)).length, 5);
expect("all 6 situational-rate variables are in the catalog", nfl.filter((v) => v.sourceId === NFL_SITUATIONAL).length, 6);

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

// --- 4b. NFL record splits reach resolveTeamRecordVariable -------------

const record: TeamRecord = {
  wins: 7, losses: 2, ties: 1, winPct: 7 / 9,
  homeWins: 4, homeLosses: 1, awayWins: 3, awayLosses: 1,
  last10Wins: 6, last10Losses: 3, streakType: "W", streakCount: 3, gamesInRecord: 10,
};
expect("nfl_win_pct -> overall winPct (ties excluded)", resolveTeamRecordVariable(record, "nfl_win_pct"), 7 / 9);
expect("nfl_home_win_pct -> homeWins/(homeWins+homeLosses)", resolveTeamRecordVariable(record, "nfl_home_win_pct"), 4 / 5);
expect("nfl_away_win_pct -> awayWins/(awayWins+awayLosses)", resolveTeamRecordVariable(record, "nfl_away_win_pct"), 3 / 4);
expect("nfl_last10_win_pct -> last10Wins/(last10Wins+last10Losses)", resolveTeamRecordVariable(record, "nfl_last10_win_pct"), 6 / 9);
expect("nfl_streak -> +3 for a 3-game W streak", resolveTeamRecordVariable(record, "nfl_streak"), 3);
expect(
  "nfl_streak -> -2 for a 2-game L streak",
  resolveTeamRecordVariable({ ...record, streakType: "L", streakCount: 2 }, "nfl_streak"),
  -2
);
expect(
  "nfl_streak -> 0 when there is no streak (most recent game a tie)",
  resolveTeamRecordVariable({ ...record, streakType: null, streakCount: 0 }, "nfl_streak"),
  0
);
expect(
  "a split with no decided games -> null (chart gap), not 0",
  resolveTeamRecordVariable({ ...record, homeWins: 0, homeLosses: 0 }, "nfl_home_win_pct"),
  null
);
expect("unknown record variable id -> null", resolveTeamRecordVariable(record, "nfl_bogus"), null);
// every catalog record-split id must actually resolve
for (const v of nfl.filter((x) => x.sourceId === NFL_TEAM_RECORD)) {
  expect(`resolveTeamRecordVariable maps "${v.id}"`, resolveTeamRecordVariable(record, v.id) !== null, true);
}

// --- 4c. NFL situational variables map to real questions --------------

const questionKeys = new Set(NFL_SITUATIONAL_QUESTIONS.map((q) => q.key));
for (const v of nfl.filter((x) => x.sourceId === NFL_SITUATIONAL)) {
  const q = SITUATIONAL_VARIABLE_QUESTION[v.id];
  expect(`"${v.id}" maps to a real NFL_SITUATIONAL_QUESTIONS key`, !!q && questionKeys.has(q), true);
}
expect(
  "every situational question has a catalog variable pointing at it",
  NFL_SITUATIONAL_QUESTIONS.every((q) => Object.values(SITUATIONAL_VARIABLE_QUESTION).includes(q.key)),
  true
);
expect("nfl_trailed_at_half_win_pct -> the new trailedAtHalftime question", SITUATIONAL_VARIABLE_QUESTION["nfl_trailed_at_half_win_pct"], "trailedAtHalftime");
expect("situationalWinFraction is a 0..1 fraction (9/12)", situationalWinFraction(9, 12), 0.75);
expect("situationalWinFraction(0,0) -> null (chart gap)", situationalWinFraction(0, 0), null);

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
