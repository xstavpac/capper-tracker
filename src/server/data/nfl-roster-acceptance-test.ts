// Proof for nfl-roster.ts's pure extraction + the 32-team id table, run with:
//   npx tsx src/server/data/nfl-roster-acceptance-test.ts
//
// Only extractRosterPlayers (pure) is tested against real, unmodified ESPN
// roster responses - same "test the pure extraction against a fixture, not
// the live fetch wrapper" convention as nfl-passer-rows-acceptance-test.ts.
// fetchNflTeamRoster/fetchNflLeagueRoster do a live network call and are
// deliberately left untested here, same as fetchNflPasserRows.
//
// Fixtures (__fixtures__/nfl-roster-kc.json, nfl-roster-den.json) are the
// real, complete ESPN responses from
//   GET site.api.espn.com/apis/site/v2/sports/football/nfl/teams/{kc,den}/roster
// captured live 2026-09-15 during the bulk-import roster investigation -
// the same two teams the original bug report's rejected lines belong to
// (Mahomes/Kelce/Rice -> Chiefs; Waddle/Sutton/Engram -> Broncos).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractRosterPlayers, NFL_ESPN_TEAM_IDS, type RosterPlayer } from "@/server/data/nfl-roster";
import { getAllNflTeamNames } from "@/server/data/nfl-team-stats";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}
function ok(label: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
}

const FIX = join(__dirname, "__fixtures__");
function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIX, name), "utf8"));
}
function find(rows: RosterPlayer[], name: string): RosterPlayer | undefined {
  return rows.find((r) => r.playerName === name);
}

console.log("\n########## extractRosterPlayers: Kansas City Chiefs ##########");
{
  const kc = extractRosterPlayers("Kansas City Chiefs", loadFixture("nfl-roster-kc.json"));
  ok("extracts a full-size roster (50+ players)", kc.length >= 50, kc.length);
  expect("Patrick Mahomes -> Kansas City Chiefs, correct espnPlayerId", find(kc, "Patrick Mahomes"), {
    playerName: "Patrick Mahomes",
    team: "Kansas City Chiefs",
    espnPlayerId: "3139477",
  });
  expect("Travis Kelce -> Kansas City Chiefs, correct espnPlayerId", find(kc, "Travis Kelce"), {
    playerName: "Travis Kelce",
    team: "Kansas City Chiefs",
    espnPlayerId: "15847",
  });
  expect("Rashee Rice -> Kansas City Chiefs, correct espnPlayerId", find(kc, "Rashee Rice"), {
    playerName: "Rashee Rice",
    team: "Kansas City Chiefs",
    espnPlayerId: "4428331",
  });
  expect(
    "Kenneth Walker III (real generational suffix) -> Kansas City Chiefs",
    find(kc, "Kenneth Walker III"),
    { playerName: "Kenneth Walker III", team: "Kansas City Chiefs", espnPlayerId: "4567048" }
  );
}

console.log("\n########## extractRosterPlayers: Denver Broncos ##########");
{
  const den = extractRosterPlayers("Denver Broncos", loadFixture("nfl-roster-den.json"));
  ok("extracts a full-size roster (50+ players)", den.length >= 50, den.length);
  expect("Jaylen Waddle -> Denver Broncos, correct espnPlayerId", find(den, "Jaylen Waddle"), {
    playerName: "Jaylen Waddle",
    team: "Denver Broncos",
    espnPlayerId: "4372016",
  });
  expect("Courtland Sutton -> Denver Broncos, correct espnPlayerId", find(den, "Courtland Sutton"), {
    playerName: "Courtland Sutton",
    team: "Denver Broncos",
    espnPlayerId: "3128429",
  });
  expect("Evan Engram -> Denver Broncos, correct espnPlayerId", find(den, "Evan Engram"), {
    playerName: "Evan Engram",
    team: "Denver Broncos",
    espnPlayerId: "3051876",
  });
}

console.log("\n########## extractRosterPlayers: defensive shapes ##########");
{
  expect("null response -> []", extractRosterPlayers("Test Team", null), []);
  expect("missing athletes field -> []", extractRosterPlayers("Test Team", {}), []);
  expect("athletes not an array -> []", extractRosterPlayers("Test Team", { athletes: "nope" }), []);
  expect(
    "an athlete with no displayName/id is skipped, not crashed on",
    extractRosterPlayers("Test Team", { athletes: [{ items: [{ id: "1" }, { displayName: "No Id" }] }] }),
    []
  );
}

console.log("\n########## NFL_ESPN_TEAM_IDS: 32-team table sanity ##########");
{
  expect("exactly 32 teams", NFL_ESPN_TEAM_IDS.length, 32);
  const ids = NFL_ESPN_TEAM_IDS.map(([id]) => id);
  ok("every espnTeamId is unique", new Set(ids).size === ids.length, ids.length);
  const names = NFL_ESPN_TEAM_IDS.map(([, name]) => name).sort();
  expect(
    "the 32 canonical names match nfl-team-stats.ts's getAllNflTeamNames() exactly (same spelling this app's GameResult rows use)",
    names,
    getAllNflTeamNames()
  );
  // The two teams whose ESPN abbreviation differs from nflverse's own
  // (confirmed live: LAR vs nflverse's LA, WSH vs nflverse's WAS) - proves
  // this table sidesteps that mismatch by keying on id, not abbreviation.
  ok(
    "Los Angeles Rams and Washington Commanders are both present by full name",
    names.includes("Los Angeles Rams") && names.includes("Washington Commanders")
  );
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures > 0) process.exit(1);
