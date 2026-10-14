// Proof for the shared roster loader (roster-load.ts), the league configs
// (roster-leagues.ts) and the table adapter (roster-table-adapter.ts) - run with:
//   npx tsx src/server/data/roster-load-acceptance-test.ts
//
// No database and no network: the fetch is stubbed and the table is a spy.
//
//   PART A - a normal run: first load is one createMany, a steady-state run
//            writes only what changed, a dry run writes nothing.
//   PART B - league guard: too few teams or players aborts before any read or write.
//   PART C - soft delete: a missing player is deactivated, never deleted, and
//            reactivated when he reappears.
//   PART D - per-team guard: a short team's deactivations are skipped (its adds
//            and updates still apply); --force overrides it, never the league guard.
//   PART E - the table adapter reads only the compared columns.
//   PART F - the league configs.
import type { RosterPlayer } from "./nfl-roster";
import { planRosterLoad, runRosterLoad, rowsWritten, type ExistingRosterRow, type RosterLeagueConfig, type RosterTable } from "./roster-load";
import { makeRosterTable, type RosterDelegate } from "./roster-table-adapter";
import { ROSTER_LEAGUES, ROSTER_LEAGUE_ORDER, mlbRosterSeason } from "./roster-leagues";
import { NFL_ESPN_TEAM_IDS } from "./nfl-roster";
import { NHL_ESPN_TEAM_IDS } from "./nhl-roster";
import { NBA_ESPN_TEAM_IDS } from "./nba-roster";
import { MLB_TEAM_IDS } from "./mlb-roster";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

// A small test league: 4 teams, 5 players each; guards scaled to match.
const TEAMS = ["Alphas", "Bravos", "Charlies", "Deltas"];
const CONFIG: RosterLeagueConfig = {
  league: "NHL",
  sportKey: "icehockey_nhl",
  teams: TEAMS,
  minTeams: 4,
  minPlayers: 16,
  minPlayersPerTeam: 4,
  fetchRoster: async () => {
    throw new Error("tests pass fetchRoster explicitly");
  },
};

const player = (team: string, n: number, overrides: Partial<RosterPlayer> = {}): RosterPlayer => ({
  playerName: `${team} Player${n}`,
  firstName: team,
  lastName: `Player${n}`,
  team,
  position: "C",
  externalPlayerId: `${team[0]}${n}`,
  ...overrides,
});
const league = (perTeam = 5): RosterPlayer[] => TEAMS.flatMap((t) => Array.from({ length: perTeam }, (_, i) => player(t, i + 1)));
const asRow = (p: RosterPlayer, overrides: Partial<ExistingRosterRow> = {}): ExistingRosterRow => ({
  id: "row-" + p.externalPlayerId,
  externalId: p.externalPlayerId,
  fullName: p.playerName,
  firstName: p.firstName,
  lastName: p.lastName,
  team: p.team,
  position: p.position,
  active: true,
  ...overrides,
});

// A spy table: records every call, serves `rows` to readForDiff.
function spyTable(rows: ExistingRosterRow[]) {
  const calls = { reads: 0, createMany: [] as unknown[][], updates: [] as { id: string; data: unknown }[], deactivations: [] as { ids: string[]; at: Date }[] };
  const table: RosterTable = {
    readForDiff: async () => {
      calls.reads++;
      return rows;
    },
    createMany: async (r) => {
      calls.createMany.push(r);
    },
    updateRow: async (id, data) => {
      calls.updates.push({ id, data });
    },
    deactivate: async (ids, at) => {
      calls.deactivations.push({ ids, at });
    },
  };
  const writes = () => ({ createMany: calls.createMany.length, updates: calls.updates.length, deactivations: calls.deactivations.length });
  return { table, calls, writes };
}

const NOW = new Date("2026-10-15T10:45:00Z");
const run = (fetched: RosterPlayer[], table: RosterTable, extra: { commit?: boolean; force?: boolean; log?: (l: string) => void } = {}) =>
  runRosterLoad({ config: CONFIG, table, commit: extra.commit ?? true, force: extra.force, fetchRoster: async () => fetched, now: NOW, log: extra.log });

