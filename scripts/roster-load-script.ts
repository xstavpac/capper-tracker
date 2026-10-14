// Shared body of scripts/load-{nfl,nhl,nba,mlb}-roster.ts - the manual path
// onto the same loader the daily /api/cron/refresh-rosters job runs
// (src/server/data/roster-load.ts). Flags:
//
//   (none)     dry run: fetches the real rosters, reads the table, prints what
//              it would add / update / reactivate / deactivate. Writes nothing.
//   --commit   writes: adds, updates and reactivations, and marks players no
//              longer on any roster inactive (active = false + removedAt).
//              Rows are never deleted.
//   --force    deactivate on teams that came back short too (below the league's
//              per-team minimum - see roster-leagues.ts). The league-level
//              abort - too few teams or players - is never overridden.
//
// Prints the DATABASE_URL host first so a wrong target is obvious before
// anything is written. Exits 1 when the league aborts.
import type { RosterPlayer } from "@/server/data/nfl-roster";
import type { RosterLeague } from "@/server/data/roster-load";
import { runRosterLoad } from "@/server/data/roster-load";
import { ROSTER_LEAGUES } from "@/server/data/roster-leagues";
import { rosterTableFor } from "@/server/data/roster-tables";
import { prisma } from "@/lib/prisma";

export async function runRosterLoadScript(league: RosterLeague, opts: { fetchRoster?: () => Promise<RosterPlayer[]>; extraHeader?: string } = {}) {
  const tag = `[load-${league.toLowerCase()}-roster]`;
  const commit = process.argv.includes("--commit");
  const force = process.argv.includes("--force");
  const dbHost = (process.env.DATABASE_URL ?? "").replace(/:[^:@/]+@/, ":***@") || "(DATABASE_URL unset)";
  console.log(`${tag} db=${dbHost}  ${opts.extraHeader ? opts.extraHeader + "  " : ""}mode=${commit ? "COMMIT" : "dry-run"}${force ? " --force" : ""}`);

  try {
    const result = await runRosterLoad({
      config: ROSTER_LEAGUES[league],
      table: rosterTableFor(league),
      commit,
      force,
      fetchRoster: opts.fetchRoster,
      log: (line) => console.log(`${tag} ${line}`),
    });
    if (result.status === "aborted") process.exitCode = 1;
    if (league === "NFL" && result.status === "committed") {
      console.log(`${tag} the bulk-import name list (nfl-roster-full-names cache tag) picks this up within its 1-hour TTL`);
    }
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
