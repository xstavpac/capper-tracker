// Proof for the NBA roster fetcher and the NBA loader entry points - run with:
//   npx tsx src/server/data/nba-roster-acceptance-test.ts
//
// No database and no network: the fetch is stubbed and the table is a fake.
// (The cache reader and the migration are proved against a real database in
// nba-roster-cache-acceptance-test.ts; the shared loader's every rule in
// roster-load-acceptance-test.ts.)
//
// Fixtures, both captured live from ESPN on 2026-10-13:
//   nba-roster-atl.json                             the Hawks' roster response, verbatim
//   nba-boxscore-401898402-okc-atl-players.json     OKC @ ATL (2026-10-12, final): the summary's
//                                                   header teams/linescores + boxscore.players,
//                                                   the rest of the 457 KB response dropped
//
//   PART A - the fetcher reads ESPN's FLAT roster shape, every position.
//   PART B - roster ids are the box score's athlete ids.
//   PART C - the league fetch survives a failed team.
//   PART D - the NBA loader (a thin wrapper over roster-load.ts with the NBA
//            config): what a load would change, dry run writes nothing, commit
//            writes only the changes and never deletes, a partial league fetch
//            is refused.
import fs from "node:fs";
import path from "node:path";
import { extractNbaRosterPlayers, fetchNbaLeagueRoster, NBA_ESPN_TEAM_IDS } from "./nba-roster";
import { extractNhlRosterPlayers } from "./nhl-roster";
import { planNbaRosterLoad, runNbaRosterLoad, NBA_TEAM_COUNT, type NbaRosterRow, type NbaRosterTable } from "./nba-roster-load";
import type { RosterPlayer } from "./nfl-roster";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, "__fixtures__", name), "utf8"));
const atlRaw = fixture("nba-roster-atl.json");
const box = fixture("nba-boxscore-401898402-okc-atl-players.json");

// A spy table: records every call, serves `rows` to readForDiff.
function fakeTable(rows: NbaRosterRow[]) {
  const calls = { reads: 0, created: [] as { externalId: string; team: string }[], updates: [] as { id: string; team: string }[], deactivations: [] as string[][] };
  const table: NbaRosterTable = {
    readForDiff: async () => {
      calls.reads++;
      return rows;
    },
    createMany: async (r) => {
      calls.created.push(...r);
    },
    updateRow: async (id, data) => {
      calls.updates.push({ id, team: data.team });
    },
    deactivate: async (ids) => {
      calls.deactivations.push(ids);
    },
  };
  return { table, calls };
}

