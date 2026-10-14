// The daily roster refresh behind /api/cron/refresh-rosters: one
// roster-load.ts run per pro league with a roster table (NFL / NHL / NBA / MLB),
// each skipped outside its season window (sport-seasons.ts - preseason through
// the playoffs counts as in season). No prisma import - the tables are passed
// in - so the orchestration is testable without a database or the network.
//
// Leagues run in parallel and independently: one league throwing or aborting
// is caught and reported in its own outcome, and never stops the others.
import { isSportInSeason } from "@/lib/sport-seasons";
import { describePlan, rowsWritten, runRosterLoad, type RosterLeague, type RosterLeagueConfig, type RosterLoadResult, type RosterTable } from "@/server/data/roster-load";

export type RosterRefreshOutcome =
  | { league: RosterLeague; status: "skipped-offseason" }
  | { league: RosterLeague; status: "failed"; error: string; ms: number }
  | { league: RosterLeague; status: "aborted" | "committed"; result: RosterLoadResult; rowsWritten: number; ms: number };

export async function refreshRosters(opts: {
  leagues: RosterLeagueConfig[];
  tableFor: (league: RosterLeague) => RosterTable;
  now?: Date;
}): Promise<RosterRefreshOutcome[]> {
  const now = opts.now ?? new Date();
  return Promise.all(
    opts.leagues.map(async (config): Promise<RosterRefreshOutcome> => {
      if (!isSportInSeason(config.sportKey, now)) return { league: config.league, status: "skipped-offseason" };
      const start = Date.now();
      try {
        const result = await runRosterLoad({ config, table: opts.tableFor(config.league), commit: true, now });
        // commit: true never yields a dry run.
        const status = result.status === "aborted" ? "aborted" : "committed";
        return { league: config.league, status, result, rowsWritten: rowsWritten(result), ms: Date.now() - start };
      } catch (err) {
        return { league: config.league, status: "failed", error: err instanceof Error ? err.message : String(err), ms: Date.now() - start };
      }
    })
  );
}

// The one summary line per league per run.
export function rosterRefreshSummary(o: RosterRefreshOutcome): string {
  const tag = `[refresh-rosters] ${o.league}`;
  switch (o.status) {
    case "skipped-offseason":
      return `${tag} skipped-offseason`;
    case "failed":
      return `${tag} failed after ${o.ms}ms: ${o.error}`;
    case "aborted":
      return `${tag} aborted after ${o.ms}ms (nothing written): ${o.result.status === "aborted" ? o.result.reason : ""}`;
    case "committed":
      return `${tag} committed in ${o.ms}ms: ${o.result.status === "committed" ? describePlan(o.result.plan) : ""}; ${o.rowsWritten} rows written`;
  }
}

// Fails closed: no CRON_SECRET configured means no request is authorized.
export function isAuthorizedCronRequest(authorizationHeader: string | null, cronSecret: string | undefined): boolean {
  if (!cronSecret) return false;
  return authorizationHeader === "Bearer " + cronSecret;
}
