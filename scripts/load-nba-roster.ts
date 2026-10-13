// Manual load of the NbaRosterPlayer cache table from ESPN's live roster
// endpoint (all 30 teams, every position - see server/data/nba-roster.ts). Run:
//
//   npx tsx scripts/load-nba-roster.ts            (dry run - the default)
//   npx tsx scripts/load-nba-roster.ts --commit   (writes)
//
// Dry run fetches the real rosters, reads the table, and prints what it would
// add / update / remove; it writes nothing. Like the NFL and NHL loaders there
// is deliberately no cron: rerun by hand when rosters move (trades, signings,
// the cut-down to regular-season rosters before opening night). --commit
// upserts every fetched player and removes the rows for players no longer on
// any roster, because a stale row is the exact wrong-data risk the roster
// fallback is built to avoid. If fewer than 30 teams come back it aborts in
// either mode, before reading or writing anything, and exits 1. Prints the
// DATABASE_URL host first so a wrong target is obvious before anything is
// written.
import { PrismaClient } from "@prisma/client";
import { fetchNbaLeagueRoster } from "@/server/data/nba-roster";
import { runNbaRosterLoad } from "@/server/data/nba-roster-load";

const prisma = new PrismaClient();
const COMMIT = process.argv.includes("--commit");

async function main() {
  const dbHost = (process.env.DATABASE_URL ?? "").replace(/:[^:@/]+@/, ":***@") || "(DATABASE_URL unset)";
  console.log(`[load-nba-roster] db=${dbHost}  mode=${COMMIT ? "COMMIT" : "dry-run"}`);

  const result = await runNbaRosterLoad({
    commit: COMMIT,
    fetchRoster: fetchNbaLeagueRoster,
    table: prisma.nbaRosterPlayer,
    log: (line) => console.log(`[load-nba-roster] ${line}`),
  });
  if (result.status === "refused_partial") process.exitCode = 1;
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