const counts = (p: ReturnType<typeof planRosterLoad>) => ({
  added: p.added,
  updated: p.updated,
  reactivated: p.reactivated,
  unchanged: p.unchanged,
  deactivated: p.deactivated,
  deactivationsSkipped: p.deactivationsSkipped,
  shortTeams: p.shortTeams,
});

async function main() {
  console.log("########## PART A: a normal run ##########");
  {
    const full = league();
    // First load into an empty table.
    const empty = spyTable([]);
    const first = await run(full, empty.table);
    check("first load: committed", first.status, "committed");
    check("first load: every player is ONE createMany, no per-row writes", { ...empty.writes(), rows: empty.calls.createMany[0]?.length }, { createMany: 1, updates: 0, deactivations: 0, rows: 20 });
    check("first load: rows carry the external id and the data columns", empty.calls.createMany[0]?.[0], { externalId: "A1", fullName: "Alphas Player1", firstName: "Alphas", lastName: "Player1", team: "Alphas", position: "C" });
    check("first load: rowsWritten", rowsWritten(first), 20);

    // Steady state: nothing moved.
    const same = spyTable(full.map((p) => asRow(p)));
    const steady = await run(full, same.table);
    check("no roster moves: one read, ZERO writes", { reads: same.calls.reads, ...same.writes() }, { reads: 1, createMany: 0, updates: 0, deactivations: 0 });
    check("no roster moves: all unchanged", steady.status === "committed" && counts(steady.plan), { added: 0, updated: 0, reactivated: 0, unchanged: 20, deactivated: 0, deactivationsSkipped: 0, shortTeams: [] });

    // A trade, a position change, a signing: exactly those rows are written.
    const moved = full.map((p) => (p.externalPlayerId === "A1" ? { ...p, team: "Bravos" } : p.externalPlayerId === "C2" ? { ...p, position: "D" } : p));
    const signed = [...moved, player("Deltas", 9)];
    const t = spyTable(full.map((p) => asRow(p)));
    const res = await run(signed, t.table);
    check("trade + position change + signing: counts", res.status === "committed" && counts(res.plan), { added: 1, updated: 2, reactivated: 0, unchanged: 18, deactivated: 0, deactivationsSkipped: 0, shortTeams: [] });
    check("only the changed rows are updated", t.calls.updates.map((u) => u.id).sort(), ["row-A1", "row-C2"]);
    check("the traded player's row gets his new team", (t.calls.updates.find((u) => u.id === "row-A1")?.data as { team: string }).team, "Bravos");
    check("the signing is the only insert", t.calls.createMany, [[{ externalId: "D9", fullName: "Deltas Player9", firstName: "Deltas", lastName: "Player9", team: "Deltas", position: "C" }]]);

    // Dry run.
    const dry = spyTable(full.map((p) => asRow(p)));
    const lines: string[] = [];
    const d = await run(signed, dry.table, { commit: false, log: (l) => lines.push(l) });
    check("dry run: status", d.status, "dry_run");
    check("dry run: reads once, WRITES NOTHING", { reads: dry.calls.reads, ...dry.writes() }, { reads: 1, createMany: 0, updates: 0, deactivations: 0 });
    check("dry run: says what it would do", lines, [
      "fetched 21 players across 4 teams",
      "would add 1, update 2, reactivate 0, leave 18 unchanged, deactivate 0, skip 0 deactivations (short teams: none)",
      "dry run - nothing written. re-run with --commit to persist.",
    ]);
    check("dry run: rowsWritten is 0", rowsWritten(d), 0);

    // A player listed twice in one fetch counts once.
    check("a duplicate id in the fetch keeps the first entry", counts(planRosterLoad(CONFIG, [...full, { ...full[0], team: "Deltas" }], [])), { added: 20, updated: 0, reactivated: 0, unchanged: 0, deactivated: 0, deactivationsSkipped: 0, shortTeams: [] });
  }

  console.log("\n########## PART B: league guard ##########");
  {
    const existing = league().map((p) => asRow(p));
    // A whole team missing.
    for (const commit of [true, false]) {
      const t = spyTable(existing);
      const lines: string[] = [];
      const res = await run(league().filter((p) => p.team !== "Charlies"), t.table, { commit, log: (l) => lines.push(l) });
      check(`missing team (commit=${commit}): aborted, naming it`, res, { status: "aborted", reason: "only 3/4 teams returned players - missing: Charlies", players: 15, teams: 3, missingTeams: ["Charlies"] });
      check(`missing team (commit=${commit}): table neither read nor written`, { reads: t.calls.reads, ...t.writes() }, { reads: 0, createMany: 0, updates: 0, deactivations: 0 });
      check(`missing team (commit=${commit}): says so`, lines[1], "ABORT: only 3/4 teams returned players - missing: Charlies - nothing read or written");
    }
    // Every team present, but the league total is below minPlayers (3 x 4 = 12 < 16).
    {
      const t = spyTable(existing);
      const res = await run(league(3), t.table);
      check("every team present but too few players: aborted", res.status === "aborted" && res.reason, "only 12 players returned, below the minimum of 16");
      check("too few players: nothing read or written", { reads: t.calls.reads, ...t.writes() }, { reads: 0, createMany: 0, updates: 0, deactivations: 0 });
    }
    // An empty fetch, and --force, are both still aborts.
    {
      const t = spyTable(existing);
      const empty = await run([], t.table);
      const forced = await run(league().filter((p) => p.team !== "Alphas"), t.table, { force: true });
      check("empty fetch: aborted with every team missing", empty.status === "aborted" && empty.missingTeams, TEAMS);
      check("--force does NOT override the league guard", forced.status, "aborted");
      check("neither wrote anything", { reads: t.calls.reads, ...t.writes() }, { reads: 0, createMany: 0, updates: 0, deactivations: 0 });
    }
  }

  console.log("\n########## PART C: soft delete ##########");
  {
    const full = league();
    const gone = full.find((p) => p.externalPlayerId === "B3")!;
    // B3 released (absent from the fetch): deactivated, not deleted.
    const t = spyTable(full.map((p) => asRow(p)));
    const fetched = [...full.filter((p) => p !== gone), player("Bravos", 6)];
    const res = await run(fetched, t.table);
    check("a released player is deactivated", res.status === "committed" && counts(res.plan), { added: 1, updated: 0, reactivated: 0, unchanged: 19, deactivated: 1, deactivationsSkipped: 0, shortTeams: [] });
    check("deactivation is scoped to his row id, stamped with the run time", t.calls.deactivations, [{ ids: ["row-B3"], at: NOW }]);
    check("the RosterTable has no delete at all", Object.keys(t.table).sort(), ["createMany", "deactivate", "readForDiff", "updateRow"]);

    // Already inactive and still absent: left alone (no repeat write).
    const t2 = spyTable([...full.filter((p) => p !== gone).map((p) => asRow(p)), asRow(gone, { active: false })]);
    await run(full.filter((p) => p !== gone), t2.table);
    check("an already-inactive absent player is not written again", t2.writes(), { createMany: 0, updates: 0, deactivations: 0 });

    // He reappears (re-signed by another team): reactivated with his new data, not re-inserted.
    const t3 = spyTable([...full.filter((p) => p !== gone).map((p) => asRow(p)), asRow(gone, { active: false })]);
    const back = await run([...full.filter((p) => p !== gone), { ...gone, team: "Deltas" }], t3.table);
    check("a returning player is reactivated", back.status === "committed" && counts(back.plan), { added: 0, updated: 0, reactivated: 1, unchanged: 19, deactivated: 0, deactivationsSkipped: 0, shortTeams: [] });
    check("reactivation is an update of his existing row (the adapter sets active = true, removedAt = null)", t3.calls.updates, [{ id: "row-B3", data: { fullName: gone.playerName, firstName: gone.firstName, lastName: gone.lastName, team: "Deltas", position: "C" } }]);
    check("no insert for a returning player", t3.calls.createMany.length, 0);

    // Reactivated even when nothing else about him changed.
    const t4 = spyTable([...full.filter((p) => p !== gone).map((p) => asRow(p)), asRow(gone, { active: false })]);
    await run(full, t4.table);
    check("unchanged data but inactive -> still reactivated", t4.calls.updates.map((u) => u.id), ["row-B3"]);
  }

  console.log("\n########## PART D: per-team guard ##########");
  {
    const full = league();
    // Charlies come back with 2 players (< 4): their 3 missing players are NOT deactivated;
    // a Deltas player missing from a full-size Deltas response still is.
    // Charlies: C1 (now LW), C2, and a new C8 = 3 players; Deltas: D1-D4 and a new D7 = 5.
    const roster = [
      ...full
        .filter((p) => !["C3", "C4", "C5", "D5"].includes(p.externalPlayerId))
        .map((p) => (p.externalPlayerId === "C1" ? { ...p, position: "LW" } : p)),
      player("Deltas", 7),
      player("Charlies", 8),
    ];
    const lines: string[] = [];
    const t = spyTable(full.map((p) => asRow(p)));
    const res = await run(roster, t.table, { log: (l) => lines.push(l) });
    check("short team: its deactivations skipped, everyone else's applied", res.status === "committed" && counts(res.plan), {
      added: 2,
      updated: 1,
      reactivated: 0,
      unchanged: 15,
      deactivated: 1,
      deactivationsSkipped: 3,
      shortTeams: ["Charlies"],
    });
    check("only the full-size team's missing player is deactivated", t.calls.deactivations.map((d) => d.ids), [["row-D5"]]);
    check("the short team's add still applies", (t.calls.createMany[0] as { externalId: string }[]).map((r) => r.externalId).sort(), ["C8", "D7"]);
    check("the short team's update still applies", t.calls.updates.map((u) => u.id), ["row-C1"]);
    check("the short team is logged", lines[1], "WARNING: short teams (< 4 players), their deactivations skipped: Charlies");

    // --force: the same fetch deactivates the short team's missing players too.
    const f = spyTable(full.map((p) => asRow(p)));
    const forcedLines: string[] = [];
    const forced = await run(roster, f.table, { force: true, log: (l) => forcedLines.push(l) });
    check("--force: short team's missing players deactivated as well", forced.status === "committed" && { deactivated: forced.plan.deactivated, skipped: forced.plan.deactivationsSkipped }, { deactivated: 4, skipped: 0 });
    check("--force: deactivation ids", f.calls.deactivations.map((d) => d.ids.slice().sort()), [["row-C3", "row-C4", "row-C5", "row-D5"]]);
    check("--force: says it is overriding", forcedLines[1], "--force: deactivating normally despite short teams (< 4 players): Charlies");

    // A short team whose players are all present loses nothing either way - the guard only ever withholds deactivations.
    check("a short team with no missing players: nothing skipped", counts(planRosterLoad(CONFIG, league().filter((p) => !(p.team === "Alphas" && p.externalPlayerId > "A3")), league().filter((p) => !(p.team === "Alphas" && p.externalPlayerId > "A3")).map((p) => asRow(p)))).deactivationsSkipped, 0);
  }

  console.log("\n########## PART E: the table adapter ##########");
  {
    for (const idColumn of ["espnPlayerId", "mlbPlayerId"] as const) {
      const seen: Record<string, unknown[]> = { findMany: [], createMany: [], update: [], updateMany: [] };
      const delegate: RosterDelegate = {
        findMany: async (args) => {
          seen.findMany.push(args);
          return [{ id: "r1", [idColumn]: "77", fullName: "A B", firstName: "A", lastName: "B", team: "T", position: "C", active: false }];
        },
        createMany: async (args) => void seen.createMany.push(args),
        update: async (args) => void seen.update.push(args),
        updateMany: async (args) => void seen.updateMany.push(args),
      };
      const table = makeRosterTable(delegate, idColumn);
      const rows = await table.readForDiff();
      check(`${idColumn}: the diff read selects ONLY id, player id, names, team, position, active`, Object.keys((seen.findMany[0] as { select: object }).select).sort(), ["active", "firstName", "fullName", idColumn, "id", "lastName", "position", "team"].sort());
      check(`${idColumn}: rows map to the loader's shape`, rows, [{ id: "r1", externalId: "77", fullName: "A B", firstName: "A", lastName: "B", team: "T", position: "C", active: false }]);
      await table.createMany([{ externalId: "88", fullName: "C D", firstName: "C", lastName: "D", team: "T", position: "G" }]);
      check(`${idColumn}: createMany writes the id column, skips duplicates`, seen.createMany[0], { data: [{ [idColumn]: "88", fullName: "C D", firstName: "C", lastName: "D", team: "T", position: "G" }], skipDuplicates: true });
      await table.updateRow("r1", { fullName: "A B", firstName: "A", lastName: "B", team: "U", position: "C" });
      check(`${idColumn}: an update also (re)activates the row`, seen.update[0], { where: { id: "r1" }, data: { fullName: "A B", firstName: "A", lastName: "B", team: "U", position: "C", active: true, removedAt: null } });
      await table.deactivate(["r1", "r2"], NOW);
      check(`${idColumn}: deactivate is an update by id, never a delete`, seen.updateMany[0], { where: { id: { in: ["r1", "r2"] } }, data: { active: false, removedAt: NOW } });
    }
  }

  console.log("\n########## PART F: the league configs ##########");
  {
    check("four leagues, no WNBA / NCAA", ROSTER_LEAGUE_ORDER, ["NFL", "NHL", "NBA", "MLB"]);
    check("season keys", ROSTER_LEAGUE_ORDER.map((l) => ROSTER_LEAGUES[l].sportKey), ["americanfootball_nfl", "icehockey_nhl", "basketball_nba", "baseball_mlb"]);
    check("minTeams is every franchise", ROSTER_LEAGUE_ORDER.map((l) => [ROSTER_LEAGUES[l].minTeams, ROSTER_LEAGUES[l].teams.length]), [[32, 32], [32, 32], [30, 30], [30, 30]]);
    check("team lists are the fetchers' own", [ROSTER_LEAGUES.NFL.teams.length === NFL_ESPN_TEAM_IDS.length, ROSTER_LEAGUES.NHL.teams[0] === NHL_ESPN_TEAM_IDS[0][1], ROSTER_LEAGUES.NBA.teams.includes("LA Clippers") && NBA_ESPN_TEAM_IDS.length === 30, ROSTER_LEAGUES.MLB.teams.includes("Athletics") && MLB_TEAM_IDS.length === 30], [true, true, true, true]);
    // Live 2026-10-14: NFL 770 (21-28/team), NHL 842 (23-31), NBA 622 (18-24), MLB 1,359 (40-57).
    const live = { NFL: [770, 21], NHL: [842, 23], NBA: [622, 18], MLB: [1359, 40] } as const;
    check(
      "the minimums sit below the live league totals and the smallest live team",
      ROSTER_LEAGUE_ORDER.map((l) => ROSTER_LEAGUES[l].minPlayers < live[l][0] && ROSTER_LEAGUES[l].minPlayersPerTeam < live[l][1]),
      [true, true, true, true]
    );
    check("per-team minimums as configured", ROSTER_LEAGUE_ORDER.map((l) => ROSTER_LEAGUES[l].minPlayersPerTeam), [15, 18, 12, 30]);
    check("MLB roster season is the Eastern calendar year", [mlbRosterSeason(new Date("2026-10-15T12:00:00Z")), mlbRosterSeason(new Date("2027-01-01T03:00:00Z"))], [2026, 2026]);
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
