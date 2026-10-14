// The one roster loader behind all four roster cache tables (NFL / NHL / NBA /
// MLB), used by the daily /api/cron/refresh-rosters job and by the manual
// scripts/load-*-roster.ts scripts. No prisma import - the table is passed in
// (roster-tables.ts builds the real ones) - so every rule below is testable
// without a database or the network.
//
// A run is: fetch the league -> league-level guard -> diff against the cached
// rows -> write only what changed.
//
//   League guard: fewer teams than config.minTeams, or fewer players than
//   config.minPlayers, aborts the league before the table is read or written.
//   A partial fetch is an outage, not a roster change.
//
//   Soft delete, never a hard one: a cached player the fetch no longer lists is
//   set active = false + removedAt (and set back to active if he reappears).
//   Import name matching reads active rows only; grading reads every row, so a
//   pending prop on a released or traded player still grades.
//
//   Per-team guard: a team that came back with fewer than
//   config.minPlayersPerTeam players looks like a bad response for that team,
//   so none of its cached players are deactivated this run (adds and updates
//   still apply). `force` - the scripts' --force - overrides this guard only;
//   the league guard always holds.
//
//   Egress: the diff reads only the compared columns (roster-tables.ts's
//   select), adds go in one createMany, and only rows whose data or active flag
//   changed are updated. A day with no roster moves reads one narrow row per
//   player and writes nothing.
import type { RosterPlayer } from "@/server/data/nfl-roster";

export type RosterLeague = "NFL" | "NHL" | "NBA" | "MLB";

export type RosterRowData = { fullName: string; firstName: string; lastName: string; team: string; position: string };
// externalId is the table's own player-id column (espnPlayerId, or mlbPlayerId for MLB).
export type ExistingRosterRow = RosterRowData & { id: string; externalId: string; active: boolean };
export type NewRosterRow = RosterRowData & { externalId: string };

// The slice of a roster table the loader uses.
export type RosterTable = {
  readForDiff(): Promise<ExistingRosterRow[]>;
  createMany(rows: NewRosterRow[]): Promise<unknown>;
  // Rewrites one row's data and marks it active (an update or a reactivation).
  updateRow(id: string, data: RosterRowData): Promise<unknown>;
  // active = false, removedAt = `at`, for exactly these row ids.
  deactivate(ids: string[], at: Date): Promise<unknown>;
};

export type RosterLeagueConfig = {
  league: RosterLeague;
  // SPORT_SEASON_CONFIG key - the refresh skips a league outside its window.
  sportKey: string;
  // Every franchise, by the name the fetch stamps on its players.
  teams: string[];
  minTeams: number;
  minPlayers: number;
  minPlayersPerTeam: number;
  fetchRoster: () => Promise<RosterPlayer[]>;
};

export type RosterPlan = {
  players: number;
  teams: number;
  added: number;
  updated: number;
  reactivated: number;
  unchanged: number;
  deactivated: number;
  // Cached active players not in the fetch whose team came back short, so were left active.
  deactivationsSkipped: number;
  shortTeams: string[];
  adds: NewRosterRow[];
  updates: { id: string; data: RosterRowData }[];
  deactivateIds: string[];
};

export type RosterLoadResult =
  | { status: "aborted"; reason: string; players: number; teams: number; missingTeams: string[] }
  | { status: "dry_run"; plan: RosterPlan }
  | { status: "committed"; plan: RosterPlan };

const toRowData = (p: RosterPlayer): RosterRowData => ({
  fullName: p.playerName,
  firstName: p.firstName,
  lastName: p.lastName,
  team: p.team,
  position: p.position,
});

const sameData = (a: RosterRowData, b: RosterRowData) =>
  a.fullName === b.fullName && a.firstName === b.firstName && a.lastName === b.lastName && a.team === b.team && a.position === b.position;

// Player counts per team, with every configured team present (0 when it returned nobody).
function countByTeam(config: RosterLeagueConfig, roster: RosterPlayer[]): Map<string, number> {
  const counts = new Map(config.teams.map((t) => [t, 0]));
  for (const p of roster) counts.set(p.team, (counts.get(p.team) ?? 0) + 1);
  return counts;
}

// Why this fetch must not be written at all, or null when it passes the league guard.
export function leagueGuardFailure(config: RosterLeagueConfig, roster: RosterPlayer[]): { reason: string; missingTeams: string[] } | null {
  const returned = new Set(roster.map((p) => p.team));
  const missingTeams = config.teams.filter((t) => !returned.has(t));
  if (returned.size < config.minTeams) {
    return { reason: `only ${returned.size}/${config.minTeams} teams returned players - missing: ${missingTeams.join(", ")}`, missingTeams };
  }
  if (roster.length < config.minPlayers) {
    return { reason: `only ${roster.length} players returned, below the minimum of ${config.minPlayers}`, missingTeams };
  }
  return null;
}

