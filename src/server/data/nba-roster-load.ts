// The logic of scripts/load-nba-roster.ts, kept here (no prisma import - the
// table is passed in) so it is testable without a database or the network:
// what a load would change, the partial-fetch refusal, and that a dry run
// writes nothing.
import type { RosterPlayer } from "@/server/data/nfl-roster";
import { NBA_ESPN_TEAM_IDS } from "@/server/data/nba-roster";

export const NBA_TEAM_COUNT = NBA_ESPN_TEAM_IDS.length;

type RosterRowData = { fullName: string; firstName: string; lastName: string; team: string; position: string };
export type NbaRosterRow = RosterRowData & { id: string; espnPlayerId: string };

// The slice of prisma.nbaRosterPlayer the loader uses.
export type NbaRosterTable = {
  findMany(): Promise<NbaRosterRow[]>;
  upsert(args: { where: { espnPlayerId: string }; update: RosterRowData; create: RosterRowData & { espnPlayerId: string } }): Promise<unknown>;
  deleteMany(args: { where: { id: { in: string[] } } }): Promise<unknown>;
};

export type NbaRosterPlan = {
  players: number;
  teams: number;
  added: number;
  updated: number;
  unchanged: number;
  stale: number;
  staleIds: string[];
};

const toRowData = (p: RosterPlayer): RosterRowData => ({
  fullName: p.playerName,
  firstName: p.firstName,
  lastName: p.lastName,
  team: p.team,
  position: p.position,
});

// What loading `roster` over `existing` would do, row by row. `updated` is a
// row whose name, team or position differs (a trade, a position change);
// `stale` is a cached row for a player no longer on any roster.
export function planNbaRosterLoad(roster: RosterPlayer[], existing: NbaRosterRow[]): NbaRosterPlan {
  const existingById = new Map(existing.map((r) => [r.espnPlayerId, r]));
  const currentIds = new Set(roster.map((p) => p.externalPlayerId));
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const p of roster) {
    const row = existingById.get(p.externalPlayerId);
    if (!row) added++;
    else if (
      row.fullName !== p.playerName ||
      row.firstName !== p.firstName ||
      row.lastName !== p.lastName ||
      row.team !== p.team ||
      row.position !== p.position
    )
      updated++;
    else unchanged++;
  }
  const staleIds = existing.filter((r) => !currentIds.has(r.espnPlayerId)).map((r) => r.id);
  return {
    players: roster.length,
    teams: new Set(roster.map((p) => p.team)).size,
    added,
    updated,
    unchanged,
    stale: staleIds.length,
    staleIds,
  };
}

export type NbaRosterLoadResult =
  // Fewer than 30 teams came back. Nothing was read or written: pruning
  // against a partial fetch would wipe every cached player of a failed team.
  | { status: "refused_partial"; players: number; teams: number; missingTeams: string[] }
  | { status: "dry_run"; plan: NbaRosterPlan }
  | { status: "committed"; plan: NbaRosterPlan };

export async function runNbaRosterLoad(opts: {
  commit: boolean;
  fetchRoster: () => Promise<RosterPlayer[]>;
  table: NbaRosterTable;
  log?: (line: string) => void;
}): Promise<NbaRosterLoadResult> {
  const log = opts.log ?? (() => {});
  const roster = await opts.fetchRoster();
  const teamsReturned = new Set(roster.map((p) => p.team));
  log(`fetched ${roster.length} players across ${teamsReturned.size} teams`);

  if (teamsReturned.size < NBA_TEAM_COUNT) {
    const missingTeams = NBA_ESPN_TEAM_IDS.map(([, team]) => team).filter((team) => !teamsReturned.has(team));
    log(`ABORT: only ${teamsReturned.size}/${NBA_TEAM_COUNT} teams returned players - missing: ${missingTeams.join(", ")}`);
    return { status: "refused_partial", players: roster.length, teams: teamsReturned.size, missingTeams };
  }

  const plan = planNbaRosterLoad(roster, await opts.table.findMany());
  log(`${opts.commit ? "will" : "would"} add ${plan.added}, update ${plan.updated}, leave ${plan.unchanged} unchanged, remove ${plan.stale} stale`);

  if (!opts.commit) {
    log("dry run - nothing written. re-run with --commit to persist.");
    return { status: "dry_run", plan };
  }

  for (const player of roster) {
    const data = toRowData(player);
    await opts.table.upsert({
      where: { espnPlayerId: player.externalPlayerId },
      update: data,
      create: { espnPlayerId: player.externalPlayerId, ...data },
    });
  }
  // Scoped to the exact row ids found stale above - never an unfiltered delete.
  if (plan.staleIds.length > 0) await opts.table.deleteMany({ where: { id: { in: plan.staleIds } } });
  log(`done: added ${plan.added}, updated ${plan.updated}, unchanged ${plan.unchanged}, removed ${plan.stale} stale rows`);
  return { status: "committed", plan };
}
