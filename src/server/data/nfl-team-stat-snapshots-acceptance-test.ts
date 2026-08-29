// Correctness proof for the NFL team-stat ingestion transform in
// nfl-team-stat-snapshots.ts and the identity helpers in nfl-team-stats.ts,
// run with:
//   npx tsx src/server/data/nfl-team-stat-snapshots-acceptance-test.ts
// Not a general test suite (see grading-correctness-acceptance-test.ts for
// the same pattern - this repo has no test runner configured).
//
// Fixtures are tiny hand-built CSV strings, not live HTTP - two real-shaped
// games plus targeted edge cases (missing schedule row, missing opponent
// row, unmapped abbreviation, malformed cell, incomplete game, empty file).
// Real-data verification (does this join/derive sanely against the actual
// nflverse feed) was done separately during the NFL data-source
// investigation, not checked in here.
//
// Exits non-zero if any assertion fails.
import { buildNflTeamStatRows, type NflTeamStatRow } from "./nfl-team-stat-snapshots";
import { normalizeNflTeamName, currentNflSeason } from "./nfl-team-stats";

let failures = 0;

function expect(label: string, actual: unknown, expected: unknown) {
  const pass = actual === expected;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} - expected=${expected} actual=${actual}`);
  if (!pass) failures++;
}

// --- tiny CSV builder so fixtures stay readable -------------------------------

function csv(headers: string[], rows: Record<string, string | number>[]): string {
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => String(row[h] ?? "")).join(","));
  }
  return lines.join("\n");
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

const STAT_HEADERS = [
  "season", "week", "team", "season_type", "game_id", "opponent_team",
  "passing_yards", "rushing_yards", "sack_yards_lost", "attempts", "carries", "sacks_suffered",
  "passing_first_downs", "rushing_first_downs", "passing_interceptions", "fumbles_lost_total",
  "def_interceptions", "fumble_recovery_opp", "def_sacks", "penalties", "penalty_yards",
  "passing_epa", "rushing_epa", "receiving_epa",
];

const GAME_HEADERS = ["game_id", "season", "game_type", "week", "gameday", "home_team", "away_team", "home_score", "away_score"];

// KC @ LAC, game 1 - LAC wins 27-21. KC is the AWAY team.
const KC_G1 = {
  season: 2025, week: 1, team: "KC", season_type: "REG", game_id: "2025_01_KC_LAC", opponent_team: "LAC",
  passing_yards: 258, rushing_yards: 98, sack_yards_lost: -9, attempts: 39, carries: 17, sacks_suffered: 2,
  passing_first_downs: 9, rushing_first_downs: 8, passing_interceptions: 1, fumbles_lost_total: 0,
  def_interceptions: 0, fumble_recovery_opp: 1, def_sacks: 3, penalties: 10, penalty_yards: 71,
  passing_epa: 3.4, rushing_epa: 8.9, receiving_epa: 5.5,
};
const LAC_G1 = {
  season: 2025, week: 1, team: "LAC", season_type: "REG", game_id: "2025_01_KC_LAC", opponent_team: "KC",
  passing_yards: 318, rushing_yards: 90, sack_yards_lost: -14, attempts: 44, carries: 22, sacks_suffered: 2,
  passing_first_downs: 18, rushing_first_downs: 6, passing_interceptions: 0, fumbles_lost_total: 1,
  def_interceptions: 1, fumble_recovery_opp: 0, def_sacks: 2, penalties: 5, penalty_yards: 40,
  passing_epa: 6.0, rushing_epa: 2.0, receiving_epa: 6.1,
};
// PHI @ KC, game 2 - KC wins 20-17. KC is the HOME team.
const KC_G2 = {
  season: 2025, week: 2, team: "KC", season_type: "REG", game_id: "2025_02_PHI_KC", opponent_team: "PHI",
  passing_yards: 180, rushing_yards: 120, sack_yards_lost: -10, attempts: 30, carries: 28, sacks_suffered: 1,
  passing_first_downs: 10, rushing_first_downs: 7, passing_interceptions: 0, fumbles_lost_total: 1,
  def_interceptions: 2, fumble_recovery_opp: 1, def_sacks: 4, penalties: 6, penalty_yards: 45,
  passing_epa: -2.0, rushing_epa: 4.0, receiving_epa: -1.5,
};
const PHI_G2 = {
  season: 2025, week: 2, team: "PHI", season_type: "REG", game_id: "2025_02_PHI_KC", opponent_team: "KC",
  passing_yards: 240, rushing_yards: 80, sack_yards_lost: -28, attempts: 38, carries: 20, sacks_suffered: 4,
  passing_first_downs: 14, rushing_first_downs: 5, passing_interceptions: 2, fumbles_lost_total: 1,
  def_interceptions: 0, fumble_recovery_opp: 1, def_sacks: 1, penalties: 8, penalty_yards: 60,
  passing_epa: 1.0, rushing_epa: -3.0, receiving_epa: 0.5,
};

const GAMES = csv(GAME_HEADERS, [
  { game_id: "2025_01_KC_LAC", season: 2025, game_type: "REG", week: 1, gameday: "2025-09-05", home_team: "LAC", away_team: "KC", home_score: 27, away_score: 21 },
  { game_id: "2025_02_PHI_KC", season: 2025, game_type: "REG", week: 2, gameday: "2025-09-14", home_team: "KC", away_team: "PHI", home_score: 20, away_score: 17 },
]);

function only(rows: NflTeamStatRow[], team: string, gameId: string): NflTeamStatRow {
  const r = rows.find((x) => x.team === team && x.gameId === gameId);
  if (!r) throw new Error(`no row for ${team} / ${gameId}`);
  return r;
}

// --- 1. team abbreviation normalization -------------------------------------

expect("normalize KC", normalizeNflTeamName("KC"), "Kansas City Chiefs");
expect("normalize WAS (not ESPN's WSH)", normalizeNflTeamName("WAS"), "Washington Commanders");
expect("normalize LV", normalizeNflTeamName("LV"), "Las Vegas Raiders");
expect("normalize LA -> Rams (nflverse uses LA not LAR)", normalizeNflTeamName("LA"), "Los Angeles Rams");
expect("normalize lowercase input", normalizeNflTeamName("kc"), "Kansas City Chiefs");
expect("unknown abbreviation -> null", normalizeNflTeamName("ZZZ"), null);
expect("historical alias OAK is a deliberate KNOWN GAP -> null", normalizeNflTeamName("OAK"), null);

// --- 2. current NFL season -------------------------------------------------

expect("Aug 2026 -> 2026 season", currentNflSeason(new Date("2026-08-15T12:00:00Z")), 2026);
expect("Mar 2026 -> 2026 season (league year rolls in March)", currentNflSeason(new Date("2026-03-05T12:00:00Z")), 2026);
expect("Sep 2026 -> 2026 season", currentNflSeason(new Date("2026-09-10T12:00:00Z")), 2026);
expect("Jan 2027 playoff -> still 2026 season", currentNflSeason(new Date("2027-01-15T12:00:00Z")), 2026);
expect("Feb 2027 Super Bowl -> still 2026 season", currentNflSeason(new Date("2027-02-08T12:00:00Z")), 2026);

// --- 3. happy path: 2 games -> 4 rows, names normalized --------------------

const happy = buildNflTeamStatRows(csv(STAT_HEADERS, [KC_G1, LAC_G1, KC_G2, PHI_G2]), GAMES);
expect("happy path: 4 rows built", happy.rows.length, 4);
expect("happy path: 0 errors", happy.errors.length, 0);
expect("happy path: team name normalized", only(happy.rows, "Kansas City Chiefs", "2025_01_KC_LAC").team, "Kansas City Chiefs");
expect("happy path: opponent name normalized", only(happy.rows, "Kansas City Chiefs", "2025_01_KC_LAC").opponent, "Los Angeles Chargers");
expect("happy path: gameDate joined from games.csv", only(happy.rows, "Kansas City Chiefs", "2025_01_KC_LAC").gameDate, "2025-09-05");
expect("happy path: gameType joined from games.csv", only(happy.rows, "Kansas City Chiefs", "2025_01_KC_LAC").gameType, "REG");
expect("happy path: week from stats row", only(happy.rows, "Kansas City Chiefs", "2025_01_KC_LAC").week, 1);

// --- 4. home/away score mapping ------------------------------------------

const kcG1 = only(happy.rows, "Kansas City Chiefs", "2025_01_KC_LAC");
expect("G1: KC is away", kcG1.homeAway, "away");
expect("G1: KC points = away_score", kcG1.points, 21);
expect("G1: KC pointsAllowed = home_score", kcG1.pointsAllowed, 27);

const kcG2 = only(happy.rows, "Kansas City Chiefs", "2025_02_PHI_KC");
expect("G2: KC is home", kcG2.homeAway, "home");
expect("G2: KC points = home_score", kcG2.points, 20);
expect("G2: KC pointsAllowed = away_score", kcG2.pointsAllowed, 17);
expect("G2: completed flag", kcG2.completed, true);

// --- 5. opponent self-join for allowed-side stats ------------------------

expect("G1: KC passingYardsAllowed = LAC passing_yards", kcG1.passingYardsAllowed, 318);
expect("G1: KC rushingYardsAllowed = LAC rushing_yards", kcG1.rushingYardsAllowed, 90);
// LAC net total = 318 + 90 - |-14| = 394
expect("G1: KC totalYardsAllowed = LAC net total", kcG1.totalYardsAllowed, 394);

// --- 6. derived metrics -------------------------------------------------

// KC G1 net total = 258 + 98 - |-9| = 347
expect("G1: KC totalYards is NET", kcG1.totalYards, 347);
expect("G1: KC passingYards is the raw gross feed value", kcG1.passingYards, 258);
// plays = 39 + 17 + 2 = 58 ; ypp = 347 / 58 = 5.9827... -> round2
expect("G1: KC offensivePlays = att + carries + sacks_suffered", kcG1.offensivePlays, 58);
expect("G1: KC yardsPerPlay = round2(totalYards / plays)", kcG1.yardsPerPlay, 5.98);
expect("G1: KC firstDowns = passing + rushing 1st downs", kcG1.firstDowns, 17);
// giveaways = 1 INT + 0 fumbles lost = 1 ; takeaways = 0 def INT + 1 opp fumble rec = 1
expect("G1: KC turnovers (giveaways)", kcG1.turnovers, 1);
expect("G1: KC takeaways", kcG1.takeaways, 1);
expect("G1: KC turnoverMargin = takeaways - turnovers", kcG1.turnoverMargin, 0);
expect("G1: KC sacks = defensive sacks (def_sacks)", kcG1.sacks, 3);
expect("G1: KC sacksAllowed = sacks_suffered (NOT def_sacks)", kcG1.sacksAllowed, 2);
expect("G1: KC sackYardsLost is positive", kcG1.sackYardsLost, 9);
expect("G1: KC passingEpa from pre-summed feed field", kcG1.passingEpa, 3.4);
expect("G1: KC offensiveEpa = passingEpa + rushingEpa", round1(kcG1.offensiveEpa), 12.3);
// PHI G2 turnoverMargin: takeaways 0+1=1, giveaways 2+1=3 -> -2
expect("G2: PHI turnoverMargin can go negative", only(happy.rows, "Philadelphia Eagles", "2025_02_PHI_KC").turnoverMargin, -2);

// --- 7. third-down / possession-time are always null --------------------

expect("thirdDownPct always null (not in stats_team_week)", kcG1.thirdDownPct, null);
expect("thirdDownPctAllowed always null (not in stats_team_week)", kcG1.thirdDownPctAllowed, null);
expect("timeOfPossessionSeconds always null (not in stats_team_week)", kcG1.timeOfPossessionSeconds, null);

// --- 8. idempotency proxy: (team, gameId) is unique across output --------
// The DB upsert keys on (team, gameId); the transform must never emit two
// rows that would collide there, and must be deterministic across runs.

const rerun = buildNflTeamStatRows(csv(STAT_HEADERS, [KC_G1, LAC_G1, KC_G2, PHI_G2]), GAMES);
const keys = rerun.rows.map((r) => `${r.team}|${r.gameId}`);
expect("idempotency: no duplicate (team, gameId) keys", new Set(keys).size, keys.length);
expect("idempotency: rerun produces identical row count", rerun.rows.length, happy.rows.length);
expect(
  "idempotency: rerun produces identical values",
  JSON.stringify(rerun.rows),
  JSON.stringify(happy.rows)
);

// --- 9. missing schedule row -------------------------------------------

const noSched = buildNflTeamStatRows(
  csv(STAT_HEADERS, [{ ...KC_G1, game_id: "2025_09_KC_XXX" }]),
  GAMES
);
expect("missing schedule: no row for the orphaned game", noSched.rows.length, 0);
expect("missing schedule: 1 error", noSched.errors.length, 1);
expect("missing schedule: error kind", noSched.errors[0].kind, "missing_schedule");

// --- 10. missing opponent row ----------------------------------------

const noOpp = buildNflTeamStatRows(csv(STAT_HEADERS, [KC_G1]), GAMES); // KC row but no LAC row
expect("missing opponent: no KC row emitted", noOpp.rows.length, 0);
expect("missing opponent: error kind", noOpp.errors[0]?.kind, "missing_opponent");

// --- 11. unmapped team abbreviation ---------------------------------

const badTeam = buildNflTeamStatRows(
  csv(STAT_HEADERS, [{ ...KC_G1, team: "XYZ" }, { ...LAC_G1, opponent_team: "XYZ" }]),
  GAMES
);
expect("unmapped team: an unmapped_team error is raised", badTeam.errors.some((e) => e.kind === "unmapped_team"), true);
expect("unmapped team: both affected rows skipped", badTeam.rows.length, 0);

// --- 12. malformed row does not abort the run ----------------------
// A malformed cell in KC's G1 row skips KC's G1 row AND LAC's G1 row (LAC's
// allowed-side stats are read from KC's poisoned row - better to skip both
// than emit LAC with garbage "yards allowed"). The unrelated G2 rows are
// untouched: partial failure, not a full abort.

const malformed = buildNflTeamStatRows(
  csv(STAT_HEADERS, [{ ...KC_G1, passing_yards: "abc" }, LAC_G1, KC_G2, PHI_G2]),
  GAMES
);
expect("malformed: only the unaffected G2 rows survive", malformed.rows.length, 2);
expect("malformed: G2 rows are intact", malformed.rows.every((r) => r.gameId === "2025_02_PHI_KC"), true);
expect("malformed: KC's own row + LAC's opponent-join row both error", malformed.errors.length, 2);
expect("malformed: both errors are malformed_row", malformed.errors.every((e) => e.kind === "malformed_row"), true);

// --- 13. empty stats file is a clean no-op (preseason / pre-Week-1) -----

const empty = buildNflTeamStatRows("", GAMES);
expect("empty stats CSV: zero rows", empty.rows.length, 0);
expect("empty stats CSV: zero errors", empty.errors.length, 0);

const headerOnly = buildNflTeamStatRows(STAT_HEADERS.join(","), GAMES);
expect("header-only stats CSV: zero rows", headerOnly.rows.length, 0);
expect("header-only stats CSV: zero errors", headerOnly.errors.length, 0);

// --- 14. incomplete game: row built, but no score written -------------

const GAMES_WITH_UNPLAYED = csv(GAME_HEADERS, [
  { game_id: "2025_01_KC_LAC", season: 2025, game_type: "REG", week: 1, gameday: "2025-09-05", home_team: "LAC", away_team: "KC", home_score: "", away_score: "" },
]);
const unplayed = buildNflTeamStatRows(csv(STAT_HEADERS, [KC_G1, LAC_G1]), GAMES_WITH_UNPLAYED);
const kcUnplayed = only(unplayed.rows, "Kansas City Chiefs", "2025_01_KC_LAC");
expect("incomplete game: row is still built", unplayed.rows.length, 2);
expect("incomplete game: completed = false", kcUnplayed.completed, false);
expect("incomplete game: points not written", kcUnplayed.points, null);
expect("incomplete game: pointsAllowed not written", kcUnplayed.pointsAllowed, null);
expect("incomplete game: box-score stats still populated", kcUnplayed.passingYards, 258);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
if (failures > 0) process.exit(1);