// What loading `fetched` over `existing` would do, row by row. A player listed
// twice in one fetch keeps his first entry.
export function planRosterLoad(
  config: RosterLeagueConfig,
  fetched: RosterPlayer[],
  existing: ExistingRosterRow[],
  opts: { force?: boolean } = {}
): RosterPlan {
  const seen = new Set<string>();
  const roster = fetched.filter((p) => !seen.has(p.externalPlayerId) && seen.add(p.externalPlayerId));

  const counts = countByTeam(config, roster);
  const shortTeams = config.teams.filter((t) => (counts.get(t) ?? 0) < config.minPlayersPerTeam);
  const protectedTeams = new Set(opts.force ? [] : shortTeams);

  const existingById = new Map(existing.map((r) => [r.externalId, r]));
  const adds: NewRosterRow[] = [];
  const updates: RosterPlan["updates"] = [];
  let updated = 0;
  let reactivated = 0;
  let unchanged = 0;
  for (const p of roster) {
    const data = toRowData(p);
    const row = existingById.get(p.externalPlayerId);
    if (!row) adds.push({ externalId: p.externalPlayerId, ...data });
    else if (!row.active) {
      reactivated++;
      updates.push({ id: row.id, data });
    } else if (!sameData(row, data)) {
      updated++;
      updates.push({ id: row.id, data });
    } else unchanged++;
  }

  const deactivateIds: string[] = [];
  let deactivationsSkipped = 0;
  for (const row of existing) {
    if (!row.active || seen.has(row.externalId)) continue;
    if (protectedTeams.has(row.team)) deactivationsSkipped++;
    else deactivateIds.push(row.id);
  }

  return {
    players: roster.length,
    teams: [...counts.values()].filter((n) => n > 0).length,
    added: adds.length,
    updated,
    reactivated,
    unchanged,
    deactivated: deactivateIds.length,
    deactivationsSkipped,
    shortTeams,
    adds,
    updates,
    deactivateIds,
  };
}

export async function runRosterLoad(opts: {
  config: RosterLeagueConfig;
  table: RosterTable;
  commit: boolean;
  force?: boolean;
  // Overrides config.fetchRoster (the MLB script's --season).
  fetchRoster?: () => Promise<RosterPlayer[]>;
  now?: Date;
  log?: (line: string) => void;
}): Promise<RosterLoadResult> {
  const { config, table } = opts;
  const log = opts.log ?? (() => {});
  const roster = await (opts.fetchRoster ?? config.fetchRoster)();
  const teamsReturned = new Set(roster.map((p) => p.team)).size;
  log(`fetched ${roster.length} players across ${teamsReturned} teams`);

  const failure = leagueGuardFailure(config, roster);
  if (failure) {
    log(`ABORT: ${failure.reason} - nothing read or written`);
    return { status: "aborted", reason: failure.reason, players: roster.length, teams: teamsReturned, missingTeams: failure.missingTeams };
  }

  const plan = planRosterLoad(config, roster, await table.readForDiff(), { force: opts.force });
  if (plan.shortTeams.length > 0) {
    log(
      opts.force
        ? `--force: deactivating normally despite short teams (< ${config.minPlayersPerTeam} players): ${plan.shortTeams.join(", ")}`
        : `WARNING: short teams (< ${config.minPlayersPerTeam} players), their deactivations skipped: ${plan.shortTeams.join(", ")}`
    );
  }
  log(`${opts.commit ? "will" : "would"} ${describePlan(plan)}`);

  if (!opts.commit) {
    log("dry run - nothing written. re-run with --commit to persist.");
    return { status: "dry_run", plan };
  }

  if (plan.adds.length > 0) await table.createMany(plan.adds);
  for (const u of plan.updates) await table.updateRow(u.id, u.data);
  if (plan.deactivateIds.length > 0) await table.deactivate(plan.deactivateIds, opts.now ?? new Date());
  log(`done: ${describePlan(plan)}`);
  return { status: "committed", plan };
}

export function describePlan(plan: RosterPlan): string {
  return (
    `add ${plan.added}, update ${plan.updated}, reactivate ${plan.reactivated}, leave ${plan.unchanged} unchanged, ` +
    `deactivate ${plan.deactivated}, skip ${plan.deactivationsSkipped} deactivations (short teams: ${plan.shortTeams.join(", ") || "none"})`
  );
}

// Rows written by a committed run (0 for anything else) - how the cron decides
// whether a cache tag needs revalidating.
export function rowsWritten(result: RosterLoadResult): number {
  if (result.status !== "committed") return 0;
  return result.plan.adds.length + result.plan.updates.length + result.plan.deactivateIds.length;
}
