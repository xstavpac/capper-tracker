// Proof for the daily roster refresh orchestration (refresh-rosters.ts) behind
// /api/cron/refresh-rosters - run with:
//   npx tsx src/server/data/refresh-rosters-acceptance-test.ts
//
// No database and no network: fetches are stubbed and the tables are spies.
//
//   PART A - all four leagues in season: each commits independently.
//   PART B - offseason skip (sport-seasons.ts windows).
//   PART C - one league failing (throws) or aborting (partial fetch) never stops the others.
//   PART D - the summary lines.
//   PART E - auth fails closed.
import type { RosterPlayer } from "./nfl-roster";
import type { ExistingRosterRow, RosterLeague, RosterLeagueConfig, RosterTable } from "./roster-load";
import { isAuthorizedCronRequest, refreshRosters, rosterRefreshSummary, type RosterRefreshOutcome } from "./refresh-rosters";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

const SPORT_KEYS: Record<RosterLeague, string> = { NFL: "americanfootball_nfl", NHL: "icehockey_nhl", NBA: "basketball_nba", MLB: "baseball_mlb" };
const TEAMS = ["T1", "T2", "T3"];

// A 3-team, 4-per-team league whose fetch the test controls.
function leagueConfig(league: RosterLeague, fetchRoster: () => Promise<RosterPlayer[]>): RosterLeagueConfig {
  return { league, sportKey: SPORT_KEYS[league], teams: TEAMS, minTeams: 3, minPlayers: 10, minPlayersPerTeam: 3, fetchRoster };
}
const roster = (league: RosterLeague, perTeam = 4): RosterPlayer[] =>
  TEAMS.flatMap((team) =>
    Array.from({ length: perTeam }, (_, i) => ({ playerName: `${league} ${team} P${i}`, firstName: league, lastName: `${team}P${i}`, team, position: "X", externalPlayerId: `${league}-${team}-${i}` }))
  );

function spyTables(existing: Partial<Record<RosterLeague, ExistingRosterRow[]>> = {}) {
  const writes: Record<string, number> = {};
  const reads: Record<string, number> = {};
  const tableFor = (league: RosterLeague): RosterTable => ({
    readForDiff: async () => ((reads[league] = (reads[league] ?? 0) + 1), existing[league] ?? []),
    createMany: async (rows) => void (writes[league] = (writes[league] ?? 0) + rows.length),
    updateRow: async () => void (writes[league] = (writes[league] ?? 0) + 1),
    deactivate: async (ids) => void (writes[league] = (writes[league] ?? 0) + ids.length),
  });
  return { tableFor, writes, reads };
}

const IN_SEASON_ALL = new Date("2026-10-15T10:45:00Z"); // NFL, NHL, NBA, MLB (World Series) all in window
const MLB_OFFSEASON = new Date("2027-01-10T10:45:00Z"); // MLB window ended 2026-11-05
const statuses = (o: RosterRefreshOutcome[]) => Object.fromEntries(o.map((x) => [x.league, x.status]));
const ALL: RosterLeague[] = ["NFL", "NHL", "NBA", "MLB"];