// 30 teams, 16 players each (480 - above the NBA minimums of 450 players and 12 per team).
const PER_TEAM = 16;
function fullLeague(): RosterPlayer[] {
  return NBA_ESPN_TEAM_IDS.flatMap(([id, team]) =>
    Array.from({ length: PER_TEAM }, (_, i) => i + 1).map((n) => ({
      playerName: `Player ${id}-${n}`,
      firstName: "Player",
      lastName: `${id}-${n}`,
      team,
      position: n % 3 === 0 ? "C" : n % 2 === 0 ? "F" : "G",
      externalPlayerId: `${id}0${n}`,
    }))
  );
}
const asRow = (p: RosterPlayer, overrides: Partial<NbaRosterRow> = {}): NbaRosterRow => ({
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
const counts = (p: ReturnType<typeof planNbaRosterLoad>) => ({ added: p.added, updated: p.updated, reactivated: p.reactivated, unchanged: p.unchanged, deactivated: p.deactivated, deactivationsSkipped: p.deactivationsSkipped });

async function main() {
  console.log("########## PART A: the flat roster shape ##########");
  const atl = extractNbaRosterPlayers("Atlanta Hawks", atlRaw);
  {
    check("the capture is ESPN's flat shape: athletes[] of players, no position groups", { isArray: Array.isArray(atlRaw.athletes), grouped: atlRaw.athletes.some((a: { items?: unknown }) => Array.isArray(a.items)) }, { isArray: true, grouped: false });
    check("every athlete in the capture is extracted", atl.length, atlRaw.athletes.length);
    check("the Hawks capture has 21 players", atl.length, 21);
    check("every position is kept (G / F / C)", atl.reduce<Record<string, number>>((acc, p) => ((acc[p.position] = (acc[p.position] ?? 0) + 1), acc), {}), { G: 10, F: 9, C: 2 });
    check("a player maps field for field", atl.find((p) => p.externalPlayerId === "4278039"), {
      playerName: "Nickeil Alexander-Walker",
      firstName: "Nickeil",
      lastName: "Alexander-Walker",
      team: "Atlanta Hawks",
      position: "G",
      externalPlayerId: "4278039",
    });
    check("every player carries the team passed in", atl.every((p) => p.team === "Atlanta Hawks"), true);
    check("ids are unique", new Set(atl.map((p) => p.externalPlayerId)).size, atl.length);
    check("the team name used is the roster response's own", atlRaw.team.displayName, "Atlanta Hawks");

    // The two leagues' shapes are not interchangeable - which is why NBA has its own extractor.
    check("the NHL (grouped) extractor reads nothing from the NBA shape", extractNhlRosterPlayers("Atlanta Hawks", atlRaw).length, 0);
    const pitRaw = fixture("nhl-roster-pit.json");
    check("the NBA (flat) extractor reads nothing from the NHL shape", extractNbaRosterPlayers("Pittsburgh Penguins", pitRaw).length, 0);

    // An entry missing a field the cache needs is skipped, never guessed at.
    const partial = { athletes: [atlRaw.athletes[0], { ...atlRaw.athletes[1], id: undefined }, { ...atlRaw.athletes[2], position: undefined }, { ...atlRaw.athletes[3], lastName: "" }, null] };
    check("entries missing id / position / lastName (or null) are skipped", extractNbaRosterPlayers("Atlanta Hawks", partial).map((p) => p.externalPlayerId), ["4278039"]);
    check("a numeric id is stored as a string", extractNbaRosterPlayers("Atlanta Hawks", { athletes: [{ ...atlRaw.athletes[0], id: 4278039 }] })[0]?.externalPlayerId, "4278039");
    for (const bad of [null, undefined, {}, { athletes: null }, { athletes: "x" }, []]) {
      check(`malformed response ${JSON.stringify(bad)} -> []`, extractNbaRosterPlayers("Atlanta Hawks", bad), []);
    }
  }

  console.log("\n########## PART B: roster ids are the box score's athlete ids ##########");
  {
    const hawks = box.boxscore.players.find((t: { team: { displayName: string } }) => t.team.displayName === "Atlanta Hawks");
    check("the box score names the team exactly as the roster table does", hawks?.team.displayName, NBA_ESPN_TEAM_IDS.find(([id]) => id === "1")?.[1]);
    const boxAthletes: { athlete: { id: string; displayName: string } }[] = hawks.statistics.flatMap((g: { athletes: unknown[] }) => g.athletes);
    check("the Hawks have 12 athletes in the OKC @ ATL box score", boxAthletes.length, 12);
    const rosterById = new Map(atl.map((p) => [p.externalPlayerId, p]));
    check("every one is on the roster under the SAME id", boxAthletes.filter((a) => rosterById.has(String(a.athlete.id))).length, 12);
    check("and under the same display name", boxAthletes.filter((a) => rosterById.get(String(a.athlete.id))?.playerName === a.athlete.displayName).length, 12);
    check("the box score's stat columns, by label", hawks.statistics[0].labels, ["MIN", "PTS", "FG", "3PT", "FT", "REB", "AST", "TO", "STL", "BLK", "OREB", "DREB", "PF", "+/-"]);
  }

  console.log("\n########## PART C: the league fetch ##########");
  {
    check("30 teams, distinct ids and names", { n: NBA_ESPN_TEAM_IDS.length, ids: new Set(NBA_ESPN_TEAM_IDS.map(([id]) => id)).size, names: new Set(NBA_ESPN_TEAM_IDS.map(([, n]) => n)).size }, { n: 30, ids: 30, names: 30 });
    check("the Clippers are spelled as ESPN spells them", NBA_ESPN_TEAM_IDS.some(([, n]) => n === "LA Clippers"), true);

    const realFetch = globalThis.fetch;
    const realError = console.error;
    const requested: string[] = [];
    try {
      console.error = () => {};
      // Every team answers with the Hawks capture; Boston (id 2) is down and Chicago (id 4) throws.
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        const teamId = url.match(/\/basketball\/nba\/teams\/(\d+)\/roster$/)?.[1];
        if (!teamId) throw new Error("unexpected fetch: " + url);
        requested.push(teamId);
        if (teamId === "4") throw new Error("simulated network failure");
        if (teamId === "2") return { ok: false, status: 503, json: async () => ({}) } as Response;
        return { ok: true, status: 200, json: async () => atlRaw } as Response;
      }) as typeof fetch;
      const league = await fetchNbaLeagueRoster();
      const teams = new Set(league.map((p) => p.team));
      check("one roster request per team, to the NBA roster endpoint", requested.slice().sort(), NBA_ESPN_TEAM_IDS.map(([id]) => id).sort());
      check("a 503 and a thrown fetch cost only their own teams", { teams: teams.size, players: league.length }, { teams: 28, players: 28 * 21 });
      check("the failed teams are simply absent", [teams.has("Boston Celtics"), teams.has("Chicago Bulls"), teams.has("Atlanta Hawks")], [false, false, true]);
    } finally {
      globalThis.fetch = realFetch;
      console.error = realError;
    }
  }

  console.log("\n########## PART D: the NBA loader ##########");
  {
    const league = fullLeague();
    check("the test league is 30 teams / 480 players", { teams: new Set(league.map((p) => p.team)).size, players: league.length, expected: NBA_TEAM_COUNT }, { teams: 30, players: 480, expected: 30 });

    // -- the plan --
    check("empty table: everything is an add", { ...counts(planNbaRosterLoad(league, [])), players: 480, teams: 30 }, { added: 480, updated: 0, reactivated: 0, unchanged: 0, deactivated: 0, deactivationsSkipped: 0, players: 480, teams: 30 });
    const traded = asRow(league[0], { team: "Utah Jazz" });
    const gone = asRow({ playerName: "Waived Player", firstName: "Waived", lastName: "Player", team: "Atlanta Hawks", position: "F", externalPlayerId: "999999" });
    const existing = [traded, ...league.slice(1, 400).map((p) => asRow(p)), gone];
    check("a traded player is an update, an absent one is deactivated, the rest split added / unchanged", counts(planNbaRosterLoad(league, existing)), {
      added: 80,
      updated: 1,
      reactivated: 0,
      unchanged: 399,
      deactivated: 1,
      deactivationsSkipped: 0,
    });
    check("a second load of the same rosters changes nothing", counts(planNbaRosterLoad(league, league.map((p) => asRow(p)))), { added: 0, updated: 0, reactivated: 0, unchanged: 480, deactivated: 0, deactivationsSkipped: 0 });

    // -- dry run --
    {
      const { table, calls } = fakeTable(existing);
      const lines: string[] = [];
      const res = await runNbaRosterLoad({ commit: false, fetchRoster: async () => league, table, log: (l) => lines.push(l) });
      check("dry run: status", res.status, "dry_run");
      check("dry run: reads the table once and WRITES NOTHING", { reads: calls.reads, created: calls.created.length, updates: calls.updates.length, deactivations: calls.deactivations.length }, { reads: 1, created: 0, updates: 0, deactivations: 0 });
      check("dry run: reports the counts", lines, [
        "fetched 480 players across 30 teams",
        "would add 80, update 1, reactivate 0, leave 399 unchanged, deactivate 1, skip 0 deactivations (short teams: none)",
        "dry run - nothing written. re-run with --commit to persist.",
      ]);
    }

    // -- commit --
    {
      const { table, calls } = fakeTable(existing);
      const res = await runNbaRosterLoad({ commit: true, fetchRoster: async () => league, table });
      check("commit: status", res.status, "committed");
      check("commit: only the 80 new players are inserted", calls.created.length, 80);
      check("commit: only the traded player is updated, with his new team", calls.updates, [{ id: traded.id, team: league[0].team }]);
      check("commit: the waived player is deactivated by row id, not deleted", calls.deactivations, [["row-999999"]]);
    }
    {
      const { table, calls } = fakeTable(league.map((p) => asRow(p)));
      await runNbaRosterLoad({ commit: true, fetchRoster: async () => league, table });
      check("commit with nothing changed: no write of any kind", { created: calls.created.length, updates: calls.updates.length, deactivations: calls.deactivations.length }, { created: 0, updates: 0, deactivations: 0 });
    }

    // -- partial league fetch --
    for (const commit of [false, true]) {
      const { table, calls } = fakeTable(existing);
      const partial = league.filter((p) => p.team !== "Boston Celtics" && p.team !== "Chicago Bulls");
      const lines: string[] = [];
      const res = await runNbaRosterLoad({ commit, fetchRoster: async () => partial, table, log: (l) => lines.push(l) });
      check(`partial fetch (28 teams), commit=${commit}: refused, naming the missing teams`, res, {
        status: "aborted",
        reason: "only 28/30 teams returned players - missing: Boston Celtics, Chicago Bulls",
        players: 448,
        teams: 28,
        missingTeams: ["Boston Celtics", "Chicago Bulls"],
      });
      check(`partial fetch, commit=${commit}: the table is neither read nor written`, { reads: calls.reads, created: calls.created.length, updates: calls.updates.length, deactivations: calls.deactivations.length }, { reads: 0, created: 0, updates: 0, deactivations: 0 });
      check(`partial fetch, commit=${commit}: says so`, lines[1], "ABORT: only 28/30 teams returned players - missing: Boston Celtics, Chicago Bulls - nothing read or written");
    }
    {
      // 29 of 30 is still partial; an empty fetch is the same refusal.
      const { table, calls } = fakeTable(existing);
      const res29 = await runNbaRosterLoad({ commit: true, fetchRoster: async () => league.filter((p) => p.team !== "Utah Jazz"), table });
      check("29 teams: refused", res29.status, "aborted");
      const res0 = await runNbaRosterLoad({ commit: true, fetchRoster: async () => [], table });
      check("0 teams: refused, all 30 named missing", { status: res0.status, missing: res0.status === "aborted" ? res0.missingTeams.length : -1 }, { status: "aborted", missing: 30 });
      check("neither wrote anything", { created: calls.created.length, updates: calls.updates.length, deactivations: calls.deactivations.length }, { created: 0, updates: 0, deactivations: 0 });
    }

    // -- per-team guard and --force through the NBA wrapper --
    {
      // The Hawks come back with 5 players (< 12): their 11 missing players stay active.
      const shortHawks = league.filter((p) => p.team !== "Atlanta Hawks" || Number(p.lastName.split("-")[1]) <= 5);
      const all = league.map((p) => asRow(p));
      const skipped = await runNbaRosterLoad({ commit: true, fetchRoster: async () => shortHawks, table: fakeTable(all).table });
      check("short team: deactivations skipped", skipped.status === "committed" && { deactivated: skipped.plan.deactivated, skipped: skipped.plan.deactivationsSkipped, shortTeams: skipped.plan.shortTeams }, { deactivated: 0, skipped: 11, shortTeams: ["Atlanta Hawks"] });
      const forced = await runNbaRosterLoad({ commit: true, force: true, fetchRoster: async () => shortHawks, table: fakeTable(all).table });
      check("--force: the short team's missing players are deactivated", forced.status === "committed" && { deactivated: forced.plan.deactivated, skipped: forced.plan.deactivationsSkipped }, { deactivated: 11, skipped: 0 });
    }
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
