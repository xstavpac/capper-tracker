// Manual load of the NhlRosterPlayer cache table from ESPN's live roster
// endpoint (all 32 teams, C/LW/RW/D/G - see server/data/nhl-roster.ts). Run:
//
//   npx tsx scripts/load-nhl-roster.ts            (dry run - the default)
//   npx tsx scripts/load-nhl-roster.ts --commit   (writes)
//
// Dry run fetches the real rosters and prints what it would write; it touches
// no database row. Like the NFL loader there is deliberately no cron: rerun by
// hand when rosters move (trades, call-ups). --commit replaces the table's
// contents (stale rows are pruned) because a stale row is the exact wrong-data
// risk the roster fallback is built to avoid. Prints the DATABASE_URL host
// first so a wrong target is obvious before anything is written.
import { PrismaClient } from "@prisma/client";
import { fetchNhlLeagueRoster } from "@/server/data/nhl-roster";

const prisma = new PrismaClient();
const COMMIT = process.argv.includes("--commit");

async function main() {
  const dbHost = (process.env.DATABASE_URL ?? "").replace(/:[^:@/]+@/, ":***@") || "(DATABASE_URL unset)";
  console.log(`[load-nhl-roster] db=${dbHost}  mode=${COMMIT ? "COMMIT" : "dry-run"}`);

  const roster = await fetchNhlLeagueRoster();
  const byTeam = new Map<string, number>();
  for (const p of roster) byTeam.set(p.team, (byTeam.get(p.team) ?? 0) + 1);
  console.log(`[load-nhl-roster] fetched ${roster.length} C/LW/RW/D/G players across ${byTeam.size} teams`);
  if (byTeam.size < 32) console.warn(`[load-nhl-roster] WARNING: only ${byTeam.size}/32 teams returned players`);

  if (!COMMIT) {
    console.log("[load-nhl-roster] dry run - nothing written. re-run with --commit to persist.");
    return;
  }
  // Refuse to prune against a partial fetch: a failed team would otherwise
  // wipe that whole team's cached players.
  if (byTeam.size < 32) {
    console.error("[load-nhl-roster] refusing to commit a partial league fetch");
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
    await prisma.nhlRosterPlayer.upsert({
      where: { espnPlayerId: player.espnPlayerId },
      update: data,
      create: { espnPlayerId: player.espnPlayerId, ...data },
    });
  }
  const currentIds = new Set(roster.map((p) => p.espnPlayerId));
  const existing = await prisma.nhlRosterPlayer.findMany({ select: { id: true, espnPlayerId: true } });
  const staleIds = existing.filter((s) => !currentIds.has(s.espnPlayerId)).map((s) => s.id);
  if (staleIds.length > 0) await prisma.nhlRosterPlayer.deleteMany({ where: { id: { in: staleIds } } });
  console.log(`[load-nhl-roster] upserted ${roster.length} players, removed ${staleIds.length} stale rows`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