async function main() {
  console.log("########## PART A: all four in season ##########");
  {
    const { tableFor, writes } = spyTables();
    const out = await refreshRosters({ leagues: ALL.map((l) => leagueConfig(l, async () => roster(l))), tableFor, now: IN_SEASON_ALL });
    check("every league committed", statuses(out), { NFL: "committed", NHL: "committed", NBA: "committed", MLB: "committed" });
    check("each league wrote its own 12 rows to its own table", writes, { NFL: 12, NHL: 12, NBA: 12, MLB: 12 });
    check("rowsWritten reported per league", out.map((o) => ("rowsWritten" in o ? o.rowsWritten : -1)), [12, 12, 12, 12]);
  }

  console.log("\n########## PART B: offseason skip ##########");
  {
    const fetched: string[] = [];
    const { tableFor, reads } = spyTables();
    const out = await refreshRosters({
      leagues: ALL.map((l) => leagueConfig(l, async () => (fetched.push(l), roster(l)))),
      tableFor,
      now: MLB_OFFSEASON,
    });
    check("MLB skipped in January, the winter leagues ran", statuses(out), { NFL: "committed", NHL: "committed", NBA: "committed", MLB: "skipped-offseason" });
    check("a skipped league is neither fetched nor read", { fetched: fetched.sort(), mlbReads: reads.MLB ?? 0 }, { fetched: ["NBA", "NFL", "NHL"], mlbReads: 0 });
    const july = await refreshRosters({ leagues: ALL.map((l) => leagueConfig(l, async () => roster(l))), tableFor, now: new Date("2026-07-20T10:45:00Z") });
    check("late July: only MLB is in season", statuses(july), { NFL: "skipped-offseason", NHL: "skipped-offseason", NBA: "skipped-offseason", MLB: "committed" });
    // sport-seasons.ts holds one configured window per sport and fails closed
    // past it: until next season's dates are added there, every league skips.
    const unconfigured = await refreshRosters({ leagues: ALL.map((l) => leagueConfig(l, async () => roster(l))), tableFor, now: new Date("2027-07-20T10:45:00Z") });
    check("past every configured window: all four skip (fail closed)", statuses(unconfigured), { NFL: "skipped-offseason", NHL: "skipped-offseason", NBA: "skipped-offseason", MLB: "skipped-offseason" });
  }

  console.log("\n########## PART C: leagues are independent ##########");
  {
    const { tableFor, writes, reads } = spyTables();
    const out = await refreshRosters({
      leagues: [
        leagueConfig("NFL", async () => roster("NFL")),
        leagueConfig("NHL", async () => {
          throw new Error("ESPN is down");
        }),
        leagueConfig("NBA", async () => roster("NBA").filter((p) => p.team !== "T2")), // a team missing
        leagueConfig("MLB", async () => roster("MLB")),
      ],
      tableFor,
      now: IN_SEASON_ALL,
    });
    check("a throwing league fails, an aborting league aborts, the rest commit", statuses(out), { NFL: "committed", NHL: "failed", NBA: "aborted", MLB: "committed" });
    check("the failure carries its error", out.find((o) => o.league === "NHL")?.status === "failed" && (out.find((o) => o.league === "NHL") as { error: string }).error, "ESPN is down");
    check("the healthy leagues still wrote; the failed and aborted ones wrote nothing", { NFL: writes.NFL, NHL: writes.NHL ?? 0, NBA: writes.NBA ?? 0, MLB: writes.MLB }, { NFL: 12, NHL: 0, NBA: 0, MLB: 12 });
    check("the aborted league's table was not even read", reads.NBA ?? 0, 0);

    // A table write throwing mid-run is contained the same way.
    const broken = spyTables();
    const out2 = await refreshRosters({
      leagues: ALL.map((l) => leagueConfig(l, async () => roster(l))),
      tableFor: (l) => (l === "MLB" ? { ...broken.tableFor(l), createMany: async () => Promise.reject(new Error("connection reset")) } : broken.tableFor(l)),
      now: IN_SEASON_ALL,
    });
    check("a DB error in one league is contained to that league", statuses(out2), { NFL: "committed", NHL: "committed", NBA: "committed", MLB: "failed" });
  }

  console.log("\n########## PART D: summary lines ##########");
  {
    const existing = roster("NHL").map((p, i) => ({ id: "r" + i, externalId: p.externalPlayerId, fullName: p.playerName, firstName: p.firstName, lastName: p.lastName, team: p.team, position: p.position, active: true }));
    const { tableFor } = spyTables({ NHL: existing });
    const out = await refreshRosters({
      leagues: [
        leagueConfig("NFL", async () => roster("NFL").filter((p) => p.team !== "T3")),
        leagueConfig("NHL", async () => roster("NHL").filter((p) => p.externalPlayerId !== "NHL-T1-0")),
        leagueConfig("NBA", async () => {
          throw new Error("boom");
        }),
        leagueConfig("MLB", async () => roster("MLB")),
      ],
      tableFor,
      now: MLB_OFFSEASON,
    });
    const lines = out.map(rosterRefreshSummary).map((l) => l.replace(/\d+ms/, "Nms"));
    check("one line per league, in order", lines, [
      "[refresh-rosters] NFL aborted after Nms (nothing written): only 2/3 teams returned players - missing: T3",
      "[refresh-rosters] NHL committed in Nms: add 0, update 0, reactivate 0, leave 11 unchanged, deactivate 1, skip 0 deactivations (short teams: none); 1 rows written",
      "[refresh-rosters] NBA failed after Nms: boom",
      "[refresh-rosters] MLB skipped-offseason",
    ]);
  }

  console.log("\n########## PART E: auth fails closed ##########");
  {
    check("CRON_SECRET unset: rejected even with no header", isAuthorizedCronRequest(null, undefined), false);
    check("CRON_SECRET unset: rejected whatever the header says", isAuthorizedCronRequest("Bearer undefined", undefined), false);
    check("CRON_SECRET empty: rejected", isAuthorizedCronRequest("Bearer ", ""), false);
    check("wrong secret: rejected", isAuthorizedCronRequest("Bearer nope", "s3cret"), false);
    check("missing header: rejected", isAuthorizedCronRequest(null, "s3cret"), false);
    check("bare secret without Bearer: rejected", isAuthorizedCronRequest("s3cret", "s3cret"), false);
    check("correct Bearer secret: accepted", isAuthorizedCronRequest("Bearer s3cret", "s3cret"), true);
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
