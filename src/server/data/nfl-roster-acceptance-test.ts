// Proof for nfl-roster.ts's pure extraction + the 32-team id table, run with:
//   npx tsx src/server/data/nfl-roster-acceptance-test.ts
//
// Only extractRosterPlayers (pure) is tested against real, unmodified ESPN
// roster responses - same "test the pure extraction against a fixture, not
// the live fetch wrapper" convention as nfl-passer-rows-acceptance-test.ts.
// fetchNflTeamRoster/fetchNflLeagueRoster do a live network call and are
// deliberately left untested here, same as fetchNflPasserRows.
//
// Fixtures (__fixtures__/nfl-roster-kc.json, nfl-roster-den.json,
// nfl-roster-det.json) are the real, complete ESPN responses from
//   GET site.api.espn.com/apis/site/v2/sports/football/nfl/teams/{kc,den,det}/roster
// captured live 2026-09-15/16 during the bulk-import roster investigation -
// KC/DEN are the two teams the original full-name bug report's rejected
// lines belong to (Mahomes/Kelce/Rice -> Chiefs; Waddle/Sutton/Engram ->
// Broncos); DET was added for the follow-up bare-surname case ("Gibbs" ->
// Jahmyr Gibbs).
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
  ok("extracts only QB/RB/WR/TE (well under the ~75-player full roster)", kc.length > 0 && kc.length < 40, kc.length);
  ok("every extracted player is QB/RB/WR/TE", kc.every((p) => ["QB", "RB", "WR", "TE"].includes(p.position)));
  expect("Patrick Mahomes -> Kansas City Chiefs QB, correct espnPlayerId", find(kc, "Patrick Mahomes"), {
    playerName: "Patrick Mahomes",
    firstName: "Patrick",
    lastName: "Mahomes",
    team: "Kansas City Chiefs",
    position: "QB",
    espnPlayerId: "3139477",
  });
  expect("Travis Kelce -> Kansas City Chiefs TE, correct espnPlayerId", find(kc, "Travis Kelce"), {
    playerName: "Travis Kelce",
    firstName: "Travis",
    lastName: "Kelce",
    team: "Kansas City Chiefs",
    position: "TE",
    espnPlayerId: "15847",
  });
  expect("Rashee Rice -> Kansas City Chiefs WR, correct espnPlayerId", find(kc, "Rashee Rice"), {
    playerName: "Rashee Rice",
    firstName: "Rashee",
    lastName: "Rice",
    team: "Kansas City Chiefs",
    position: "WR",
    espnPlayerId: "4428331",
  });
  expect(
    "Kenneth Walker III (real generational suffix, including in ESPN's own lastName field) -> Kansas City Chiefs RB",
    find(kc, "Kenneth Walker III"),
    {
      playerName: "Kenneth Walker III",
      firstName: "Kenneth",
      lastName: "Walker III",
      team: "Kansas City Chiefs",
      position: "RB",
      espnPlayerId: "4567048",
    }
  );
}

console.log("\n########## extractRosterPlayers: Denver Broncos ##########");
{
  const den = extractRosterPlayers("Denver Broncos", loadFixture("nfl-roster-den.json"));
  ok("extracts only QB/RB/WR/TE (well under the ~75-player full roster)", den.length > 0 && den.length < 40, den.length);
  ok("every extracted player is QB/RB/WR/TE", den.every((p) => ["QB", "RB", "WR", "TE"].includes(p.position)));
  expect("Jaylen Waddle -> Denver Broncos WR, correct espnPlayerId", find(den, "Jaylen Waddle"), {
    playerName: "Jaylen Waddle",
    firstName: "Jaylen",
    lastName: "Waddle",
    team: "Denver Broncos",
    position: "WR",
    espnPlayerId: "4372016",
  });
  expect("Courtland Sutton -> Denver Broncos WR, correct espnPlayerId", find(den, "Courtland Sutton"), {
    playerName: "Courtland Sutton",
    firstName: "Courtland",
    lastName: "Sutton",
    team: "Denver Broncos",
    position: "WR",
    espnPlayerId: "3128429",
  });
  expect("Evan Engram -> Denver Broncos TE, correct espnPlayerId", find(den, "Evan Engram"), {
    playerName: "Evan Engram",
    firstName: "Evan",
    lastName: "Engram",
    team: "Denver Broncos",
    position: "TE",
    espnPlayerId: "3051876",
  });
}

console.log("\n########## extractRosterPlayers: Detroit Lions (bare-surname case) ##########");
{
  const det = extractRosterPlayers("Detroit Lions", loadFixture("nfl-roster-det.json"));
  ok("extracts only QB/RB/WR/TE (well under the ~78-player full roster)", det.length > 0 && det.length < 40, det.length);
  expect("Jahmyr Gibbs -> Detroit Lions RB, correct espnPlayerId", find(det, "Jahmyr Gibbs"), {
    playerName: "Jahmyr Gibbs",
    firstName: "Jahmyr",
    lastName: "Gibbs",
    team: "Detroit Lions",
    position: "RB",
    espnPlayerId: "4429795",
  });
}

console.log("\n########## extractRosterPlayers: defensive shapes ##########");
{
  expect("null response -> []", extractRosterPlayers("Test Team", null), []);
  expect("missing athletes field -> []", extractRosterPlayers("Test Team", {}), []);
  expect("athletes not an array -> []", extractRosterPlayers("Test Team", { athletes: "nope" }), []);
  expect(
    "an athlete with no displayName/id/firstName/lastName/position is skipped, not crashed on",
    extractRosterPlayers("Test Team", { athletes: [{ items: [{ id: "1" }, { displayName: "No Id" }] }] }),
    []
  );
  expect(
    "an athlete outside QB/RB/WR/TE (e.g. a linebacker) is excluded",
    extractRosterPlayers("Test Team", {
      athletes: [
        {
          items: [
            { id: "1", displayName: "Some LB", firstName: "Some", lastName: "LB", position: { abbreviation: "LB" } },
          ],
        },
      ],
    }),
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
