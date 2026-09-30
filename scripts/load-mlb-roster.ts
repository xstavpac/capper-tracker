// Manual load of the MlbRosterPlayer cache table from the MLB Stats API's 40-man rosters (all 30
// teams, every position - see server/data/mlb-roster.ts). Run:
//
//   npx tsx scripts/load-mlb-roster.ts                      (dry run - the default)
//   npx tsx scripts/load-mlb-roster.ts --commit             (writes)
//   npx tsx scripts/load-mlb-roster.ts --season=2027        (roster year; default = current year)
//
// Dry run fetches the real rosters and prints what it would write; it touches no database row. Like
// the NFL/NHL loaders there is deliberately no cron: rerun by hand when rosters move (trades,
// call-ups) - and ALWAYS at opening day, since the offseason reshuffles the 40-man. --commit replaces
// the table's contents (stale rows are pruned) because a stale row is the exact wrong-data risk the
// roster fallback is built to avoid. Prints the DATABASE_URL host first so a wrong target is obvious
// before anything is written.
import { PrismaClient } from "@prisma/client";
import { fetchMlbLeagueRoster } from "@/server/data/mlb-roster";

const prisma = new PrismaClient();
const COMMIT = process.argv.includes("--commit");
const seasonArg = process.argv.find((a) => a.startsWith("--season="));
const SEASON = seasonArg ? parseInt(seasonArg.slice("--season=".length), 10) : new Date().getFullYear();

async function main() {
  if (!Number.isInteger(SEASON) || SEASON < 2000) throw new Error("bad --season value");
  const dbHost = (process.env.DATABASE_URL ?? "").replace(/:[^:@/]+@/, ":***@") || "(DATABASE_URL unset)";
  console.log(`[load-mlb-roster] db=${dbHost}  season=${SEASON}  mode=${COMMIT ? "COMMIT" : "dry-run"}`);

  const roster = await fetchMlbLeagueRoster(SEASON);
  const byTeam = new Map<string, number>();
  for (const p of roster) byTeam.set(p.team, (byTeam.get(p.team) ?? 0) + 1);
  console.log(`[load-mlb-roster] fetched ${roster.length} players across ${byTeam.size} teams`);
  if (byTeam.size < 30) console.warn(`[load-mlb-roster] WARNING: only ${byTeam.size}/30 teams returned players`);

  if (!COMMIT) {
    console.log("[load-mlb-roster] dry run - nothing written. re-run with --commit to persist.");
    return;
  }
  // Refuse to prune against a partial fetch: a failed team would otherwise wipe that whole team's
  // cached players.
  if (byTeam.size < 30) {
    console.error("[load-mlb-roster] refusing to commit a partial league fetch");
    process.exit(1);
  }
  for (const player of roster) {
    const data = {
      fullName: player.playerName,
      firstName: player.firstName,
      lastName: player.lastName,
      team: player.team,
      position: player.position,
    };
    await prisma.mlbRosterPlayer.upsert({
      where: { mlbPlayerId: player.externalPlayerId },
      update: data,
      create: { mlbPlayerId: player.externalPlayerId, ...data },
    });
  }
  const currentIds = new Set(roster.map((p) => p.externalPlayerId));
  const existing = await prisma.mlbRosterPlayer.findMany({ select: { id: true, mlbPlayerId: true } });
  const staleIds = existing.filter((s) => !currentIds.has(s.mlbPlayerId)).map((s) => s.id);
  if (staleIds.length > 0) await prisma.mlbRosterPlayer.deleteMany({ where: { id: { in: staleIds } } });
  console.log(`[load-mlb-roster] upserted ${roster.length} players, removed ${staleIds.length} stale rows`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
