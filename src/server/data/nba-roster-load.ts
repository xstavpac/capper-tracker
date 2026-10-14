// NBA entry points onto the shared roster loader (roster-load.ts), kept so
// scripts/load-nba-roster.ts and its tests keep their names. All the logic -
// the league guard, soft delete, the per-team guard, writing only changes -
// lives in roster-load.ts and is the same for NFL / NHL / NBA / MLB.
import type { RosterPlayer } from "@/server/data/nfl-roster";
import { NBA_ESPN_TEAM_IDS } from "@/server/data/nba-roster";
import { ROSTER_LEAGUES } from "@/server/data/roster-leagues";
import { planRosterLoad, runRosterLoad, type ExistingRosterRow, type RosterLoadResult, type RosterPlan, type RosterTable } from "@/server/data/roster-load";

export const NBA_TEAM_COUNT = NBA_ESPN_TEAM_IDS.length;

export type NbaRosterRow = ExistingRosterRow;
export type NbaRosterTable = RosterTable;
export type NbaRosterPlan = RosterPlan;
export type NbaRosterLoadResult = RosterLoadResult;

export function planNbaRosterLoad(roster: RosterPlayer[], existing: NbaRosterRow[], opts: { force?: boolean } = {}): NbaRosterPlan {
  return planRosterLoad(ROSTER_LEAGUES.NBA, roster, existing, opts);
}

export function runNbaRosterLoad(opts: {
  commit: boolean;
  force?: boolean;
  fetchRoster: () => Promise<RosterPlayer[]>;
  table: NbaRosterTable;
  now?: Date;
  log?: (line: string) => void;
}): Promise<NbaRosterLoadResult> {
  return runRosterLoad({ config: ROSTER_LEAGUES.NBA, ...opts });
}
