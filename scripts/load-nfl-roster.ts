// One-time/manual load of the NflRosterPlayer cache table from ESPN's live
// roster endpoint (all 32 teams, QB/RB/WR/TE only - see
// server/data/nfl-roster.ts's extractRosterPlayers). Run with tsx:
//
//   npx tsx scripts/load-nfl-roster.ts
//   npx tsx scripts/load-nfl-roster.ts --commit
//
// Without --commit it's a dry run: fetches the real rosters and prints what
// it would write, touching no database row.
//
// This is the ONLY way the cache table gets (re)populated - there is
// deliberately no cron/scheduled job calling this. An NFL roster changes on
// a trade, cut, or practice-squad move, not on a fixed schedule, and an
// injury doesn't change the roster at all (a backup who's already listed
// simply plays more) - so re-running this by hand whenever the roster looks
// stale is the whole refresh story for this pass. Catalog-import recovery
// (server/data/nfl-roster-cache.ts) only ever reads whatever this script
// last wrote; it never fetches ESPN itself.
import { PrismaClient } from "@prisma/client";
import { fetchNflLeagueRoster } from "@/server/data/nfl-roster";

const prisma = new PrismaClient();
const COMMIT = process.argv.includes("--commit");

async function main() {
  const dbHost = (process.env.DATABASE_URL ?? "").replace(/:[^:@/]+@/, ":***@") || "(DATABASE_URL unset)";
  console.log(`[load-nfl-roster] db=${dbHost}  mode=${COMMIT ? "COMMIT" : "dry-run"}`);

  const roster = await fetchNflLeagueRoster();
  console.log(`[load-nfl-roster] fetched ${roster.length} QB/RB/WR/TE players across the league`);

  if (COMMIT) {
    for (const player of roster) {
      await prisma.nflRosterPlayer.upsert({
        where: { espnPlayerId: player.espnPlayerId },
        update: {
          fullName: player.playerName,
          firstName: player.firstName,
          lastName: player.lastName,
          team: player.team,
          position: player.position,
        },
        create: {
          espnPlayerId: player.espnPlayerId,
          fullName: player.playerName,
          firstName: player.firstName,
          lastName: player.lastName,
          team: player.team,
          position: player.position,
        },
      });
    }
    // Anything cached from a prior load that ESPN no longer lists (cut,
    // retired, moved off a relevant position) shouldn't keep matching -
    // stale rows here are the exact wrong-data risk the roster fallback is
    // built to avoid, so a fresh commit replaces the table's contents
    // rather than only ever adding to it.
    const currentIds = new Set(roster.map((p) => p.espnPlayerId));
    const stale = await prisma.nflRosterPlayer.findMany({ select: { id: true, espnPlayerId: true } });
    const staleIds = stale.filter((s) => !currentIds.has(s.espnPlayerId)).map((s) => s.id);
    if (staleIds.length > 0) {
      await prisma.nflRosterPlayer.deleteMany({ where: { id: { in: staleIds } } });
    }
    console.log(`[load-nfl-roster] upserted ${roster.length} players, removed ${staleIds.length} stale rows`);
  } else {
    console.log("[load-nfl-roster] dry run - nothing written. re-run with --commit to persist.");
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
