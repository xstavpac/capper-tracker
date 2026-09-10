// Read-only diagnostic. Reports how much preseason data is currently baked
// into a sport's TeamTendency / TeamTendencySnapshot counts - the number the
// no-silent-historical-corrections rule says to surface before deciding
// whether to wipe and rebuild.
//
//   npx tsx scripts/report-preseason-tendency-contamination.ts americanfootball_nfl
//
// Writes nothing. It re-runs the SAME join recomputeTeamTendencies uses
// (findOddsGameForResult), once counting every game and once excluding games
// that fall in the sport's configured preseason window, and diffs the two.
import { PrismaClient } from "@prisma/client";
import { findOddsGameForResult } from "@/server/data/team-tendencies";
import { isPreseasonGame } from "@/lib/sport-seasons";
import type { OddsGame } from "@/server/data/odds";

const sportKey = process.argv[2];
if (!sportKey) {
  console.error("usage: tsx scripts/report-preseason-tendency-contamination.ts <sportKey>");
  process.exit(1);
}

const prisma = new PrismaClient();

async function main() {
  const dbHost = (process.env.DATABASE_URL ?? "").replace(/:[^:@/]+@/, ":***@") || "(DATABASE_URL unset)";
  console.log(`[contamination] db=${dbHost}  sport=${sportKey}`);

  const [games, snapshots] = await Promise.all([
    prisma.gameResult.findMany({
      where: { sportKey },
      select: { homeTeam: true, awayTeam: true, gameDate: true, isPreseason: true },
    }),
    prisma.oddsSnapshot.findMany({ where: { sportKey }, select: { data: true } }),
  ]);
  const oddsGames: OddsGame[] = snapshots.flatMap((s) => s.data as unknown as OddsGame[]);

  const inWindow = games.filter((g) => isPreseasonGame(sportKey, g.gameDate));
  const flaggedTrue = games.filter((g) => g.isPreseason);
  // Contaminating = falls in the preseason window, is NOT yet flagged, AND
  // matched an odds game (so it actually reached the accumulation loop).
  const contaminating = inWindow.filter(
    (g) => !g.isPreseason && findOddsGameForResult(oddsGames, g) !== null
  );

  const perTeam = new Map<string, number>();
  for (const g of contaminating) {
    perTeam.set(g.homeTeam, (perTeam.get(g.homeTeam) ?? 0) + 1);
    perTeam.set(g.awayTeam, (perTeam.get(g.awayTeam) ?? 0) + 1);
  }

  console.log(`  GameResult rows for ${sportKey}:            ${games.length}`);
  console.log(`  ...in the configured preseason window:       ${inWindow.length}`);
  console.log(`  ...already flagged isPreseason=true:         ${flaggedTrue.length}`);
  console.log(`  ...contaminating tendency counts NOW:        ${contaminating.length}`);
  console.log(`     (in-window, not flagged, matched odds)`);
  console.log(`  teams with contaminated counts:              ${perTeam.size}`);
  if (perTeam.size > 0) {
    console.log(`\n  preseason games baked into each team's record:`);
    for (const [team, n] of [...perTeam.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      console.log(`    ${team.padEnd(28)} ${n}`);
    }
  }
  console.log(
    `\n  Rebuilding clean would set isPreseason=true on the ${contaminating.length} row(s) above` +
      ` (plus any in-window rows that never matched odds), then recomputeTeamTendencies drops them on its next run.`
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
