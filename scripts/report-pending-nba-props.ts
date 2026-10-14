// READ-ONLY report: every PENDING NBA player-prop pick, and what the next
// grade-picks cron run would do with it now that NBA props have a grader
// (src/server/data/nba-prop-grading.ts). Writes nothing: it reads picks, game
// results and the NBA roster table, and ESPN's public box scores. Run:
//
//   npx tsx scripts/report-pending-nba-props.ts              (uses DATABASE_URL)
//
// Prints the DATABASE_URL host (password masked) first so the target is obvious.
//
// Each pick is matched to its game the way the cron matches it
// (findMatchingGameResult), then graded by the same function the cron calls,
// with the result printed instead of written:
//   WIN / LOSS / PUSH   - will grade on the next run
//   PENDING (reason)    - will stay pending, with the reason the triage view shows
//   NO GAME             - no final GameResult matched yet (game not played / not persisted)
import { PrismaClient } from "@prisma/client";
import { findMatchingGameResult } from "@/server/data/grading";
import { gradeNbaPlayerProp } from "@/server/data/nba-prop-grading";

async function main() {
  const dbHost = (process.env.DATABASE_URL ?? "").replace(/:[^:@/]+@/, ":***@").replace(/\?.*$/, "") || "(DATABASE_URL unset)";
  console.log("Database: " + dbHost + "\n");

  const prisma = new PrismaClient();
  try {
    const picks = await prisma.pick.findMany({
      where: { status: "PENDING", betType: "PLAYER_PROP", sport: { name: "NBA" } },
      select: {
        id: true,
        betDetail: true,
        playerName: true,
        propMarket: true,
        homeTeam: true,
        awayTeam: true,
        gameTime: true,
        gameNumber: true,
        capper: { select: { name: true } },
      },
      orderBy: { gameTime: "asc" },
    });
    console.log(`Pending NBA player-prop picks: ${picks.length}\n`);

    const tally = new Map<string, number>();
    for (const p of picks) {
      const match = await findMatchingGameResult("basketball_nba", p);
      let verdict: string;
      if (!match) {
        verdict = "NO GAME";
      } else {
        const res = await gradeNbaPlayerProp(p, match.game.externalId);
        verdict = res.outcome ?? "PENDING (" + res.reason + ")";
      }
      const bucket = verdict.startsWith("PENDING") ? "PENDING" : verdict;
      tally.set(bucket, (tally.get(bucket) ?? 0) + 1);
      console.log(
        `${p.gameTime.toISOString().slice(0, 10)}  ${(p.propMarket ?? "-").padEnd(24)} ${verdict.padEnd(8)}  "${p.betDetail ?? ""}"  (${p.awayTeam} @ ${p.homeTeam})  capper=${p.capper?.name ?? "?"}  id=${p.id}`
      );
    }
    console.log("\nSummary: " + ([...tally].map(([k, n]) => `${k} ${n}`).join(", ") || "nothing pending"));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
